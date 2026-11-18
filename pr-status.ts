import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { hostContract } from "./contract";
import { inputsSchema } from "./inputs";
import { statusTag, type StatusRow } from "./status";

const PROVIDER_ID = "flexible-worktrees";
/** App reads answer from the cache and refresh it in the background once it is this old. */
const STALE_MS = 15_000;
/** Rows nobody watches are dropped after this long, so destroyed environments don't linger. */
const EVICT_MS = 3_600_000;
/** Host reads (each runs gh) one keyed request may start at once. */
const CONCURRENCY = 4;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** How long a watched row waits before it is re-read: quickly while GitHub is still settling something. */
export function pollDelay(row: StatusRow) {
  if (row.outcome !== "available" || row.refreshError) return 60_000;
  const pr = row.pullRequest;
  if (pr.state === "merged" || pr.state === "closed") return 300_000;
  return pr.checks.state === "pending" || pr.mergeable === "unknown" || pr.autoMerge || pr.inMergeQueue ? 20_000 : 60_000;
}
const same = (a: StatusRow, b: StatusRow) => JSON.stringify({ ...a, fetchedAt: 0 }) === JSON.stringify({ ...b, fetchedAt: 0 });

/** Resolve after `ms`, or as soon as `signal` aborts; either way the timer and listener are released. */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/** Run `fn` over `items` with at most `limit` running at once, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]!); }
  }));
  return results;
}

/**
 * Pull request status for the bar above the composer, keyed by environment id. Reads are cached per environment;
 * while a client shows a row, it is re-read on GitHub at `pollDelay` and clients refresh only when it changes.
 */
export function registerPrStatus(bb: BbPluginApi, host: ExperimentalHostClient<typeof hostContract>) {
  const cache = new Map<string, { row: StatusRow; at: number }>();
  const inflight = new Map<string, Promise<StatusRow>>();
  const watched = new Map<string, number>();

  async function read(environmentId: string): Promise<StatusRow> {
    const fetchedAt = Date.now();
    let env: Awaited<ReturnType<typeof bb.sdk.environments.get>>;
    try { env = await bb.sdk.environments.get({ environmentId }); } catch (error) {
      return { outcome: "unavailable", message: `Couldn’t read this environment: ${message(error)}`, fetchedAt };
    }
    if (!env.path || !env.isGitRepo || env.status === "destroyed" || env.lifecycle.phase === "destroyed" || env.hostLifecycle !== "active") {
      return { outcome: "absent", fetchedAt };
    }
    // An environment created for a PR keeps showing it while HEAD is detached, even after new local commits.
    const inputs = env.environmentProviderId === PROVIDER_ID ? inputsSchema.safeParse(env.environmentProviderSelection?.inputs) : undefined;
    const pr = inputs?.success && inputs.data.target === "pr" ? { number: inputs.data.number, ...(inputs.data.remote ? { remote: inputs.data.remote } : {}) } : undefined;
    try {
      return await host.call("prStatus", { path: env.path, ...(pr ? { pr } : {}) }, { hostId: env.hostId, timeoutMs: 60_000 });
    } catch (error) {
      return { outcome: "unavailable", message: `Couldn’t reach this environment’s machine: ${message(error)}`, fetchedAt };
    }
  }

  /**
   * Re-read one row; concurrent callers share the read. A failed read keeps the last PR shown, marked with the error,
   * so a timeout or rate limit doesn't hide the bar. Clients refresh only when the row changed.
   */
  function refresh(environmentId: string) {
    const running = inflight.get(environmentId);
    if (running) return running;
    const next = read(environmentId).then(fresh => {
      const previous = cache.get(environmentId);
      const row: StatusRow = fresh.outcome === "unavailable" && previous?.row.outcome === "available"
        ? { ...previous.row, refreshError: fresh.message }
        : fresh;
      cache.set(environmentId, { row, at: Date.now() });
      if (previous && !same(previous.row, row)) bb.rpc.experimental_invalidate?.([statusTag(environmentId)]);
      return row;
    }).finally(() => inflight.delete(environmentId));
    inflight.set(environmentId, next);
    return next;
  }

  async function get(environmentId: string) {
    const cached = cache.get(environmentId);
    if (!cached) return refresh(environmentId);
    if (Date.now() - cached.at > STALE_MS) void refresh(environmentId).catch(error => bb.log.warn(`PR status refresh failed: ${message(error)}`));
    return cached.row;
  }

  function evict() {
    const cutoff = Date.now() - EVICT_MS;
    for (const [id, entry] of cache) if (entry.at < cutoff && !watched.has(id) && !inflight.has(id)) cache.delete(id);
  }

  return {
    handlers: {
      async pullRequestStatus({ keys }: { keys: string[] }) {
        evict();
        const unique = [...new Set(keys)];
        return Object.fromEntries(await mapLimit(unique, CONCURRENCY, async key => [key, await get(key)] as const));
      },
      async refreshPullRequestStatus({ environmentId }: { environmentId: string }) {
        await refresh(environmentId);
        return { ok: true as const };
      },
    },
    /**
     * Call after registering the RPC contract. BB versions without watched reads skip polling (reads still refresh
     * stale rows), so the plugin, and its environment provider, keep loading there.
     */
    watch() {
      if (typeof bb.rpc.experimental_whileWatched !== "function") return;
      bb.rpc.experimental_whileWatched("pullRequestStatus", async (read, signal) => {
        if (!("key" in read)) return;
        const id = read.key;
        watched.set(id, (watched.get(id) ?? 0) + 1);
        try {
          while (!signal.aborted) {
            const cached = cache.get(id);
            await sleep(cached ? Math.max(0, cached.at + pollDelay(cached.row) - Date.now()) : 1_000, signal);
            if (signal.aborted) break;
            await refresh(id).catch(error => bb.log.warn(`PR status refresh failed: ${message(error)}`));
          }
        } finally {
          const count = (watched.get(id) ?? 1) - 1;
          if (count > 0) watched.set(id, count); else watched.delete(id);
        }
      });
    },
  };
}
