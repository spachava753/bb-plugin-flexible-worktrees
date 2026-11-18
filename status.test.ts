import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { git } from "./worktree/git";
import { prStatus, setGitVersionForTesting } from "./worktree/status";
import { checksLabel, mergeLabel, syncLabel } from "./statusbar/describe";
import type { PullRequest } from "./status";

// A fake gh: answers `pr view` and `api graphql` from a scenario file and logs every call.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const scenario = JSON.parse(fs.readFileSync(process.env.FAKE_GH_SCENARIO, "utf8"));
const args = process.argv.slice(2);
const log = fs.existsSync(process.env.FAKE_GH_LOG) ? fs.readFileSync(process.env.FAKE_GH_LOG, "utf8") : "";
const queries = log.split("\\n").filter(line => line.startsWith('["api"')).length;
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
// Each process re-reads the scenario, so the nth graphql call gets the nth reply.
const reply = args[0] === "pr" ? scenario.view : scenario.graphql[queries];
if (reply.stderr) { process.stderr.write(reply.stderr); process.stdout.write(reply.stdout ?? ""); process.exit(1); }
process.stdout.write(JSON.stringify(reply.json));
`;

let temp: string, source: string, scenarioFile: string, logFile: string, savedPath: string | undefined;
const commit = (cwd: string, message: string) => git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message]);
type Reply = { json?: unknown; stderr?: string; stdout?: string };
const scenario = (s: { view?: Reply; graphql?: Reply[] }) => writeFile(scenarioFile, JSON.stringify({ view: s.view ?? { stderr: "no pull requests found" }, graphql: s.graphql ?? [] }));
const calls = async () => (await readFile(logFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "flexible-worktrees-status-")));
  source = join(temp, "repo");
  scenarioFile = join(temp, "scenario.json"); logFile = join(temp, "gh.log");
  await mkdir(join(temp, "bin"));
  await writeFile(join(temp, "bin", "gh"), FAKE_GH);
  await chmod(join(temp, "bin", "gh"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${join(temp, "bin")}${delimiter}${savedPath}`;
  process.env.FAKE_GH_SCENARIO = scenarioFile; process.env.FAKE_GH_LOG = logFile;
  await mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await commit(source, "initial");
  // Never contacted: status reads only local refs and gh.
  await git(source, ["remote", "add", "origin", "https://github.com/acme/widget.git"]);
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(temp, { recursive: true, force: true });
});

const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);
function graphql(overrides: Record<string, unknown> = {}) {
  return { json: { data: { repository: { pullRequest: {
    number: 7, title: "Add widgets", url: "https://github.com/acme/widget/pull/7", state: "OPEN", isDraft: false, updatedAt: "2026-11-18T00:00:00Z",
    author: { login: "sam" }, headRefName: "widgets", baseRefName: "auth", headRefOid: "0".repeat(40), isCrossRepository: false,
    additions: 1204, deletions: 310, changedFiles: 18, allCommits: { totalCount: 7 },
    reviewDecision: "CHANGES_REQUESTED", reviewRequests: { totalCount: 1 }, comments: { totalCount: 4 },
    reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
    mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", autoMergeRequest: null, isInMergeQueue: false,
    lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/lint", checkSuite: { workflowRun: { workflow: { name: "CI" } } } },
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://ci/test", checkSuite: { workflowRun: { workflow: { name: "CI" } } } },
      { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null, detailsUrl: null, checkSuite: null },
      { __typename: "StatusContext", context: "deploy/preview", state: "SUCCESS", targetUrl: "https://preview" },
    ] } } } }] },
    stackEntry: { position: 2 },
    stack: { number: 3, size: 3, baseRefName: "main", entries: { nodes: [
      { position: 3, pullRequest: { number: 8, title: "Widget UI", url: "https://github.com/acme/widget/pull/8", state: "OPEN", isDraft: true } },
      { position: 1, pullRequest: { number: 6, title: "Auth", url: "https://github.com/acme/widget/pull/6", state: "MERGED", isDraft: false } },
      { position: 2, pullRequest: { number: 7, title: "Add widgets", url: "https://github.com/acme/widget/pull/7", state: "OPEN", isDraft: false } },
    ] } },
    ...overrides,
  } } } } };
}

