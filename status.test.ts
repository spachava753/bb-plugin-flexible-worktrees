import { afterEach, beforeEach, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { git } from "./worktree/git";
import { prStatus } from "./worktree/status";
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
    lastCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 4, nodes: [
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
  await scenario({ view: { json: { url: "https://github.com/acme/widget/pull/7", state: "OPEN", headRefName: "widgets" } }, graphql: [graphql({ headRefOid: "f".repeat(40) })] });
  const row = await prStatus({ path: source });
  expect(row).toMatchObject({ outcome: "available", source: "branch", local: { branch: "widgets", sync: null } });
  expect((await calls())[0]).toEqual(["pr", "view", "--json", "url,state,headRefName"]);
});

it("shows nothing for a branch without a PR or an old closed PR on the default branch", async () => {
  await scenario({ view: { stderr: "no pull requests found for branch \"main\"" } });
  expect(await prStatus({ path: source })).toMatchObject({ outcome: "absent" });
  await scenario({ view: { json: { url: "https://github.com/acme/widget/pull/1", state: "MERGED", headRefName: "main" } } });
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
  const { stack: _, stackEntry: __, isInMergeQueue: ___, ...reduced } = graphql({ headRefOid: oid }).json.data.repository.pullRequest as Record<string, unknown>;
  await scenario({ graphql: [
    { stderr: "gh: Field 'stack' doesn't exist on type 'PullRequest'", stdout: "{\"errors\":[]}" },
    { json: { data: { repository: { pullRequest: reduced } } } },
  ] });
  const row = await prStatus({ path: source });
  expect(row).toMatchObject({ outcome: "available", pullRequest: { stack: null, inMergeQueue: false } });
  const queries = (await calls()).map(args => args.find(a => a.startsWith("query="))!);
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain("stackEntry");
  expect(queries[1]).not.toMatch(/stack|isInMergeQueue/);
});

it("describes checks, merge blockers, and local sync for the bar", () => {
  const pr = { checks: { state: "pending", failed: 0, pending: 2, passed: 5, total: 8 }, state: "open", mergeable: "mergeable", mergeState: "BEHIND", baseRefName: "main", inMergeQueue: false } as PullRequest;
  expect(checksLabel(pr)).toEqual({ text: "2 running, 5 passed, 1 skipped", tone: "waiting" });
  expect(mergeLabel(pr)).toEqual({ text: "Behind main", tone: "bad" });
  expect(mergeLabel({ ...pr, mergeable: "conflicting" })?.text).toBe("Merge conflicts");
  expect(mergeLabel({ ...pr, state: "merged" })).toBeNull();
  expect(syncLabel({ branch: null, head: "a", sync: { ahead: 0, behind: 2 } }).text).toBe("Detached HEAD is 2 commits behind the PR");
  expect(syncLabel({ branch: "x", head: "a", sync: { ahead: 1, behind: 1 } }).text).toBe("`x` diverged from the PR head: 1 local commit, 1 PR commit");
});
