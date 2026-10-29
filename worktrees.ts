import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants, copyFile, mkdir, readFile, realpath, lstat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import { inputsSchema, planSchema, slug, type BranchRow, type Choices, type Inputs, type LiveBranches, type Plan, type PlanResult, type Pull, type Pulls } from "./inputs";

const exec = promisify(execFile);
export async function git(cwd: string, args: string[], signal?: AbortSignal, timeout = 120_000) {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    signal, timeout, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trimEnd();
}
/** Like git(), but a failed command yields null. Cancellation still throws. */
async function tryGit(cwd: string, args: string[], signal?: AbortSignal, timeout?: number) {
  try { return await git(cwd, args, signal, timeout); } catch {
    signal?.throwIfAborted();
    return null;
  }
}
function stderr(error: unknown) {
  const text = String((error as { stderr?: unknown }).stderr ?? (error as Error).message ?? "");
  return text.split("\n").map(s => s.replace(/^(fatal|error): /, "").trim()).find(Boolean) ?? "";
}
function expand(path: string) {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new Error("Use an absolute path or ~/path");
  return resolve(expanded);
}
export async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function checkoutRoot(path: string, signal?: AbortSignal) {
  let root: string;
  try { root = await realpath(expand(path)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`\`${path}\` doesn't exist`);
    throw error;
  }
  if (await tryGit(root, ["rev-parse", "--is-inside-work-tree"], signal) !== "true") throw new Error("Not a Git checkout");
  const top = await realpath(await git(root, ["rev-parse", "--show-toplevel"], signal));
  if (root !== top) throw new Error("Choose the checkout root, not a subdirectory");
  return root;
}
async function checkBranchName(source: string, branch: string, signal?: AbortSignal) {
  if (!branch || branch.startsWith("-") || branch === "HEAD" || await tryGit(source, ["check-ref-format", `refs/heads/${branch}`], signal) === null) {
    throw new Error(`\`${branch}\` isn't a valid branch name`);
  }
}
const refExists = async (source: string, ref: string, signal?: AbortSignal) =>
  await tryGit(source, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], signal) !== null;