it("finds a detached PR checkout from the plugin's PR ref and reads GitHub's view of it", async () => {
  const oid = await head(source);
  await git(source, ["update-ref", "refs/flexible-worktrees/pr/origin/7", oid]);
  const wt = join(temp, "pr-7");
  await git(source, ["worktree", "add", "--detach", wt, oid]);
  await scenario({ graphql: [graphql({ headRefOid: oid })] });

  const row = await prStatus({ path: wt });
  expect(row).toMatchObject({ outcome: "available", source: "pr-ref", local: { branch: null, head: oid, sync: { ahead: 0, behind: 0 } } });
  if (row.outcome !== "available") throw new Error("unreachable");
  const pr = row.pullRequest;
  expect(pr).toMatchObject({ number: 7, state: "open", additions: 1204, deletions: 310, changedFiles: 18, commits: 7, review: "changes_requested", unresolvedThreads: 1 });
  expect(pr.checks).toMatchObject({ state: "failing", failed: 1, pending: 1, passed: 2, total: 4 });
  expect(pr.checks.items.map(c => `${c.state}:${c.name}`)).toEqual(["fail:CI / test", "pending:e2e", "pass:CI / lint", "pass:deploy/preview"]);
  expect(pr.stack).toMatchObject({ number: 3, size: 3, base: "main", position: 2 });
  expect(pr.stack!.entries.map(e => `${e.position}:#${e.number}:${e.state}`)).toEqual(["1:#6:merged", "2:#7:open", "3:#8:draft"]);

  const [query] = await calls();
  expect(query).toEqual(expect.arrayContaining(["api", "graphql", "--hostname", "github.com", "owner=acme", "name=widget", "number=7"]));
  // Read-only: the PR ref and HEAD are untouched.
  expect(await git(source, ["rev-parse", "refs/flexible-worktrees/pr/origin/7"])).toBe(oid);
});

it("keeps the environment's PR after new commits on the detached head, and reports them as not on the PR", async () => {
  const prHead = await head(source);
  await git(source, ["update-ref", "refs/flexible-worktrees/pr/origin/7", prHead]);
  const wt = join(temp, "pr-7");
  await git(source, ["worktree", "add", "--detach", wt, prHead]);
  await commit(wt, "local fix");
  await scenario({ graphql: [graphql({ headRefOid: prHead })] });

  expect(await prStatus({ path: wt })).toMatchObject({ outcome: "absent" });
  expect(await calls()).toEqual([]);
  await scenario({ graphql: [graphql({ headRefOid: prHead })] });
  const row = await prStatus({ path: wt, pr: { number: 7 } });
  expect(row).toMatchObject({ outcome: "available", source: "target", local: { branch: null, sync: { ahead: 1, behind: 0 } } });
});

it("finds a branch's PR through gh, and reports a PR head this checkout hasn't fetched", async () => {
  await git(source, ["switch", "-c", "widgets"]);
  await scenario({ view: { json: { url: "https://github.com/acme/widget/pull/7", state: "OPEN", headRefOid: "f".repeat(40) } }, graphql: [graphql({ headRefOid: "f".repeat(40) })] });
  const row = await prStatus({ path: source });
  expect(row).toMatchObject({ outcome: "available", source: "branch", local: { branch: "widgets", sync: null } });
  expect((await calls())[0]).toEqual(["pr", "view", "--json", "url,state,headRefOid"]);
});

it("shows nothing for a branch without a PR or an old closed PR on the default branch", async () => {
  await scenario({ view: { stderr: "no pull requests found for branch \"main\"" } });
  expect(await prStatus({ path: source })).toMatchObject({ outcome: "absent" });
  await scenario({ view: { json: { url: "https://github.com/acme/widget/pull/1", state: "MERGED", headRefOid: "0".repeat(40) } } });
  expect(await prStatus({ path: source })).toMatchObject({ outcome: "absent" });
  expect((await calls()).every(args => args[0] === "pr")).toBe(true);
});

it("reports gh sign-in problems instead of failing", async () => {
  await git(source, ["switch", "-c", "widgets"]);
  await scenario({ view: { stderr: "To get started with GitHub CLI, please run:  gh auth login" } });
  expect(await prStatus({ path: source })).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("gh auth login") });
});

