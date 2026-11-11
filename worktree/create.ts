import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Inputs, Plan } from "../inputs";
import { exists } from "./fs";
import { checkoutRoot, FetchError, repo, stderr, type Repo } from "./git";
import { provision } from "./provision";
import { assertSameLaunch, receipts, type Receipt } from "./receipts";
import { localBranch, remoteLabel } from "./refs";

export type CreateArgs = { plan: Plan; inputs: Inputs; pathKey: string; initSubmodules: boolean; restore?: boolean };
type Launch = CreateArgs & { r: Repo; store: ReturnType<typeof receipts>; receipt: Receipt };

/**
 * Carry out a plan. Idempotent per pathKey: a retry resumes the worktree its first attempt created.
 * `restore` only resumes that worktree; it never creates one, since a missing worktree was removed outside BB.
 */
export async function create({ plan: p, inputs, pathKey, initSubmodules, restore }: CreateArgs, dataDir: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (p.action === "attach") return { path: await checkoutRoot(p.path, signal), log: [] as string[] };
  if (!p.path) throw new Error("Destination is unresolved");
  const store = receipts(dataDir, pathKey);
  const recorded = await store.read();
  if (recorded) assertSameLaunch(recorded, inputs, p);
  else if (restore) throw new Error("This thread has no worktree on record to restore. Nothing was changed; start a new thread instead.");
  const launch: Launch = { plan: p, inputs, pathKey, initSubmodules, r: repo(p.source, signal), store, receipt: recorded ?? { inputs, plan: p, provisioned: false } };
  if (await exists(p.path)) {
    if (!recorded) throw new Error("Destination already exists. Pick it under Worktrees to attach it; nothing was overwritten.");
    return { path: p.path, log: await resume(launch) };
  }
  if (restore) throw new Error(`\`${p.path}\` no longer exists, so there's nothing to restore. Nothing was changed; start a new thread instead.`);
  const { log, fastForwardTo, start } = await prepare(launch);
  if (!recorded) await store.write(launch.receipt, true);
  await checkout(launch, start);
  // Fast-forward only after this worktree has checked the branch out, so Git refuses it elsewhere meanwhile.
  if (fastForwardTo) log.push(await fastForward(p.path, p.branch, fastForwardTo, signal));
  log.push(...await finish(launch));
  return { path: p.path, log };
}

/** A retry or rebuild of a launch whose worktree already exists. */
async function resume(launch: Launch) {
  const { plan: p, r, receipt } = launch;
  await assertOwned(p, r);
  // A rebuild or retry of a finished launch must not re-run provisioning over the agent's work.
  if (receipt.provisioned) return [];
  // Interrupted after checkout: finish the fast-forward (a no-op when already done), then provisioning.
  const resumed = p.fastForward && await r.refExists(p.fastForward.upstream) ? [await fastForward(p.path, p.branch, p.fastForward.upstream, r.signal)] : [];
  return [...resumed, ...await finish(launch)];
}

/**
 * The directory must still be the worktree this launch created: registered for this path and branch,
 * in the same repository, with the same canonical root (no symlink swap) and checked-out branch.
 */
async function assertOwned(p: Plan, r: Repo) {
  const registered = (await r.worktrees()).some(w => resolve(w.path) === p.path && w.branch === (p.branch || "(detached)"));
  const dest = repo(p.path, r.signal);
  // The destination may no longer be a checkout at all; that's a mismatch, not an error.
  const common = await dest.commonDir().catch(() => { r.signal?.throwIfAborted(); return null; });
  const [sourceCommon, branch] = await Promise.all([r.commonDir(), dest.currentBranch()]);
  if (!registered || !common || common !== sourceCommon || await checkoutRoot(p.path, r.signal) !== p.path || branch !== p.branch) {
    throw new Error("Reserved destination no longer matches its worktree. Nothing was changed.");
  }
}

/** Fetches, race checks, and the resolved start point, before anything is written. */
async function prepare({ plan: p, r }: Launch) {
  const log: string[] = [];
  let fastForwardTo: string | undefined;
  if (p.fetch) {
    try { await r.fetch(p.fetch); } catch (error) {
      // A stale base is still a valid starting point for a new branch; anything else needs the fresh ref.
      if (p.action !== "new-branch" || !(error instanceof FetchError) || !await r.refExists(p.fetch.into)) throw error;
      log.push(`${error.summary}; starting from the last fetched \`${p.startLabel}\`.`);
    }
  }
  if (p.action !== "local-branch" && p.branch && await localBranch(r, p.branch)) {
    throw new Error(`Local branch \`${p.branch}\` was created after you chose it. Pick it from Branches instead; nothing was changed.`);
  }
  if (p.action === "local-branch") {
    const holder = (await r.worktrees()).find(w => w.branch === p.branch);
    if (holder) throw new Error(`\`${p.branch}\` was checked out in \`${holder.path}\` after you chose it. Pick it again to attach.`);
    if (p.fastForward) {
      try { await r.fetch(p.fastForward.fetch); fastForwardTo = p.fastForward.upstream; } catch (error) {
        if (!(error instanceof FetchError)) throw error;
        log.push(`${error.summary}; using local \`${p.branch}\` as-is.`);
      }
    }
  }
  const start = p.action === "detached" ? await r.oid(p.start) : p.start;
  return { log, fastForwardTo, start };
}

async function checkout({ plan: p, r }: Launch, start: string) {
  await mkdir(dirname(p.path), { recursive: true });
  // Refuse even an empty destination created since the initial check.
  if (await exists(p.path)) throw new Error("Destination appeared during creation; refusing to overwrite it");
  await r.run({
    "new-branch": ["worktree", "add", "--no-track", "-b", p.branch, "--", p.path, start],
    "track-remote": ["worktree", "add", "--track", "-b", p.branch, "--", p.path, start],
    // Passing a full ref detaches HEAD, so check out the validated short name.
    "local-branch": ["worktree", "add", "--", p.path, p.branch],
    detached: ["worktree", "add", "--detach", "--", p.path, start],
  }[p.action as Exclude<Plan["action"], "attach">]);
}

/** Provision once, then record it so retries and rebuilds never repeat it. */
async function finish({ plan: p, initSubmodules, store, receipt, r }: Launch) {
  const log = await provision(p.source, p.path, { initSubmodules }, r.signal);
  await store.write({ ...receipt, provisioned: true }, false);
  return log;
}

/** Fast-forward the branch checked out in this fresh worktree; anything but a pure fast-forward leaves it as-is. */
async function fastForward(path: string, branch: string, upstream: string, signal?: AbortSignal) {
  const wt = repo(path, signal);
  const label = remoteLabel(upstream);
  const target = await wt.oid(upstream);
  if (await wt.attempt(["merge-base", "--is-ancestor", "HEAD", target]) === null) return `\`${branch}\` diverged from \`${label}\`; not fast-forwarded.`;
  if (target === await wt.run(["rev-parse", "HEAD"])) return `\`${branch}\` is up to date with \`${label}\`.`;
  try { await wt.run(["merge", "--ff-only", "--quiet", target]); } catch (error) {
    signal?.throwIfAborted();
    return `Couldn’t fast-forward \`${branch}\` (${stderr(error) || "unknown error"}); using it as-is.`;
  }
  return `Fast-forwarded \`${branch}\` to \`${label}\`.`;
}
