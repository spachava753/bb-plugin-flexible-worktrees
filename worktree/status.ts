import { z } from "zod";
import type { Check, Local, PullRequest, StatusRow } from "../status";
import { gh, ghFailure, repoOf } from "./github";
import { git, repo, type Repo } from "./git";

/** A PR the environment was created for; used while HEAD is detached. */
export type Hint = { number: number; remote?: string };
type Target = { host: string; owner: string; name: string; number: number };
type Found = { target: Target; source: "branch" | "pr-ref" | "target" };

export const PR_REFS = "refs/flexible-worktrees/pr/";
const MAX_CHECKS = 50;
/** Check contexts are read 100 at a time; PRs with more than this many keep the first pages only. */
const MAX_CHECK_PAGES = 5;

/** `https://host/owner/repo/pull/12` → its parts. */
export function parsePullUrl(url: string): Target | null {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? { host: m[1]!.toLowerCase(), owner: m[2]!, name: m[3]!, number: Number(m[4]) } : null;
}
function targetOf(identity: string | undefined, number: number): Target | null {
  const [host, owner, name] = identity?.split("/") ?? [];
  return host && owner && name ? { host, owner, name, number } : null;
}

/**
 * In a partial clone, reading a missing object makes Git fetch it from the promisor remote. Status reads must never
 * fetch, so they set GIT_NO_LAZY_FETCH (Git 2.45+). Older Git ignores it, so partial clones there skip reads of
 * commits that may be missing.
 */