it("drops stack fields on GitHub hosts that don't have them", async () => {
  await git(source, ["remote", "set-url", "origin", "https://ghe.example.com/acme/widget.git"]);
  const oid = await head(source);
  await git(source, ["update-ref", "refs/flexible-worktrees/pr/origin/7", oid]);
  await git(source, ["checkout", "--detach"]);
  const { stack: _, stackEntry: __, ...reduced } = graphql({ headRefOid: oid }).json.data.repository.pullRequest as Record<string, unknown>;
  await scenario({ graphql: [
    { stderr: "gh: Field 'stack' doesn't exist on type 'PullRequest'", stdout: "{\"errors\":[]}" },
    { json: { data: { repository: { pullRequest: reduced } } } },
  ] });
  const row = await prStatus({ path: source });
  expect(row).toMatchObject({ outcome: "available", pullRequest: { stack: null, inMergeQueue: false } });
  const queries = (await calls()).map(args => args.find(a => a.startsWith("query="))!);
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain("stackEntry");
  // Only the rejected group is dropped.
  expect(queries[1]).not.toMatch(/stack/);
  expect(queries[1]).toContain("isInMergeQueue");
});

describe("partial clones", () => {
  afterEach(() => setGitVersionForTesting(undefined));
  async function blobless() {
    await git(source, ["config", "uploadpack.allowFilter", "true"]);
    const clone = join(temp, "blobless");
    await git(temp, ["clone", "-q", "--filter=blob:none", `file://${source}`, clone]);
    // The PR head exists only on the promisor remote.
    await commit(source, "pushed after the clone");
    const prHead = await head(source);
    await git(clone, ["switch", "-q", "-c", "widgets"]);
    await scenario({ view: { json: { url: "https://github.com/acme/widget/pull/7", state: "OPEN", headRefOid: prHead } }, graphql: [graphql({ headRefOid: prHead })] });
    const packs = async () => (await git(clone, ["count-objects", "-v"])).match(/packs: (\d+)/)![1];
    return { clone, prHead, packs, before: await packs() };
  }
  // Git 2.44 and older ignore GIT_NO_LAZY_FETCH, so the read must not touch the missing commit at all.
  it.each([["current Git", undefined], ["Git 2.44", [2, 44]]] as const)("never fetches missing objects (%s)", async (_, version) => {
    setGitVersionForTesting(version ? [...version] : undefined);
    const { clone, prHead, packs, before } = await blobless();
    // This Git honors GIT_NO_LAZY_FETCH either way, so trace commands to prove the old-Git path never reads ancestry.
    const trace = join(temp, "git-trace.log");
    process.env.GIT_TRACE = trace;
    try {
      expect(await prStatus({ path: clone })).toMatchObject({ outcome: "available", local: { branch: "widgets", sync: null } });
    } finally { delete process.env.GIT_TRACE; }
    const ancestry = (await readFile(trace, "utf8")).split("\n").filter(line => /built-in: git (rev-list|merge-base)/.test(line));
    expect(ancestry).toHaveLength(version ? 0 : 1);
    expect(await packs()).toBe(before);
    await expect(git(clone, ["cat-file", "-e", prHead], undefined, undefined, { GIT_NO_LAZY_FETCH: "1" })).rejects.toThrow();
  });
});