export async function list(source: string, signal?: AbortSignal) {
  const raw = await git(source, ["worktree", "list", "--porcelain", "-z"], signal);
  return raw.split("\0\0").filter(Boolean).flatMap(record => {
    const fields = record.split("\0");
    const path = fields.find(f => f.startsWith("worktree "))?.slice(9);
    if (!path || fields.includes("bare")) return [];
    return [{ path, branch: fields.find(f => f.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? "(detached)" }];
  });
}

async function remotes(source: string, signal?: AbortSignal) {
  return (await git(source, ["remote"], signal)).split("\n").filter(Boolean);
}
function pickRemote(all: string[], requested?: string) {
  if (requested) {
    if (requested.startsWith("-") || !all.includes(requested)) throw new Error(`\`${requested}\` isn't a configured Git remote`);
    return requested;
  }
  return all.includes("origin") ? "origin" : all[0];
}
/** Split refs/remotes/<remote>/<branch>, allowing remote names that contain slashes. */
function splitRemoteRef(ref: string, all: string[]) {
  const rest = ref.replace(/^refs\/remotes\//, "");
  const remote = [...all].sort((a, b) => b.length - a.length).find(r => rest.startsWith(`${r}/`));
  return remote ? { remote, branch: rest.slice(remote.length + 1) } : null;
}

/** `diffBase` overrides `label` as BB's diff base when the label is a relative expression such as HEAD~1. */
type Base = { start: string; label: string; diffBase?: string; fetch?: Plan["fetch"] };
const fetchInto = (remote: string, branch: string): NonNullable<Plan["fetch"]> =>
  ({ remote, from: `refs/heads/${branch}`, into: `refs/remotes/${remote}/${branch}`, force: false });

/**
 * The remote's default branch, else the local default branch (only for repositories without a remote).
 * With `network`, a remote whose default branch was never fetched is asked with ls-remote; otherwise
 * that case falls back to the local default, as the instant picker listing does.
 */
async function defaultBase(source: string, remote: string | undefined, signal?: AbortSignal, network = false): Promise<Base & { warning?: string }> {
  if (remote) {
    const head = await tryGit(source, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`], signal);
    const candidates = [head, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`].filter((r): r is string => Boolean(r));
    for (const ref of candidates) {
      if (!await refExists(source, ref, signal)) continue;
      const branch = ref.slice(`refs/remotes/${remote}/`.length);
      return { start: ref, label: `${remote}/${branch}`, fetch: fetchInto(remote, branch) };
    }
    if (network) {
      const raw = await tryGit(source, ["ls-remote", "--symref", "--", remote, "HEAD"], signal);
      const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(raw ?? "")?.[1];
      if (branch) return { start: `refs/remotes/${remote}/${branch}`, label: `${remote}/${branch}`, fetch: fetchInto(remote, branch) };
      const local = await defaultBase(source, undefined, signal);
      return { ...local, warning: `Couldn’t find \`${remote}\`'s default branch${raw === null ? " (remote unreachable)" : ""}; starting from local \`${local.label}\`.` };
    }
  }
  for (const branch of ["main", "master"]) {
    if (await refExists(source, `refs/heads/${branch}`, signal)) return { start: `refs/heads/${branch}`, label: branch };
  }
  const current = await tryGit(source, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
  return current ? { start: `refs/heads/${current}`, label: current } : { start: "HEAD", label: "HEAD" };
}

async function resolveBase(source: string, base: string, all: string[], remote: string | undefined, signal?: AbortSignal): Promise<Base> {
  if (base.startsWith("-")) throw new Error(`Unknown base \`${base}\``);
  if (await refExists(source, base, signal)) {
    const full = await git(source, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", base], signal);
    if (full.startsWith("refs/remotes/")) {
      const split = splitRemoteRef(full, all);
      return { start: full, label: full.slice(13), ...(split ? { fetch: fetchInto(split.remote, split.branch) } : {}) };
    }
    if (full.startsWith("refs/")) return { start: full, label: full.replace(/^refs\/(heads|tags)\//, "") };
    // A commit expression (HEAD~1, a SHA, detached HEAD) would be re-evaluated in the new worktree; pin it.
    const oid = await git(source, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], signal);
    return { start: oid, label: base, diffBase: oid };
  }
  // Not known locally. A configured-remote prefix (origin/x) names a branch on that remote.
  const qualified = splitRemoteRef(base.replace(/^refs\/remotes\//, ""), all);
  if (qualified) {
    // check-ref-format rejects patterns such as origin/*, which would otherwise fetch every branch.
    if (await tryGit(source, ["check-ref-format", `refs/heads/${qualified.branch}`], signal) === null) throw new Error(`Unknown base \`${base}\``);
    const found = await tryGit(source, ["ls-remote", "--heads", "--", qualified.remote, `refs/heads/${qualified.branch}`], signal);
    if (found?.split("\n").some(line => line.split("\t")[1] === `refs/heads/${qualified.branch}`)) return { start: `refs/remotes/${qualified.remote}/${qualified.branch}`, label: `${qualified.remote}/${qualified.branch}`, fetch: fetchInto(qualified.remote, qualified.branch) };
    else if (found === null) throw new Error(`Couldn’t reach \`${qualified.remote}\` to find \`${qualified.branch}\`. Check the network, then retry.`);
  }
  // Otherwise look for a branch or tag of that name on the default remote.
  if (remote) {
    if (await tryGit(source, ["check-ref-format", "--allow-onelevel", base], signal) === null) throw new Error(`Unknown base \`${base}\``);
    const heads = await tryGit(source, ["ls-remote", "--", remote, `refs/heads/${base}`, `refs/tags/${base}`], signal);
    const refs = (heads ?? "").split("\n").map(line => line.split("\t")[1]).filter(Boolean);
    if (refs.includes(`refs/heads/${base}`)) return { start: `refs/remotes/${remote}/${base}`, label: `${remote}/${base}`, fetch: fetchInto(remote, base) };
    if (refs.includes(`refs/tags/${base}`)) return { start: `refs/tags/${base}`, label: base, fetch: { remote, from: `refs/tags/${base}`, into: `refs/tags/${base}`, force: false } };
  }
  throw new Error(`Unknown base \`${base}\`. Use a branch, tag, or commit.`);
}

type LocalBranch = { worktree: string; upstream: string; upstreamRemote: string; upstreamRef: string; ahead: number; behind: number; gone: boolean };
function track(value: string) {
  return { ahead: Number(/ahead (\d+)/.exec(value)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(value)?.[1] ?? 0), gone: value.includes("gone") };
}
async function localBranch(source: string, branch: string, signal?: AbortSignal): Promise<LocalBranch | null> {
  // for-each-ref patterns also match descendants (feature matches feature/x), so require the exact ref.
  const raw = await git(source, ["for-each-ref", "--format=%(refname)%00%(worktreepath)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track)", "--", `refs/heads/${branch}`], signal);
  const line = raw.split("\n").find(l => l.startsWith(`refs/heads/${branch}\0`));
  if (!line) return null;
  const [, worktree = "", upstream = "", upstreamRemote = "", upstreamRef = "", tracking = ""] = line.split("\0");
  return { worktree, upstream, upstreamRemote, upstreamRef, ...track(tracking) };
}

type GhPull = { number: number; title: string; author?: { login?: string }; headRefName: string; baseRefName: string; isCrossRepository: boolean; isDraft: boolean; updatedAt: string; url?: string };
const ghFields = "number,title,author,headRefName,baseRefName,isCrossRepository,isDraft,updatedAt";
/** Run the GitHub CLI if installed. Never prompts. */
async function gh(source: string, args: string[], signal?: AbortSignal) {
  const { stdout } = await exec("gh", args, {
    cwd: source, signal, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}
const toPull = (p: GhPull): Pull => ({
  number: p.number, title: p.title, author: p.author?.login ?? "", head: p.headRefName, base: p.baseRefName,
  fork: p.isCrossRepository, draft: p.isDraft, updated: Date.parse(p.updatedAt) || 0,
});

export async function pulls(source: string, signal?: AbortSignal): Promise<Pulls> {
  try {
    const rows = JSON.parse(await gh(source, ["pr", "list", "--state", "open", "--limit", "50", "--json", ghFields], signal)) as GhPull[];
    return { available: true, pulls: rows.map(toPull) };
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { available: false, pulls: [] };
    const reason = stderr(error);
    if (/auth login|not logged in|authentication/i.test(reason)) return { available: false, message: "Run `gh auth login` on this machine to list PRs.", pulls: [] };
    if (/no git remotes|known GitHub host|not a git repository/i.test(reason)) return { available: false, pulls: [] };
    return { available: true, message: `Couldn’t load PRs: ${reason || "unknown error"}`, pulls: [] };
  }
}
/** HOST/OWNER/REPO for gh --repo, from a remote URL (scp-like, ssh://, or https://). */
export function repoOf(url: string) {
  const scp = /^[^@/\s]+@([^:/\s]+):([^\s]+?)(?:\.git)?\/?$/.exec(url);
  let host: string, path: string;
  if (scp) [host, path] = [scp[1]!, scp[2]!];
  else {
    try { const u = new URL(url); [host, path] = [u.hostname, u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")]; } catch { return undefined; }
  }
  return host && /^[^/]+\/[^/]+$/.test(path) ? `${host}/${path}` : undefined;
}
async function pullDetails(source: string, number: number, repo: string | undefined, signal?: AbortSignal): Promise<{ status: "found"; pull: Pull; repo?: string } | { status: "missing" } | { status: "unavailable" }> {
  try {
    const row = JSON.parse(await gh(source, ["pr", "view", String(number), "--json", `${ghFields},url`, ...(repo ? ["--repo", repo] : [])], signal)) as GhPull;
    return { status: "found", pull: toPull(row), repo: /^https?:\/\/([^/]+\/[^/]+\/[^/]+)\/pull\//.exec(row.url ?? "")?.[1] };
  } catch (error) {
    signal?.throwIfAborted();
    return /could not resolve|not found|no pull requests? found/i.test(stderr(error)) ? { status: "missing" } : { status: "unavailable" };
  }
}
/** Target branch of an open PR whose head is this branch, when gh can tell. */
async function pullBase(source: string, branch: string, remote: string, signal?: AbortSignal) {
  const repo = repoOf(await remoteUrl(source, remote, signal));
  if (!repo) return undefined;
  try {
    const rows = JSON.parse(await gh(source, ["pr", "list", "--repo", repo, "--state", "open", "--head", branch, "--limit", "1", "--json", "baseRefName"], signal)) as { baseRefName: string }[];
    return rows[0]?.baseRefName;
  } catch { signal?.throwIfAborted(); return undefined; }
}
async function remoteUrl(source: string, remote: string, signal?: AbortSignal) {
  return await tryGit(source, ["remote", "get-url", "--", remote], signal) ?? "";
}

export type PlanArgs = { source: string; inputs: Inputs; defaultRoot: string; pathKey?: string; suggestedBranch?: string; dataDir?: string };
/**
 * Resolve inputs into one concrete plan. Reads local state and may query
 * remotes (ls-remote, gh), but never writes refs, config, or files.
 */
export async function plan(args: PlanArgs, signal?: AbortSignal): Promise<PlanResult> {
  const { inputs } = args;
  const source = await checkoutRoot(args.source, signal);
  if (args.pathKey && args.dataDir) {
    // Retries must reuse the first attempt's plan; re-planning could choose a different folder.
    const recorded = await readReceipt(args.dataDir, args.pathKey);
    if (recorded) {
      if (JSON.stringify(recorded.inputs) !== JSON.stringify(inputs)) throw new Error("This launch already reserved a different worktree. Restore the original settings or start a new thread.");
      return { plan: recorded.plan, warnings: [] };
    }
  }
  if (inputs.target === "path") {
    return { plan: { action: "attach", source, path: await checkoutRoot(inputs.path, signal), branch: "", start: "", startLabel: "" }, warnings: [] };
  }
  const all = await remotes(source, signal);
  const remote = pickRemote(all, inputs.remote);
  const warnings: string[] = [];
  // Use the primary checkout's name even when the source is itself a linked worktree.
  const common = await realpath(await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal));
  const root = expand((inputs.location?.root || args.defaultRoot).replaceAll("{repo}", basename(dirname(common))));
  const destination = async (hint: string) => {
    if (inputs.location?.folder) {
      const path = await canonical(join(root, inputs.location.folder));
      if (await exists(path)) throw new Error(`\`${path}\` already exists. Choose another folder, or pick it under Worktrees to attach it.`);
      return path;
    }
    if (!hint) return "";
    const base = slug(hint);
    for (let n = 1; n < 100; n++) {
      const path = await canonical(join(root, n === 1 ? base : `${base}-${n}`));
      if (!await exists(path)) return path;
    }
    throw new Error("Too many folders with this name; choose a folder name");
  };
  const defaultLabel = async () => (await defaultBase(source, remote, signal)).label;

  const forBranch = async (branch: string, opts: { remote?: string; localName?: string; fastForward: boolean; mergeBase?: string }): Promise<PlanResult> => {
    await checkBranchName(source, branch, signal);
    const local = await localBranch(source, branch, signal);
    const tracksRequested = local && opts.remote && local.upstream === `refs/remotes/${opts.remote}/${branch}`;
    if (local && (!opts.remote || tracksRequested)) {
      const mergeBaseBranch = opts.mergeBase ?? (local.upstreamRemote ? await pullBase(source, branch, local.upstreamRemote, signal).then(b => b && `${local.upstreamRemote}/${b}`) : undefined) ?? await defaultLabel();
      if (local.worktree) {
        return { plan: { action: "attach", source, path: await checkoutRoot(local.worktree, signal), branch, start: "", startLabel: "", mergeBaseBranch }, warnings };
      }
      const upstream = local.upstream.startsWith("refs/remotes/") && local.upstreamRemote && local.upstreamRef.startsWith("refs/heads/") && !local.gone;
      if (upstream && local.ahead > 0) warnings.push(local.behind > 0
        ? `Local \`${branch}\` has ${local.ahead} commit${local.ahead === 1 ? "" : "s"} not on \`${local.upstream.slice(13)}\`; using local as-is.`
        : `Local \`${branch}\` has ${local.ahead} unpushed commit${local.ahead === 1 ? "" : "s"}.`);
      const fastForward = opts.fastForward && upstream && local.ahead === 0
        ? { upstream: local.upstream, fetch: { remote: local.upstreamRemote, from: local.upstreamRef, into: local.upstream, force: false } }
        : undefined;
      return { plan: {
        action: "local-branch", source, path: await destination(branch), branch, start: `refs/heads/${branch}`,
        startLabel: fastForward ? local.upstream.slice(13) : branch, ...(fastForward ? { fastForward } : {}), mergeBaseBranch,
      }, warnings };
    }
    const from = opts.remote ?? remote;
    if (!from) throw new Error(`There's no local branch \`${branch}\`, and this repository has no remote`);
    const name = opts.localName || branch;
    if (name !== branch) await checkBranchName(source, name, signal);
    if (await localBranch(source, name, signal)) {
      throw new Error(name === branch
        ? `Local \`${branch}\` doesn't track \`${from}/${branch}\`. Enter a different local name.`
        : `Local branch \`${name}\` already exists. Choose a different local name.`);
    }
    const ref = `refs/remotes/${from}/${branch}`;
    if (!await refExists(source, ref, signal)) {
      const found = await tryGit(source, ["ls-remote", "--heads", "--", from, `refs/heads/${branch}`], signal);
      if (found === null) warnings.push(`Couldn’t reach \`${from}\` to check \`${branch}\`; it will be fetched at launch.`);
      else if (!found) throw new Error(`\`${branch}\` doesn't exist locally or on \`${from}\``);
    }
    const mergeBaseBranch = opts.mergeBase ?? await pullBase(source, branch, from, signal).then(b => b && `${from}/${b}`) ?? await defaultLabel();
    return { plan: {
      action: "track-remote", source, path: await destination(name), branch: name, start: ref, startLabel: `${from}/${branch}`,
      fetch: fetchInto(from, branch), mergeBaseBranch,
    }, warnings };
  };

  if (inputs.target === "new") {
    const branch = inputs.branch || args.suggestedBranch || "";
    if (branch) {
      await checkBranchName(source, branch, signal);
      if (await localBranch(source, branch, signal)) throw new Error(`Branch \`${branch}\` already exists. Pick it from Branches instead.`);
    }
    const base: Base & { warning?: string } = inputs.base ? await resolveBase(source, inputs.base, all, remote, signal) : await defaultBase(source, remote, signal, true);
    if (base.warning) warnings.push(base.warning);
    return { plan: {
      action: "new-branch", source, path: await destination(branch || args.pathKey || ""), branch, start: base.start, startLabel: base.label,
      ...(base.fetch ? { fetch: base.fetch } : {}), ...(base.start !== "HEAD" ? { mergeBaseBranch: base.diffBase ?? base.label } : {}),
    }, warnings };
  }
  if (inputs.target === "branch") {
    return forBranch(inputs.branch, { remote: inputs.remote, localName: inputs.localName, fastForward: inputs.fastForward });
  }

  // Pull request.
  // An explicit remote scopes gh to that remote's repository; a non-GitHub-shaped URL skips gh and uses raw refs.
  const scoped = inputs.remote ? repoOf(await remoteUrl(source, inputs.remote, signal)) : undefined;
  const details = inputs.remote && !scoped ? { status: "unavailable" as const } : await pullDetails(source, inputs.number, scoped, signal);
  if (details.status === "missing") throw new Error(`PR #${inputs.number} wasn't found${scoped ? ` in ${scoped}` : ""}`);
  let prRemote: string | undefined = remote;
  if (!inputs.remote && details.status === "found" && details.repo) {
    // Fetch from the remote that hosts the PR (host/owner/repo), such as upstream in a fork workflow.
    prRemote = undefined;
    for (const r of all) if (repoOf(await remoteUrl(source, r, signal))?.toLowerCase() === details.repo.toLowerCase()) { prRemote = r; break; }
    if (!prRemote) throw new Error(`PR #${inputs.number} is in \`${details.repo}\`, which isn't a configured remote. Add it as a remote, or choose the remote explicitly.`);
  }
  if (!prRemote) throw new Error("This repository has no remote that hosts the PR");
  const mergeBase = details.status === "found" ? `${prRemote}/${details.pull.base}` : await defaultLabel();
  if (inputs.checkout === "branch") {
    if (details.status !== "found") throw new Error("Checking out a PR's branch needs the GitHub CLI (gh) signed in on this machine. Use Detached instead.");
    if (details.pull.fork) throw new Error("This PR comes from a fork, so its branch can't be checked out here. Use Detached instead.");
    return forBranch(details.pull.head, { remote: prRemote, fastForward: true, mergeBase });
  }
  if (details.status !== "found") warnings.push("PR details are unavailable (GitHub CLI missing or signed out); the PR is fetched at launch.");
  const gitlab = /gitlab/i.test(await remoteUrl(source, prRemote, signal));
  return { plan: {
    action: "detached", source, path: await destination(`pr-${inputs.number}`), branch: "",
    start: `refs/flexible-worktrees/pr/${prRemote}/${inputs.number}`, startLabel: `PR #${inputs.number}`,
    // The PR head moves (and may be force-pushed); this plugin-private ref is the only one ever overwritten.
    fetch: { remote: prRemote, from: gitlab ? `refs/merge-requests/${inputs.number}/head` : `refs/pull/${inputs.number}/head`, into: `refs/flexible-worktrees/pr/${prRemote}/${inputs.number}`, force: true },
    mergeBaseBranch: mergeBase,
  }, warnings };
}

/** Durable ownership receipt, not a launch/lifecycle registry. No paths are ever deleted. */
const receiptSchema = z.object({ inputs: inputsSchema, plan: planSchema, provisioned: z.boolean() }).strict();
type Receipt = z.infer<typeof receiptSchema>;
const receiptPath = (dataDir: string, pathKey: string) => join(dataDir, "receipts", `${createHash("sha256").update(pathKey).digest("hex")}.json`);
async function readReceipt(dataDir: string, pathKey: string): Promise<Receipt | undefined> {
  let raw: string;
  try { raw = await readFile(receiptPath(dataDir, pathKey), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = receiptSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("This launch has an unrecognized ownership receipt (from an older plugin version). Start a new thread.");
  return parsed.data;
}
async function writeReceipt(dataDir: string, pathKey: string, receipt: Receipt, create: boolean) {
  await mkdir(join(dataDir, "receipts"), { recursive: true });
  await writeFile(receiptPath(dataDir, pathKey), JSON.stringify(receipt), { flag: create ? "wx" : "w", mode: 0o600 });
}

async function fetchRef(source: string, f: NonNullable<Plan["fetch"]>, signal?: AbortSignal) {
  if (f.remote.startsWith("-")) throw new Error("Invalid remote");
  try {
    // Only the requested ref: no tags, pruning, or submodules. Force only for plugin-private PR refs.
    await git(source, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--", f.remote, `${f.force ? "+" : ""}${f.from}:${f.into}`], signal, 600_000);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`Couldn’t fetch \`${f.from.replace(/^refs\/heads\//, "")}\` from \`${f.remote}\` (${stderr(error) || "unknown error"}). Check this machine's network and Git credentials, then retry.`);
  }
}

export type CreateArgs = { plan: Plan; inputs: Inputs; pathKey: string; initSubmodules: boolean };
export async function create({ plan: p, inputs, pathKey, initSubmodules }: CreateArgs, dataDir: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (p.action === "attach") return { path: await checkoutRoot(p.path, signal), log: [] as string[] };
  if (!p.path) throw new Error("Destination is unresolved");
  const recorded = await readReceipt(dataDir, pathKey);
  if (recorded && (JSON.stringify(recorded.plan) !== JSON.stringify(p) || JSON.stringify(recorded.inputs) !== JSON.stringify(inputs))) {
    throw new Error("This launch already reserved a different worktree. Restore the original settings or start a new thread.");
  }
  const receipt: Receipt = recorded ?? { inputs, plan: p, provisioned: false };
  if (await exists(p.path)) {
    if (!recorded) throw new Error("Destination already exists. Pick it under Worktrees to attach it; nothing was overwritten.");
    const row = (await list(p.source, signal)).find(r => resolve(r.path) === p.path && r.branch === (p.branch || "(detached)"));
    // The directory itself must still be that repository's worktree, not a clone moved into its place.
    // Its canonical root (no symlink swap) and checked-out branch must also be the ones this launch created.
    const current = await tryGit(p.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal) ?? "";
    if (!row || !await sameRepository(p.path, p.source, signal) || await checkoutRoot(p.path, signal) !== p.path || current !== p.branch) {
      throw new Error("Reserved destination no longer matches its worktree. Nothing was changed.");
    }
    // A rebuild or retry of a finished launch must not re-run provisioning over the agent's work.
    if (receipt.provisioned) return { path: p.path, log: [] };
    // Interrupted after checkout: finish the fast-forward (a no-op when already done), then provisioning.
    const resumed = p.fastForward && await refExists(p.source, p.fastForward.upstream, signal) ? [await fastForward(p.path, p.branch, p.fastForward.upstream, signal)] : [];
    return { path: p.path, log: [...resumed, ...await provision(receipt, dataDir, pathKey, initSubmodules, signal)] };
  }
  const log: string[] = [];
  if (p.fetch) {
    try { await fetchRef(p.source, p.fetch, signal); } catch (error) {
      // A stale base is still a valid starting point for a new branch; anything else needs the fresh ref.
      if (p.action !== "new-branch" || !await refExists(p.source, p.fetch.into, signal)) throw error;
      log.push(`${(error as Error).message.split(" (")[0]}; starting from the last fetched \`${p.startLabel}\`.`);
    }
  }
  if (p.action !== "local-branch" && p.branch && await localBranch(p.source, p.branch, signal)) {
    throw new Error(`Local branch \`${p.branch}\` was created after you chose it. Pick it from Branches instead; nothing was changed.`);
  }
  let fastForwardTo: string | undefined;
  if (p.action === "local-branch") {
    const holder = (await list(p.source, signal)).find(r => r.branch === p.branch);
    if (holder) throw new Error(`\`${p.branch}\` was checked out in \`${holder.path}\` after you chose it. Pick it again to attach.`);
    if (p.fastForward) {
      try { await fetchRef(p.source, p.fastForward.fetch, signal); fastForwardTo = p.fastForward.upstream; } catch (error) {
        log.push(`${(error as Error).message.split(" (")[0]}; using local \`${p.branch}\` as-is.`);
      }
    }
  }
  const start = p.action === "detached" ? await git(p.source, ["rev-parse", "--verify", "--end-of-options", `${p.start}^{commit}`], signal) : p.start;
  if (!recorded) await writeReceipt(dataDir, pathKey, receipt, true);
  await mkdir(dirname(p.path), { recursive: true });
  // Refuse even an empty destination created since the initial check.
  if (await exists(p.path)) throw new Error("Destination appeared during creation; refusing to overwrite it");
  const args = {
    "new-branch": ["worktree", "add", "--no-track", "-b", p.branch, "--", p.path, start],
    "track-remote": ["worktree", "add", "--track", "-b", p.branch, "--", p.path, start],
    // Passing a full ref detaches HEAD, so check out the validated short name.
    "local-branch": ["worktree", "add", "--", p.path, p.branch],
    detached: ["worktree", "add", "--detach", "--", p.path, start],
  }[p.action];
  await git(p.source, args, signal);
  // Fast-forward only after this worktree has checked the branch out, so Git refuses it elsewhere meanwhile.
  if (fastForwardTo) log.push(await fastForward(p.path, p.branch, fastForwardTo, signal));
  log.push(...await provision(receipt, dataDir, pathKey, initSubmodules, signal));
  return { path: p.path, log };
}

/** Fast-forward the branch checked out in this fresh worktree; anything but a pure fast-forward leaves it as-is. */
async function fastForward(path: string, branch: string, upstream: string, signal?: AbortSignal) {
  const label = upstream.replace(/^refs\/remotes\//, "");
  const target = await git(path, ["rev-parse", "--verify", "--end-of-options", `${upstream}^{commit}`], signal);
  if (await tryGit(path, ["merge-base", "--is-ancestor", "HEAD", target], signal) === null) return `\`${branch}\` diverged from \`${label}\`; not fast-forwarded.`;
  if (target === await git(path, ["rev-parse", "HEAD"], signal)) return `\`${branch}\` is up to date with \`${label}\`.`;
  try { await git(path, ["merge", "--ff-only", "--quiet", target], signal); } catch (error) {
    signal?.throwIfAborted();
    return `Couldn’t fast-forward \`${branch}\` (${stderr(error) || "unknown error"}); using it as-is.`;
  }
  return `Fast-forwarded \`${branch}\` to \`${label}\`.`;
}
async function sameRepository(path: string, source: string, signal?: AbortSignal) {
  const common = async (dir: string) => {
    const raw = await tryGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
    return raw && await realpath(raw).catch(() => null);
  };
  const [a, b] = await Promise.all([common(path), common(source)]);
  return Boolean(a && a === b);
}

/** Runs once per created worktree. Problems are reported, never fatal. */
async function provision(receipt: Receipt, dataDir: string, pathKey: string, initSubmodules: boolean, signal?: AbortSignal) {
  const { path, source } = receipt.plan;
  const log: string[] = [];
  if (initSubmodules && await exists(join(path, ".gitmodules"))) {
    try {
      await git(path, ["submodule", "update", "--init", "--recursive"], signal, 1_200_000);
      log.push("Initialized submodules.");
    } catch (error) {
      signal?.throwIfAborted();
      log.push(`Submodules not initialized: ${stderr(error) || "unknown error"}. Run \`git submodule update --init --recursive\` in the worktree.`);
    }
  }
  log.push(...await copyIncludes(source, path, signal));
  await writeReceipt(dataDir, pathKey, { ...receipt, provisioned: true }, false);
  return log;
}

/** Copy untracked source files matching the worktree's tracked .worktreeinclude. Never replaces or follows symlinks. */
export async function copyIncludes(source: string, path: string, signal?: AbortSignal) {
  const patterns = join(path, ".worktreeinclude");
  try { if (!(await lstat(patterns)).isFile()) return []; } catch { return []; }
  const files = await tryGit(source, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${patterns}`], signal);
  if (files === null) return ["Couldn’t read .worktreeinclude patterns; no files copied."];
  const root = await realpath(path);
  let copied = 0;
  const skipped: string[] = [];
  for (const rel of files.split("\0").filter(Boolean)) {
    signal?.throwIfAborted();
    const from = join(source, rel), to = join(path, rel);
    try {
      if (!(await lstat(from)).isFile() || await exists(to)) { skipped.push(rel); continue; }
      // A tracked symlinked directory must not redirect the copy outside the worktree.
      const parent = await canonical(dirname(to));
      if (parent !== root && !parent.startsWith(root + sep)) { skipped.push(rel); continue; }
      await mkdir(parent, { recursive: true });
      await copyFile(from, join(parent, basename(to)), constants.COPYFILE_EXCL);
      copied++;
    } catch { skipped.push(rel); }
  }
  if (!copied && !skipped.length) return [".worktreeinclude matched no untracked files."];
  return [`Copied ${copied} file${copied === 1 ? "" : "s"} from .worktreeinclude${skipped.length ? `; skipped ${skipped.length} (already present, symlinks, or unreadable): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}` : ""}.`];
}

/** Branch rows for the picker from local refs only: instant, possibly stale. */
export async function choices(source: string, signal?: AbortSignal): Promise<Omit<Choices, "defaultRoot">> {
  const all = await remotes(source, signal);
  const remote = pickRemote(all);
  const raw = await git(source, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(committerdate:unix)%00%(worktreepath)%00%(upstream)%00%(upstream:remotename)%00%(upstream:track)%00%(symref)", "refs/heads", "refs/remotes"], signal);
  const rows: BranchRow[] = [];
  const upstreams = new Set<string>();
  const remoteRows: { ref: string; date: number }[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const [ref = "", date = "0", worktree = "", upstream = "", upstreamRemote = "", tracking = "", symref = ""] = line.split("\0");
    if (ref.startsWith("refs/heads/")) {
      if (upstream) upstreams.add(upstream);
      const t = track(tracking);
      rows.push({ name: ref.slice(11), local: true, date: Number(date) * 1000, ahead: t.ahead, behind: t.behind,
        ...(worktree ? { worktree } : {}), ...(upstreamRemote && upstream.startsWith("refs/remotes/") && !t.gone ? { remote: upstreamRemote } : {}) });
    } else if (!symref) remoteRows.push({ ref, date: Number(date) * 1000 });
  }
  for (const { ref, date } of remoteRows) {
    const split = splitRemoteRef(ref, all);
    if (split && !upstreams.has(ref)) rows.push({ name: split.branch, remote: split.remote, local: false, date, ahead: 0, behind: 0 });
  }
  rows.sort((a, b) => b.date - a.date);
  return {
    branches: rows, worktrees: await list(source, signal), remotes: all,
    ...(remote ? { defaultRemote: remote } : {}), defaultBase: (await defaultBase(source, remote, signal)).label,
  };
}

/** Query the live remote heads without changing any local refs or checkout. */
export async function liveBranches(source: string, signal?: AbortSignal): Promise<LiveBranches> {
  const results = await Promise.all((await remotes(source, signal)).map(async remote => {
    try {
      const raw = await git(source, ["ls-remote", "--heads", "--", remote], signal);
      return { branches: raw.split("\n").flatMap(line => {
        const ref = line.split("\t")[1];
        return ref?.startsWith("refs/heads/") ? [{ remote, branch: ref.slice(11) }] : [];
      }), errors: [] as string[] };
    } catch {
      signal?.throwIfAborted();
      return { branches: [], errors: [`Couldn’t reach \`${remote}\`; showing last fetched branches.`] };
    }
  }));
  return { branches: results.flatMap(r => r.branches), errors: results.flatMap(r => r.errors) };
}