const NO_LAZY_FETCH = { GIT_NO_LAZY_FETCH: "1" };
let gitVersion: Promise<number[]> | undefined;
/** Tests stand in for an older Git; production reads `git version` once. */
export function setGitVersionForTesting(version: number[] | undefined) {
  gitVersion = version && Promise.resolve(version);
}
/** Clones and fetches with --filter mark their remote `promisor`; older repositories set extensions.partialClone. */
export async function isPartialClone(r: Repo) {
  const promisors = await r.attempt(["config", "--type=bool", "--get-regexp", "^remote\\..*\\.promisor$"]);
  return promisors?.split("\n").some(line => line.endsWith(" true")) || await r.attempt(["config", "--get", "extensions.partialClone"]) !== null;
}
async function canReadMissing(r: Repo) {
  if (!await isPartialClone(r)) return true;
  gitVersion ??= git(r.dir, ["version"]).then(v => (/(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number)).catch(() => [0, 0]);
  const [major = 0, minor = 0] = await gitVersion;
  return major > 2 || (major === 2 && minor >= 45);
}

/**
 * Status of the PR this checkout is on, read live from Git and GitHub. Read-only: never fetches or writes refs.
 * A checked-out branch finds its PR through `gh pr view`, which follows push remotes and forks. A detached HEAD
 * finds it through the plugin's fetched PR refs (one at HEAD, else the environment's PR target).
 */
export async function prStatus({ path, pr }: { path: string; pr?: Hint }, signal?: AbortSignal): Promise<StatusRow> {
  const fetchedAt = Date.now();
  const r = repo(path, signal, NO_LAZY_FETCH);
  const head = await r.attempt(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head) return { outcome: "absent", fetchedAt };
  const branch = await r.currentBranch() || null;
  const ancestry = await canReadMissing(r);
  let found: Found | null;
  try {
    found = branch ? await branchPull(r, branch, head, ancestry) : await detachedPull(r, head, pr);
  } catch (error) {
    signal?.throwIfAborted();
    return { outcome: "unavailable", message: ghFailure(error), fetchedAt };
  }
  if (!found) return { outcome: "absent", fetchedAt };
  let pullRequest: PullRequest | null;
  try { pullRequest = await query(r, found.target); } catch (error) {
    signal?.throwIfAborted();
    return { outcome: "unavailable", message: ghFailure(error), fetchedAt };
  }
  if (!pullRequest) return { outcome: "absent", fetchedAt };
  const local = { branch, head, sync: ancestry ? await sync(r, head, pullRequest.headRefOid) : head === pullRequest.headRefOid ? { ahead: 0, behind: 0 } : null };
  return { outcome: "available", pullRequest, local, source: found.source, fetchedAt };
}

async function branchPull(r: Repo, branch: string, head: string, ancestry: boolean): Promise<Found | null> {
  let view: { url: string; state: string; headRefOid: string };
  try { view = await gh(r, ["pr", "view", "--json", "url,state,headRefOid"]); } catch (error) {
    if (/no (open )?pull requests? found|could not find|not found/i.test(String((error as { stderr?: unknown }).stderr ?? ""))) return null;
    throw error;
  }
  const target = parsePullUrl(view.url);
  if (!target) return null;
  if (view.state !== "OPEN") {
    // gh matches by head branch name, so a reused branch (main, develop, staging) finds the last PR merged from it.
    // That PR no longer describes the branch once it has moved past the PR's head.
    if (await isDefaultBranch(r, branch)) return null;
    if (ancestry && view.headRefOid !== head && await r.attempt(["merge-base", "--is-ancestor", view.headRefOid, head]) !== null) return null;
  }
  return { target, source: "branch" };
}
async function isDefaultBranch(r: Repo, branch: string) {
  for (const remote of await r.remotes()) {
    const head = await r.attempt(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
    if (head === `refs/remotes/${remote}/${branch}`) return true;
  }
  return branch === "main" || branch === "master";
}

/** `refs/flexible-worktrees/pr/<remote>/<n>`; remote names may contain slashes. */
export function parsePrRef(ref: string) {
  const m = new RegExp(`^${PR_REFS}(.+)/(\\d+)$`).exec(ref);
  return m ? { remote: m[1]!, number: Number(m[2]) } : null;
}
async function detachedPull(r: Repo, head: string, hint?: Hint): Promise<Found | null> {
  const remotes = await r.remotes();
  const refs = (await r.refs({ ref: "refname", oid: "objectname" }, [PR_REFS])).flatMap(row => {
    const parsed = parsePrRef(row.ref);
    return parsed && remotes.includes(parsed.remote) ? [{ ...parsed, oid: row.oid }] : [];
  });
  const atHead = refs.filter(ref => ref.oid === head);
  // Prefer the PR the environment was created for when several fetched PR refs share this commit.
  const pick = atHead.find(ref => ref.number === hint?.number && (!hint.remote || ref.remote === hint.remote)) ?? atHead[0];
  if (pick) {
    const target = targetOf(repoOf(await r.remoteUrl(pick.remote)), pick.number);
    return target && { target, source: "pr-ref" };
  }
  if (!hint) return null;
  // HEAD moved past the PR head (new commits on the detached checkout): fall back to the environment's PR, on its
  // remote, the only remote with that PR's ref, or else gh's default repository (as the planner resolves it).
  const holders = [...new Set(refs.filter(ref => ref.number === hint.number).map(ref => ref.remote))];
  const remote = hint.remote ?? (holders.length === 1 ? holders[0] : undefined);
  if (remote) {
    const target = targetOf(repoOf(await r.remoteUrl(remote)), hint.number);
    return target && { target, source: "target" };
  }
  const view = await gh<{ url: string }>(r, ["pr", "view", String(hint.number), "--json", "url"]);
  const target = parsePullUrl(view.url);
  return target && { target, source: "target" };
}

/** Commits only on HEAD (ahead) and only on the PR head (behind); null when the PR head isn't in this repository. */
async function sync(r: Repo, head: string, prHead: string): Promise<Local["sync"]> {
  if (head === prHead) return { ahead: 0, behind: 0 };
  const counts = await r.attempt(["rev-list", "--left-right", "--count", `${head}...${prHead}`]);
  const [ahead, behind] = counts?.split(/\s+/).map(Number) ?? [];
  return counts && Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead: ahead!, behind: behind! } : null;
}

// GitHub Enterprise Server may lack newer fields. Each host drops only the groups it rejected, for this process.
const OPTIONAL = {
  stack: { names: ["stack", "stackEntry"], query: `
      stackEntry { position }
      stack { number size baseRefName entries(first: 50) { nodes { position pullRequest { number title url state isDraft } } } }` },
  mergeQueue: { names: ["isInMergeQueue"], query: " isInMergeQueue" },
} as const;
type Optional = keyof typeof OPTIONAL;
const missing = new Map<string, Set<Optional>>();

const checkNodes = `pageInfo { hasNextPage endCursor } nodes { __typename
  ... on CheckRun { name status conclusion detailsUrl startedAt checkSuite { workflowRun { event workflow { name } } } }
  ... on StatusContext { context state targetUrl createdAt } }`;
const contexts = `lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100, after: $after) { ${checkNodes} } } } } }`;
const vars = "$owner: String!, $name: String!, $number: Int!, $after: String";
function pullQuery(skip: Set<Optional>) {
  const extra = (key: Optional) => skip.has(key) ? "" : OPTIONAL[key].query;
  return `query(${vars}) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url state isDraft updatedAt author { login }
      headRefName baseRefName headRefOid isCrossRepository
      additions deletions changedFiles allCommits: commits { totalCount }
      reviewDecision reviewRequests { totalCount } comments { totalCount }
      reviewThreads(first: 100) { nodes { isResolved } }
      mergeable mergeStateStatus autoMergeRequest { enabledAt }${extra("mergeQueue")}
      ${contexts}${extra("stack")}
    }
  }
}`;
}
const pageQuery = `query(${vars}) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid ${contexts} } } }`;

const nullish = <T extends z.ZodType>(schema: T) => schema.nullish();
const count = z.object({ totalCount: z.number() });
const checkNode = z.object({
  __typename: z.string(),
  name: z.string().nullish(), status: z.string().nullish(), conclusion: z.string().nullish(), detailsUrl: z.string().nullish(), startedAt: z.string().nullish(),
  checkSuite: nullish(z.object({ workflowRun: nullish(z.object({ event: z.string().nullish(), workflow: nullish(z.object({ name: z.string() })) })) })),
  context: z.string().nullish(), state: z.string().nullish(), targetUrl: z.string().nullish(), createdAt: z.string().nullish(),
});
type CheckNode = z.infer<typeof checkNode>;
const lastCommit = z.object({ nodes: z.array(nullish(z.object({ commit: z.object({
  statusCheckRollup: nullish(z.object({
    state: z.string().nullish(),
    contexts: z.object({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }), nodes: z.array(checkNode.nullable()) }),
  })),
}) }))) });
const prState = z.enum(["OPEN", "CLOSED", "MERGED"]);
const pullSchema = z.object({
  number: z.number(), title: z.string(), url: z.string(), state: prState, isDraft: z.boolean(), updatedAt: z.string(),
  author: nullish(z.object({ login: z.string() })),
  headRefName: z.string(), baseRefName: z.string(), headRefOid: z.string(), isCrossRepository: z.boolean(),
  additions: z.number(), deletions: z.number(), changedFiles: z.number(), allCommits: count,
  reviewDecision: z.string().nullish(), reviewRequests: nullish(count), comments: count,
  reviewThreads: nullish(z.object({ nodes: z.array(z.object({ isResolved: z.boolean() }).nullable()) })),
  mergeable: z.string(), mergeStateStatus: z.string(), autoMergeRequest: nullish(z.object({ enabledAt: z.string().nullish() })),
  isInMergeQueue: z.boolean().nullish(),
  lastCommit,
  stackEntry: nullish(z.object({ position: z.number() })),
  stack: nullish(z.object({
    number: z.number(), size: z.number(), baseRefName: z.string(),
    entries: z.object({ nodes: z.array(nullish(z.object({
      position: z.number(),
      pullRequest: nullish(z.object({ number: z.number(), title: z.string(), url: z.string(), state: prState, isDraft: z.boolean() })),
    }))) }),
  })),
});
const wrap = <T extends z.ZodType>(pull: T) => z.object({ data: z.object({ repository: nullish(z.object({ pullRequest: nullish(pull) })) }) });
const responseSchema = wrap(pullSchema);
const pageSchema = wrap(z.object({ headRefOid: z.string(), lastCommit }));
type RawPull = z.infer<typeof pullSchema>;