it("counts every page of checks, keeps the latest run of each, and trusts GitHub's rollup state", async () => {
  const oid = await head(source);
  await git(source, ["update-ref", "refs/flexible-worktrees/pr/origin/7", oid]);
  await git(source, ["checkout", "-q", "--detach"]);
  const run = (name: string, conclusion: string, startedAt: string) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion, detailsUrl: null, startedAt, checkSuite: { workflowRun: { event: "pull_request", workflow: { name: "CI" } } } });
  const rollup = (state: string, nodes: unknown[], hasNextPage: boolean) => ({ nodes: [{ commit: { statusCheckRollup: { state, contexts: { pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor1" : null }, nodes } } } }] });
  await scenario({ graphql: [
    // The first run of test failed and was re-run successfully.
    graphql({ headRefOid: oid, lastCommit: rollup("FAILURE", [run("test", "FAILURE", "2026-11-18T01:00:00Z"), run("test", "SUCCESS", "2026-11-18T02:00:00Z")], true) }),
    { json: { data: { repository: { pullRequest: { headRefOid: oid, lastCommit: rollup("FAILURE", [run("deploy", "FAILURE", "2026-11-18T01:00:00Z")], false) } } } } },
  ] });
  const row = await prStatus({ path: source });
  if (row.outcome !== "available") throw new Error(JSON.stringify(row));
  expect(row.pullRequest.checks).toMatchObject({ state: "failing", failed: 1, passed: 1, total: 2 });
  expect(row.pullRequest.checks.items.map(c => `${c.state}:${c.name}`)).toEqual(["fail:CI / deploy", "pass:CI / test"]);
  const second = (await calls())[1]!;
  expect(second).toContain("after=cursor1");
  expect(second.find(a => a.startsWith("query="))).not.toContain("reviewThreads");
  // A listed failure wins over a green rollup, so the bar is never green beside a red check.
  await writeFile(logFile, "");
  await scenario({ graphql: [graphql({ headRefOid: oid, lastCommit: rollup("SUCCESS", [run("lint", "FAILURE", "2026-11-18T01:00:00Z")], false) })] });
  const green = await prStatus({ path: source });
  expect(green.outcome === "available" && green.pullRequest.checks.state).toBe("failing");
});

it("ignores a merged PR once its reused branch has moved past it, but not right after merging", async () => {
  const merged = await head(source);
  await git(source, ["switch", "-q", "-c", "staging"]);
  const view = { json: { url: "https://github.com/acme/widget/pull/3", state: "MERGED", headRefOid: merged } };
  await scenario({ view, graphql: [graphql({ number: 3, state: "MERGED", headRefOid: merged })] });
  expect(await prStatus({ path: source })).toMatchObject({ outcome: "available", pullRequest: { number: 3, state: "merged" } });
  await commit(source, "next release");
  await scenario({ view });
  expect(await prStatus({ path: source })).toMatchObject({ outcome: "absent" });
});

it("asks gh which repository a detached PR target belongs to when several remotes have that number", async () => {
  await git(source, ["remote", "add", "upstream", "https://github.com/upstream/widget.git"]);
  const prHead = await head(source);
  for (const remote of ["origin", "upstream"]) await git(source, ["update-ref", `refs/flexible-worktrees/pr/${remote}/7`, prHead]);
  await git(source, ["checkout", "-q", "--detach"]);
  await commit(source, "local fix");
  await scenario({ view: { json: { url: "https://github.com/upstream/widget/pull/7" } }, graphql: [graphql({ headRefOid: prHead })] });
  expect(await prStatus({ path: source, pr: { number: 7 } })).toMatchObject({ outcome: "available", source: "target" });
  const [view, query] = await calls();
  expect(view).toEqual(["pr", "view", "7", "--json", "url"]);
  expect(query).toEqual(expect.arrayContaining(["owner=upstream"]));
  // With the target's remote known, gh isn't asked.
  await writeFile(logFile, "");
  await scenario({ graphql: [graphql({ headRefOid: prHead })] });
  await prStatus({ path: source, pr: { number: 7, remote: "origin" } });
  expect((await calls()).map(args => args[0])).toEqual(["api"]);
});

it("describes checks, merge blockers, and local sync for the bar", () => {
  const pr = { checks: { state: "pending", failed: 0, pending: 2, passed: 5, total: 8 }, state: "open", mergeable: "mergeable", mergeState: "BEHIND", baseRefName: "main", inMergeQueue: false } as PullRequest;
  expect(checksLabel(pr)).toEqual({ text: "2 running, 5 passed, 1 skipped", tone: "waiting" });
  expect(mergeLabel(pr)).toEqual({ text: "Behind main", tone: "bad" });
  expect(mergeLabel({ ...pr, mergeable: "conflicting" })?.text).toBe("Merge conflicts");
  expect(mergeLabel({ ...pr, state: "merged" })).toBeNull();
  expect(checksLabel({ ...pr, checks: { ...pr.checks, state: "failing" } }).text).toBe("Failing, 2 running, 5 passed, 1 skipped");
  expect(syncLabel({ branch: null, head: "a", sync: { ahead: 0, behind: 2 } }).text).toBe("2 commits behind the PR");
  expect(syncLabel({ branch: "x", head: "a", sync: { ahead: 1, behind: 1 } }).text).toBe("Diverged from the PR head: 1 local commit, 1 PR commit");
});
