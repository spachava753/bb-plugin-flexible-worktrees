import { basename, dirname, join } from "node:path";
import { slug, type Inputs, type Plan, type PlanResult } from "../inputs";
import { canonical, exists, expand } from "./fs";
import { checkoutRoot, repo, type Fetch, type Repo } from "./git";
import { pullBase, pullDetails, remoteRepo } from "./github";
import { assertSameLaunch, receipts } from "./receipts";
import { branchLabel, fetchOf, heads, localBranch, remoteLabel, splitRemoteRef, trackedUpstream, trackingRef, type RemoteBranch } from "./refs";

export type PlanArgs = { source: string; inputs: Inputs; defaultRoot: string; pathKey?: string; suggestedBranch?: string; dataDir?: string };

/** Everything the per-target planners share. Planners add warnings here and never write refs, config, or files. */
type Ctx = {
  r: Repo;
  remotes: string[];
  /** The requested remote, else origin, else the only remote. */
  remote?: string;
  warnings: string[];
  /** Destination for a folder named after `hint`; empty when the name is only known at launch. */
  destination(hint: string): Promise<string>;
  defaultLabel(): Promise<string>;
};

/**
 * Resolve inputs into one concrete plan, for the picker preview, validate(), and create().
 * Reads local state and may query remotes (ls-remote, gh), but never writes refs, config, or files.
 */
export async function plan(args: PlanArgs, signal?: AbortSignal): Promise<PlanResult> {
  const { inputs } = args;
  const source = await checkoutRoot(args.source, signal);
  if (args.pathKey && args.dataDir) {
    // Retries must reuse the first attempt's plan; re-planning could choose a different folder.
    const recorded = await receipts(args.dataDir, args.pathKey).read();
    if (recorded) {
      assertSameLaunch(recorded, inputs);
      return { plan: recorded.plan, warnings: [] };
    }
  }
  if (inputs.target === "path") {
    return { plan: { action: "attach", source, path: await checkoutRoot(inputs.path, signal), branch: "", start: "", startLabel: "" }, warnings: [] };
  }
  const ctx = await context(repo(source, signal), inputs, args.defaultRoot);
  const p = inputs.target === "new" ? await planNew(ctx, inputs.branch || args.suggestedBranch || "", inputs.base, args.pathKey)
    : inputs.target === "branch" ? await planBranch(ctx, inputs.branch, { remote: inputs.remote, localName: inputs.localName, fastForward: inputs.fastForward })
    : await planPull(ctx, inputs.number, inputs.checkout, inputs.remote);
  return { plan: p, warnings: ctx.warnings };
}

async function context(r: Repo, inputs: Exclude<Inputs, { target: "path" }>, defaultRoot: string): Promise<Ctx> {
  const remotes = await r.remotes();
  if (inputs.remote && (inputs.remote.startsWith("-") || !remotes.includes(inputs.remote))) throw new Error(`\`${inputs.remote}\` isn't a configured Git remote`);
  const remote = inputs.remote || defaultRemote(remotes);
  // Use the primary checkout's name even when the source is itself a linked worktree.
  const root = expand((inputs.location?.root || defaultRoot).replaceAll("{repo}", basename(dirname(await r.commonDir()))));
  const folder = inputs.location?.folder;
  return {
    r, remotes, remote, warnings: [],
    async destination(hint) {
      if (folder) {
        const path = await canonical(join(root, folder));
        if (await exists(path)) throw new Error(`\`${path}\` already exists. Choose another folder, or pick it under Worktrees to attach it.`);
        return path;
      }
      if (!hint) return "";
      for (let n = 1; n < 100; n++) {
        const path = await canonical(join(root, n === 1 ? slug(hint) : `${slug(hint)}-${n}`));
        if (!await exists(path)) return path;
      }
      throw new Error("Too many folders with this name; choose a folder name");
    },
    defaultLabel: async () => (await defaultBase(r, remote)).label,
  };
}
export const defaultRemote = (remotes: string[]) => remotes.includes("origin") ? "origin" : remotes[0];

async function checkBranchName(r: Repo, branch: string) {
  if (!branch || branch.startsWith("-") || branch === "HEAD" || !await r.validRef(heads(branch))) throw new Error(`\`${branch}\` isn't a valid branch name`);
}

/** A start point. `diffBase` replaces `label` as BB's diff base when the label is a relative expression such as HEAD~1. */
type Base = { start: string; label: string; diffBase?: string; fetch?: Fetch; warning?: string };
const remoteBase = (rb: RemoteBranch): Base => ({ start: trackingRef(rb), label: branchLabel(rb), fetch: fetchOf(rb) });

/**
 * The remote's default branch, else the local default branch (only for repositories without a remote).
 * With `network`, a remote whose default branch was never fetched is asked with ls-remote; otherwise
 * that case falls back to the local default, as the instant picker listing does.
 */