/** Optional groups a "field doesn't exist" error names; empty for any other failure. */
function rejectedFields(error: unknown): Optional[] {
  const detail = `${(error as { stdout?: unknown }).stdout ?? ""}${(error as { stderr?: unknown }).stderr ?? ""}`;
  if (!/doesn't exist on type|undefinedField/i.test(detail)) return [];
  return (Object.keys(OPTIONAL) as Optional[]).filter(key => OPTIONAL[key].names.some(name => new RegExp(`'${name}'|"${name}"`).test(detail)));
}

async function query(r: Repo, t: Target): Promise<PullRequest | null> {
  const run = (q: string, after?: string) => gh<unknown>(r, [
    "api", "graphql", "--hostname", t.host, "-f", `query=${q}`,
    "-f", `owner=${t.owner}`, "-f", `name=${t.name}`, "-F", `number=${t.number}`, ...(after ? ["-f", `after=${after}`] : []),
  ]);
  const skip = missing.get(t.host) ?? new Set<Optional>();
  let raw: unknown;
  for (;;) {
    try { raw = await run(pullQuery(skip)); break; } catch (error) {
      const rejected = rejectedFields(error).filter(key => !skip.has(key));
      if (!rejected.length) throw error;
      for (const key of rejected) skip.add(key);
      missing.set(t.host, skip);
    }
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("GitHub returned an unexpected pull request response");
  const pull = parsed.data.data.repository?.pullRequest;
  if (!pull) return null;
  // Read every page of checks for this head, so a failure past the first 100 still counts.
  const nodes = [...rollupOf(pull.lastCommit)?.contexts.nodes ?? []];
  let page = rollupOf(pull.lastCommit)?.contexts.pageInfo;
  for (let n = 1; page?.hasNextPage && page.endCursor && n < MAX_CHECK_PAGES; n++) {
    const next = pageSchema.safeParse(await run(pageQuery, page.endCursor));
    const more = next.success ? next.data.data.repository?.pullRequest : null;
    if (!more || more.headRefOid !== pull.headRefOid) break;
    nodes.push(...rollupOf(more.lastCommit)?.contexts.nodes ?? []);
    page = rollupOf(more.lastCommit)?.contexts.pageInfo;
  }
  return toPullRequest(pull, nodes);
}
const rollupOf = (commits: z.infer<typeof lastCommit>) => commits.nodes[0]?.commit.statusCheckRollup;

const stateOf = (state: z.infer<typeof prState>, draft: boolean): PullRequest["state"] => state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : draft ? "draft" : "open";

export function checkState(node: CheckNode): Check["state"] {
  if (node.__typename === "StatusContext") {
    return node.state === "SUCCESS" ? "pass" : node.state === "FAILURE" || node.state === "ERROR" ? "fail" : "pending";
  }
  if (node.status !== "COMPLETED") return "pending";
  switch (node.conclusion) {
    case "SUCCESS": return "pass";
    case "NEUTRAL": return "neutral";
    case "SKIPPED": case "STALE": return "skipped";
    default: return "fail";
  }
}
const rank: Record<Check["state"], number> = { fail: 0, pending: 1, pass: 2, neutral: 3, skipped: 4 };

/** Latest run of each check, as `gh pr checks` counts them: by workflow, name, and triggering event. */
export function latestChecks(nodes: (CheckNode | null)[]) {
  const latest = new Map<string, CheckNode>();
  for (const node of nodes) {
    if (!node) continue;
    const key = node.__typename === "StatusContext" ? `status:${node.context}` : `run:${node.checkSuite?.workflowRun?.workflow?.name}:${node.name}:${node.checkSuite?.workflowRun?.event}`;
    const at = (n: CheckNode) => n.startedAt ?? n.createdAt ?? "";
    const seen = latest.get(key);
    if (!seen || at(node) > at(seen)) latest.set(key, node);
  }
  return [...latest.values()];
}

const ROLLUP: Record<string, PullRequest["checks"]["state"]> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };

export function toPullRequest(p: RawPull, nodes: (CheckNode | null)[]): PullRequest {
  const checks = latestChecks(nodes).map(node => {
    const workflow = node.checkSuite?.workflowRun?.workflow?.name;
    const name = node.__typename === "StatusContext" ? node.context ?? "Status" : [workflow, node.name].filter(Boolean).join(" / ") || "Check";
    return { name, state: checkState(node), url: (node.__typename === "StatusContext" ? node.targetUrl : node.detailsUrl) ?? null };
  }).sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  const tally = (state: Check["state"]) => checks.filter(c => c.state === state).length;
  const failed = tally("fail"), pending = tally("pending"), passed = tally("pass");
  // GitHub's own rollup decides the overall state, so checks beyond the pages read can't make a failing PR look green.
  const rollup = ROLLUP[rollupOf(p.lastCommit)?.state ?? ""];
  const position = p.stackEntry?.position;
  return {
    number: p.number, title: p.title, url: p.url, state: stateOf(p.state, p.isDraft), author: p.author?.login ?? "",
    headRefName: p.headRefName, baseRefName: p.baseRefName, headRefOid: p.headRefOid, fork: p.isCrossRepository,
    additions: p.additions, deletions: p.deletions, changedFiles: p.changedFiles, commits: p.allCommits.totalCount,
    review: p.reviewDecision === "APPROVED" ? "approved" : p.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : p.reviewDecision === "REVIEW_REQUIRED" ? "review_required" : null,
    reviewRequests: p.reviewRequests?.totalCount ?? 0,
    unresolvedThreads: p.reviewThreads?.nodes.filter(t => t && !t.isResolved).length ?? 0,
    comments: p.comments.totalCount,
    mergeable: p.mergeable === "MERGEABLE" ? "mergeable" : p.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
    mergeState: p.mergeStateStatus, autoMerge: !!p.autoMergeRequest, inMergeQueue: !!p.isInMergeQueue,
    checks: {
      // A listed failure always shows, even if the rollup disagrees.
      state: failed ? "failing" : rollup ?? (pending ? "pending" : checks.length ? "passing" : "none"),
      passed, failed, pending, skipped: tally("skipped") + tally("neutral"), total: checks.length,
      items: checks.slice(0, MAX_CHECKS),
    },
    stack: p.stack && position !== undefined ? {
      number: p.stack.number, size: p.stack.size, base: p.stack.baseRefName, position,
      entries: p.stack.entries.nodes.flatMap(e => e?.pullRequest ? [{
        position: e.position, number: e.pullRequest.number, title: e.pullRequest.title, url: e.pullRequest.url,
        state: stateOf(e.pullRequest.state, e.pullRequest.isDraft),
      }] : []).sort((a, b) => a.position - b.position),
    } : null,
    updatedAt: p.updatedAt,
  };
}
