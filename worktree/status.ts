import { z } from "zod";
import type { Check, Local, PullRequest, StatusRow } from "../status";
import { gh, ghFailure, repoOf } from "./github";
import { repo, type Repo } from "./git";

/** A PR the environment was created for; used while HEAD is detached. */
export type Hint = { number: number; remote?: string };
type Target = { host: string; owner: string; name: string; number: number };
type Found = { target: Target; source: "branch" | "pr-ref" | "target" };

export const PR_REFS = "refs/flexible-worktrees/pr/";
const MAX_CHECKS = 50;

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
 * Status of the PR this checkout is on, read live from Git and GitHub. Read-only: never fetches or writes refs.
 * A checked-out branch finds its PR through `gh pr view`, which follows push remotes and forks. A detached HEAD
 * finds it through the plugin's fetched PR refs (one at HEAD, else the environment's PR target).
 */
export async function prStatus({ path, pr }: { path: string; pr?: Hint }, signal?: AbortSignal): Promise<StatusRow> {
  const fetchedAt = Date.now();
  const r = repo(path, signal);
  const head = await r.attempt(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head) return { outcome: "absent", fetchedAt };
  const branch = await r.currentBranch() || null;
  let found: Found | null;
  try {
    found = branch ? await branchPull(r, branch) : await detachedPull(r, head, pr);
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
  return { outcome: "available", pullRequest, local: await local(r, branch, head, pullRequest.headRefOid), source: found.source, fetchedAt };
}

async function branchPull(r: Repo, branch: string): Promise<Found | null> {
  let view: { url: string; state: string; headRefName: string };
  try { view = await gh(r, ["pr", "view", "--json", "url,state,headRefName"]); } catch (error) {
    if (/no (open )?pull requests? found|could not find|not found/i.test(String((error as { stderr?: unknown }).stderr ?? ""))) return null;
    throw error;
  }
  const target = parsePullUrl(view.url);
  if (!target) return null;
  // gh matches by head branch name, so the default branch can pick up an old PR from someone's same-named branch.
  if (view.state !== "OPEN" && await isDefaultBranch(r, branch)) return null;
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
  const refs = (await r.refs({ ref: "refname", oid: "objectname" }, [PR_REFS])).flatMap(row => {
    const parsed = parsePrRef(row.ref);
    return parsed ? [{ ...parsed, oid: row.oid }] : [];
  });
  const remotes = await r.remotes();
  const atHead = refs.filter(ref => ref.oid === head && remotes.includes(ref.remote));
  // Prefer the PR the environment was created for when several fetched PR refs share this commit.
  const pick = atHead.find(ref => ref.number === hint?.number) ?? atHead[0];
  if (pick) {
    const target = targetOf(repoOf(await r.remoteUrl(pick.remote)), pick.number);
    return target && { target, source: "pr-ref" };
  }
  if (!hint) return null;
  // HEAD moved past the PR head (new commits on the detached checkout): fall back to the environment's PR.
  const remote = hint.remote ?? refs.find(ref => ref.number === hint.number && remotes.includes(ref.remote))?.remote;
  if (remote) {
    const target = targetOf(repoOf(await r.remoteUrl(remote)), hint.number);
    return target && { target, source: "target" };
  }
  const view = await gh<{ url: string }>(r, ["pr", "view", String(hint.number), "--json", "url"]);
  const target = parsePullUrl(view.url);
  return target && { target, source: "target" };
}

async function local(r: Repo, branch: string | null, head: string, prHead: string): Promise<Local> {
  if (head === prHead) return { branch, head, sync: { ahead: 0, behind: 0 } };
  const counts = await r.attempt(["rev-list", "--left-right", "--count", `${head}...${prHead}`]);
  const [ahead, behind] = counts?.split(/\s+/).map(Number) ?? [];
  return { branch, head, sync: counts && Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead: ahead!, behind: behind! } : null };
}

// GitHub Enterprise Server may lack newer fields; hosts that rejected them get the reduced query.
const reducedHosts = new Set<string>();
const NEWER_FIELDS = /\b(stack|stackEntry|isInMergeQueue)\b/;
const checkNodes = `nodes { __typename
  ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
  ... on StatusContext { context state targetUrl } }`;
function pullQuery(reduced: boolean) {
  return `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url state isDraft updatedAt author { login }
      headRefName baseRefName headRefOid isCrossRepository
      additions deletions changedFiles allCommits: commits { totalCount }
      reviewDecision reviewRequests { totalCount } comments { totalCount }
      reviewThreads(first: 100) { nodes { isResolved } }
      mergeable mergeStateStatus autoMergeRequest { enabledAt }${reduced ? "" : " isInMergeQueue"}
      lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { totalCount ${checkNodes} } } } } }${reduced ? "" : `
      stackEntry { position }
      stack { number size baseRefName entries(first: 50) { nodes { position pullRequest { number title url state isDraft } } } }`}
    }
  }
}`;
}

