import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { hostContract } from "./contract";
import { inputsSchema } from "./inputs";
import { statusTag, type StatusRow } from "./status";

const PROVIDER_ID = "flexible-worktrees";
/** App reads answer from the cache and refresh it in the background once it is this old. */
const STALE_MS = 15_000;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** How long a watched row waits before it is re-read: quickly while GitHub is still settling something. */
export function pollDelay(row: StatusRow) {
  if (row.outcome !== "available") return 60_000;
  const pr = row.pullRequest;
  if (pr.state === "merged" || pr.state === "closed") return 300_000;
  return pr.checks.state === "pending" || pr.mergeable === "unknown" || pr.autoMerge || pr.inMergeQueue ? 20_000 : 60_000;
}
const same = (a: StatusRow, b: StatusRow) => JSON.stringify({ ...a, fetchedAt: 0 }) === JSON.stringify({ ...b, fetchedAt: 0 });

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Pull request status for the bar above the composer, keyed by environment id. Reads are cached per environment;
 * while a client shows a row, it is re-read on GitHub at `pollDelay` and clients refresh only when it changes.
 */
export function registerPrStatus(bb: BbPluginApi, host: ExperimentalHostClient<typeof hostContract>) {
  const cache = new Map<string, { row: StatusRow; at: number }>();
  const inflight = new Map<string, Promise<StatusRow>>();

  async function read(environmentId: string): Promise<StatusRow> {
    const fetchedAt = Date.now();
    let env: Awaited<ReturnType<typeof bb.sdk.environments.get>>;
    try { env = await bb.sdk.environments.get({ environmentId }); } catch {
      return { outcome: "absent", fetchedAt };
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

  /** Re-read one row; concurrent callers share the read. Clients refresh only when the row changed. */
  function refresh(environmentId: string) {
    const running = inflight.get(environmentId);
    if (running) return running;
    const next = read(environmentId).then(row => {
      const previous = cache.get(environmentId);
      cache.set(environmentId, { row, at: Date.now() });
      if (previous && !same(previous.row, row)) bb.rpc.experimental_invalidate([statusTag(environmentId)]);
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

  return {
    handlers: {
      async pullRequestStatus({ keys }: { keys: string[] }) {
        return Object.fromEntries(await Promise.all([...new Set(keys)].map(async key => [key, await get(key)] as const)));
      },
      async refreshPullRequestStatus({ environmentId }: { environmentId: string }) {
        await refresh(environmentId);
        return { ok: true as const };
      },
    },
    /** Call after registering the RPC contract. */
    watch() {
      bb.rpc.experimental_whileWatched("pullRequestStatus", async (watched, signal) => {
        if (!("key" in watched)) return;
        const id = watched.key;
        while (!signal.aborted) {
          const cached = cache.get(id);
          await sleep(cached ? Math.max(0, cached.at + pollDelay(cached.row) - Date.now()) : 1_000, signal);
          if (signal.aborted) break;
          await refresh(id).catch(error => bb.log.warn(`PR status refresh failed: ${message(error)}`));
        }
      });
    },
  };
}