export async function defaultBase(r: Repo, remote: string | undefined, network = false): Promise<Base> {
  if (remote) {
    const head = await r.attempt(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
    for (const ref of [head, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`]) {
      if (ref && await r.refExists(ref)) return remoteBase({ remote, branch: ref.slice(`refs/remotes/${remote}/`.length) });
    }
    if (network) {
      const raw = await r.attempt(["ls-remote", "--symref", "--", remote, "HEAD"]);
      const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(raw ?? "")?.[1];
      if (branch) return remoteBase({ remote, branch });
      const local = await defaultBase(r, undefined);
      return { ...local, warning: `Couldn’t find \`${remote}\`'s default branch${raw === null ? " (remote unreachable)" : ""}; starting from local \`${local.label}\`.` };
    }
  }
  for (const branch of ["main", "master"]) {
    if (await r.refExists(heads(branch))) return { start: heads(branch), label: branch };
  }
  const current = await r.currentBranch();
  return current ? { start: heads(current), label: current } : { start: "HEAD", label: "HEAD" };
}

async function resolveBase({ r, remotes, remote }: Ctx, base: string): Promise<Base> {
  const unknown = (hint = "") => new Error(`Unknown base \`${base}\`${hint}`);
  if (base.startsWith("-")) throw unknown();
  if (await r.refExists(base)) {
    const full = await r.run(["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", base]);
    if (full.startsWith("refs/remotes/")) {
      const split = splitRemoteRef(full, remotes);
      return { start: full, label: remoteLabel(full), ...(split ? { fetch: fetchOf(split) } : {}) };
    }
    if (full.startsWith("refs/")) return { start: full, label: full.replace(/^refs\/(heads|tags)\//, "") };
    // A commit expression (HEAD~1, a SHA, detached HEAD) would be re-evaluated in the new worktree; pin it.
    const oid = await r.oid(base);
    return { start: oid, label: base, diffBase: oid };
  }
  // Not known locally. A configured-remote prefix (origin/x) names a branch on that remote.
  const qualified = splitRemoteRef(base, remotes);
  if (qualified) {
    // check-ref-format rejects patterns such as origin/*, which would otherwise fetch every branch.
    if (!await r.validRef(heads(qualified.branch))) throw unknown();
    const found = await r.remoteHas(qualified.remote, [heads(qualified.branch)]);
    if (found?.size) return remoteBase(qualified);
    if (found === null) throw new Error(`Couldn’t reach \`${qualified.remote}\` to find \`${qualified.branch}\`. Check the network, then retry.`);
  }
  // Otherwise look for a branch or tag of that name on the default remote.
  if (remote) {
    if (!await r.validRef(base, "--allow-onelevel")) throw unknown();
    const found = await r.remoteHas(remote, [heads(base), `refs/tags/${base}`]);
    if (found?.has(heads(base))) return remoteBase({ remote, branch: base });
    if (found?.has(`refs/tags/${base}`)) return { start: `refs/tags/${base}`, label: base, fetch: { remote, from: `refs/tags/${base}`, into: `refs/tags/${base}`, force: false } };
  }
  throw unknown(". Use a branch, tag, or commit.");
}

async function planNew(ctx: Ctx, branch: string, baseInput: string | undefined, pathKey?: string): Promise<Plan> {
  if (branch) {
    await checkBranchName(ctx.r, branch);
    if (await localBranch(ctx.r, branch)) throw new Error(`Branch \`${branch}\` already exists. Pick it from Branches instead.`);
  }
  const base = baseInput ? await resolveBase(ctx, baseInput) : await defaultBase(ctx.r, ctx.remote, true);
  if (base.warning) ctx.warnings.push(base.warning);
  return {
    action: "new-branch", source: ctx.r.dir, path: await ctx.destination(branch || pathKey || ""), branch, start: base.start, startLabel: base.label,
    ...(base.fetch ? { fetch: base.fetch } : {}), ...(base.start !== "HEAD" ? { mergeBaseBranch: base.diffBase ?? base.label } : {}),
  };
}

type BranchOptions = { remote?: string; localName?: string; fastForward: boolean; mergeBase?: string };
/** A branch by name: attach the worktree that has it, check out the free local branch, or fetch and track it. */
async function planBranch(ctx: Ctx, branch: string, opts: BranchOptions): Promise<Plan> {
  const { r } = ctx;
  await checkBranchName(r, branch);
  // Diff against the target of an open PR for this branch, else the default branch.
  const mergeBase = async (remote?: string) => opts.mergeBase
    ?? (remote ? await pullBase(r, branch, remote).then(b => b && `${remote}/${b}`) : undefined)
    ?? await ctx.defaultLabel();
  const local = await localBranch(r, branch);
  if (local && (!opts.remote || local.upstream === trackingRef({ remote: opts.remote, branch }))) {
    const mergeBaseBranch = await mergeBase(local.upstreamRemote || undefined);
    if (local.worktree) {
      return { action: "attach", source: r.dir, path: await checkoutRoot(local.worktree, r.signal), branch, start: "", startLabel: "", mergeBaseBranch };
    }
    const upstream = trackedUpstream(local);
    const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;
    if (upstream && local.ahead > 0) ctx.warnings.push(local.behind > 0
      ? `Local \`${branch}\` has ${commits(local.ahead)} not on \`${remoteLabel(upstream)}\`; using local as-is.`
      : `Local \`${branch}\` has ${local.ahead} unpushed ${local.ahead === 1 ? "commit" : "commits"}.`);
    const fastForward = opts.fastForward && upstream && local.ahead === 0
      ? { upstream, fetch: { remote: local.upstreamRemote, from: local.upstreamRef, into: upstream, force: false } }
      : undefined;
    return {
      action: "local-branch", source: r.dir, path: await ctx.destination(branch), branch, start: heads(branch),
      startLabel: fastForward ? remoteLabel(fastForward.upstream) : branch, ...(fastForward ? { fastForward } : {}), mergeBaseBranch,
    };
  }
  const from = opts.remote ?? ctx.remote;
  if (!from) throw new Error(`There's no local branch \`${branch}\`, and this repository has no remote`);
  const name = opts.localName || branch;
  if (name !== branch) await checkBranchName(r, name);
  if (await localBranch(r, name)) {
    throw new Error(name === branch
      ? `Local \`${branch}\` doesn't track \`${from}/${branch}\`. Enter a different local name.`
      : `Local branch \`${name}\` already exists. Choose a different local name.`);
  }
  const rb = { remote: from, branch };
  if (!await r.refExists(trackingRef(rb))) {
    const found = await r.remoteHas(from, [heads(branch)]);
    if (found === null) ctx.warnings.push(`Couldn’t reach \`${from}\` to check \`${branch}\`; it will be fetched at launch.`);
    else if (!found.size) throw new Error(`\`${branch}\` doesn't exist locally or on \`${from}\``);
  }
  // Pick the folder last: the PR-base lookup can be slow, and another launch may take a folder meanwhile.
  const mergeBaseBranch = await mergeBase(from);
  return {
    action: "track-remote", source: r.dir, path: await ctx.destination(name), branch: name, start: trackingRef(rb), startLabel: branchLabel(rb),
    fetch: fetchOf(rb), mergeBaseBranch,
  };
}

/** A pull request: detached at its head, or (same-repo PRs) its branch via planBranch. */
async function planPull(ctx: Ctx, number: number, checkout: "detached" | "branch", explicitRemote?: string): Promise<Plan> {
  const { r } = ctx;
  // An explicit remote scopes gh to that remote's repository; a non-GitHub-shaped URL skips gh and uses raw refs.
  const scoped = explicitRemote ? await remoteRepo(r, explicitRemote) : undefined;
  const details = explicitRemote && !scoped ? { status: "unavailable" as const } : await pullDetails(r, number, scoped);
  if (details.status === "missing") throw new Error(`PR #${number} wasn't found${scoped ? ` in ${scoped}` : ""}`);
  let remote = ctx.remote;
  if (!explicitRemote && details.status === "found" && details.repo) {
    // Fetch from the remote that hosts the PR (host/owner/repo), such as upstream in a fork workflow.
    remote = undefined;
    for (const candidate of ctx.remotes) if ((await remoteRepo(r, candidate))?.toLowerCase() === details.repo.toLowerCase()) { remote = candidate; break; }
    if (!remote) throw new Error(`PR #${number} is in \`${details.repo}\`, which isn't a configured remote. Add it as a remote, or choose the remote explicitly.`);
  }
  if (!remote) throw new Error("This repository has no remote that hosts the PR");
  const mergeBase = details.status === "found" ? `${remote}/${details.pull.base}` : await ctx.defaultLabel();
  if (checkout === "branch") {
    if (details.status !== "found") throw new Error("Checking out a PR's branch needs the GitHub CLI (gh) signed in on this machine. Use Detached instead.");
    if (details.pull.fork) throw new Error("This PR comes from a fork, so its branch can't be checked out here. Use Detached instead.");
    return planBranch(ctx, details.pull.head, { remote, fastForward: true, mergeBase });
  }
  if (details.status !== "found") ctx.warnings.push("PR details are unavailable (GitHub CLI missing or signed out); the PR is fetched at launch.");
  const gitlab = /gitlab/i.test(await r.remoteUrl(remote));
  // The PR head moves (and may be force-pushed); these plugin-private refs are the only ones ever overwritten.
  const into = `refs/flexible-worktrees/pr/${remote}/${number}`;
  return {
    action: "detached", source: r.dir, path: await ctx.destination(`pr-${number}`), branch: "", start: into, startLabel: `PR #${number}`,
    fetch: { remote, from: gitlab ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`, into, force: true },
    mergeBaseBranch: mergeBase,
  };
}