const nullish = <T extends z.ZodType>(schema: T) => schema.nullish();
const count = z.object({ totalCount: z.number() });
const checkNode = z.object({
  __typename: z.string(),
  name: z.string().nullish(), status: z.string().nullish(), conclusion: z.string().nullish(), detailsUrl: z.string().nullish(),
  checkSuite: nullish(z.object({ workflowRun: nullish(z.object({ workflow: nullish(z.object({ name: z.string() })) })) })),
  context: z.string().nullish(), state: z.string().nullish(), targetUrl: z.string().nullish(),
});
const prState = z.enum(["OPEN", "CLOSED", "MERGED"]);
const responseSchema = z.object({
  data: z.object({
    repository: nullish(z.object({
      pullRequest: nullish(z.object({
        number: z.number(), title: z.string(), url: z.string(), state: prState, isDraft: z.boolean(), updatedAt: z.string(),
        author: nullish(z.object({ login: z.string() })),
        headRefName: z.string(), baseRefName: z.string(), headRefOid: z.string(), isCrossRepository: z.boolean(),
        additions: z.number(), deletions: z.number(), changedFiles: z.number(), allCommits: count,
        reviewDecision: z.string().nullish(), reviewRequests: nullish(count), comments: count,
        reviewThreads: nullish(z.object({ nodes: z.array(z.object({ isResolved: z.boolean() }).nullable()) })),
        mergeable: z.string(), mergeStateStatus: z.string(), autoMergeRequest: nullish(z.object({ enabledAt: z.string().nullish() })),
        isInMergeQueue: z.boolean().nullish(),
        lastCommit: z.object({ nodes: z.array(nullish(z.object({ commit: z.object({
          statusCheckRollup: nullish(z.object({ contexts: z.object({ totalCount: z.number(), nodes: z.array(checkNode.nullable()) }) })),
        }) }))) }),
        stackEntry: nullish(z.object({ position: z.number() })),
        stack: nullish(z.object({
          number: z.number(), size: z.number(), baseRefName: z.string(),
          entries: z.object({ nodes: z.array(nullish(z.object({
            position: z.number(),
            pullRequest: nullish(z.object({ number: z.number(), title: z.string(), url: z.string(), state: prState, isDraft: z.boolean() })),
          }))) }),
        })),
      })),
    })),
  }),
});
type Response = z.infer<typeof responseSchema>;
type RawPull = NonNullable<NonNullable<Response["data"]["repository"]>["pullRequest"]>;

async function query(r: Repo, t: Target): Promise<PullRequest | null> {
  const run = (reduced: boolean) => gh<unknown>(r, [
    "api", "graphql", "--hostname", t.host, "-f", `query=${pullQuery(reduced)}`,
    "-f", `owner=${t.owner}`, "-f", `name=${t.name}`, "-F", `number=${t.number}`,
  ]);
  let raw: unknown;
  if (reducedHosts.has(t.host)) raw = await run(true);
  else {
    try { raw = await run(false); } catch (error) {
      const detail = `${(error as { stdout?: unknown }).stdout ?? ""}${(error as { stderr?: unknown }).stderr ?? ""}`;
      if (!/doesn't exist on type|undefinedField|Field '.*' doesn't exist/i.test(detail) || !NEWER_FIELDS.test(detail)) throw error;
      reducedHosts.add(t.host);
      raw = await run(true);
    }
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("GitHub returned an unexpected pull request response");
  const pull = parsed.data.data.repository?.pullRequest;
  return pull ? toPullRequest(pull) : null;
}

const stateOf = (state: z.infer<typeof prState>, draft: boolean): PullRequest["state"] => state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : draft ? "draft" : "open";

export function checkState(node: z.infer<typeof checkNode>): Check["state"] {
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

export function toPullRequest(p: RawPull): PullRequest {
  const nodes = p.lastCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const checks = nodes.flatMap(node => {
    if (!node) return [];
    const workflow = node.checkSuite?.workflowRun?.workflow?.name;
    const name = node.__typename === "StatusContext" ? node.context ?? "Status" : [workflow, node.name].filter(Boolean).join(" / ") || "Check";
    return [{ name, state: checkState(node), url: (node.__typename === "StatusContext" ? node.targetUrl : node.detailsUrl) ?? null }];
  }).sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
  const tally = (state: Check["state"]) => checks.filter(c => c.state === state).length;
  const failed = tally("fail"), pending = tally("pending"), passed = tally("pass");
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
      state: failed ? "failing" : pending ? "pending" : checks.length ? "passing" : "none",
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
