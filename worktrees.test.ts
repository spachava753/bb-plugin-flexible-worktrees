import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputsSchema } from "./contract";
import { choices, liveBranches } from "./worktree/choices";
import { create } from "./worktree/create";
import { git, list } from "./worktree/git";
import { repoOf } from "./worktree/github";
import { plan } from "./worktree/plan";

let temp: string, source: string, data: string;
const commit = (cwd: string, message: string) => git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message]);
beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "flexible-worktrees-test-")));
  source = join(temp, "repo"); data = join(temp, "data");
  await mkdir(source);
  await git(source, ["init", "-b", "main"]);
  await commit(source, "initial");
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

// Most tests use branch-named folders; template behavior has its own describe block.
const template = () => join(temp, "worktrees", "{repo}", "{branch}");
const resolve = (inputs: unknown, pathKey?: string, pathTemplate = template()) =>
  plan({ source, inputs: inputsSchema.parse(inputs), pathTemplate, suggestedBranch: pathKey ? "bb/test" : undefined, pathKey, dataDir: data });
/** Plan and create exactly as a launch does. */
async function launch(inputs: unknown, pathKey = "test-key") {
  const parsed = inputsSchema.parse(inputs);
  const { plan: p, warnings } = await resolve(parsed, pathKey);
  const result = await create({ plan: p, inputs: parsed, pathKey, initSubmodules: true }, data);
  return { plan: p, warnings, ...result };
}
const branchAt = (cwd: string) => git(cwd, ["branch", "--show-current"]);

async function remoteFixture() {
  const remote = join(temp, "remote.git");
  await git(temp, ["init", "--bare", "-b", "main", remote]);
  await git(source, ["remote", "add", "origin", remote]);
  await git(source, ["push", "-u", "origin", "main"]);
  return remote;
}
/** A second clone standing in for a teammate or another machine. */
async function teammate(remote: string) {
  const other = join(temp, "teammate");
  await git(temp, ["clone", "-q", remote, other]);
  return other;
}

describe("new branch", () => {
  it("names the folder after the branch, starts from the default branch, and retries without losing edits", async () => {
    const r = await launch({ target: "new", branch: "feature/custom" });
    expect(r.path).toBe(join(temp, "worktrees", "repo", "feature-custom"));
    expect(r.plan.mergeBaseBranch).toBe("main");
    await writeFile(join(r.path, "keep.txt"), "uncommitted");
    await launch({ target: "new", branch: "feature/custom" });
    expect(await readFile(join(r.path, "keep.txt"), "utf8")).toBe("uncommitted");
    expect(await branchAt(r.path)).toBe("feature/custom");
  });
  it("uses BB's suggested name when blank and suffixes colliding folders", async () => {
    await mkdir(join(temp, "worktrees", "repo", "bb-test"), { recursive: true });
    const r = await launch({ target: "new" });
    expect(r.path).toBe(join(temp, "worktrees", "repo", "bb-test-2"));
    expect(await branchAt(r.path)).toBe("bb/test");
  });
  it("retries reuse the first attempt's folder instead of re-suffixing past it", async () => {
    const first = await launch({ target: "new", branch: "x" });
    const again = await launch({ target: "new", branch: "x" });
    expect(again.path).toBe(first.path);
  });
  it("starts from the fetched remote default branch without setting an upstream", async () => {
    const remote = await remoteFixture();
    const other = await teammate(remote);
    await commit(other, "newer main");
    await git(other, ["push", "origin", "main"]);
    const r = await launch({ target: "new", branch: "fresh" });
    expect(r.plan.startLabel).toBe("origin/main");
    expect(r.plan.mergeBaseBranch).toBe("origin/main");
    expect(await git(r.path, ["log", "-1", "--format=%s"])).toBe("newer main");
    await expect(git(r.path, ["rev-parse", "--abbrev-ref", "@{upstream}"])).rejects.toThrow();
  });
  it("falls back to the last fetched base when the remote is unreachable", async () => {
    await remoteFixture();
    await git(source, ["remote", "set-url", "origin", join(temp, "gone.git")]);
    const r = await launch({ target: "new", branch: "offline" });
    expect(r.log.join("\n")).toContain("last fetched");
    expect(await branchAt(r.path)).toBe("offline");
  });
  it("asks the remote for its default branch when it was never fetched", async () => {
    const remote = join(temp, "remote.git");
    await git(temp, ["init", "--bare", "-b", "trunk", remote]);
    await git(source, ["push", remote, "main:refs/heads/trunk"]);
    await git(source, ["remote", "add", "origin", remote]);
    const r = await launch({ target: "new", branch: "fresh" });
    expect(r.plan.startLabel).toBe("origin/trunk");
    expect(r.plan.mergeBaseBranch).toBe("origin/trunk");
    await git(source, ["remote", "set-url", "origin", join(temp, "gone.git")]);
    await git(source, ["update-ref", "-d", "refs/remotes/origin/trunk"]);
    const offline = await resolve({ target: "new", branch: "other" });
    expect(offline.plan.startLabel).toBe("main");
    expect(offline.warnings.join()).toContain("default branch");
  });
  it("accepts a remote-qualified base that hasn't been fetched yet", async () => {
    const remote = await remoteFixture();
    const other = await teammate(remote);
    await git(other, ["push", "origin", "main:refs/heads/release-next"]);
    const r = await launch({ target: "new", branch: "hotfix", base: "origin/release-next" });
    expect(r.plan.startLabel).toBe("origin/release-next");
    expect(await git(source, ["rev-parse", "--verify", "refs/remotes/origin/release-next"])).toBeTruthy();
  });
  it("rejects wildcard bases and pins relative bases to a commit for the diff", async () => {
    await remoteFixture();
    await expect(resolve({ target: "new", branch: "t", base: "origin/*" })).rejects.toThrow("Unknown base");
    await commit(source, "second");
    const r = await resolve({ target: "new", branch: "t", base: "HEAD~1" });
    const oid = await git(source, ["rev-parse", "HEAD~1"]);
    expect(r.plan.start).toBe(oid);
    expect(r.plan.mergeBaseBranch).toBe(oid);
  });
  it("supports stacked bases and refuses existing names", async () => {
    await git(source, ["branch", "parent"]);
    expect((await resolve({ target: "new", branch: "child", base: "parent" })).plan.mergeBaseBranch).toBe("parent");
    await expect(resolve({ target: "new", branch: "parent" })).rejects.toThrow("already exists");
    await expect(resolve({ target: "new", base: "nope" })).rejects.toThrow("Unknown base");
  });
});

describe("branch by name", () => {
  it("attaches the worktree that already has the branch, without Git changes", async () => {
    await writeFile(join(source, "dirty"), "keep");
    const r = await launch({ target: "branch", branch: "main" });
    expect(r.plan.action).toBe("attach");
    expect(r.path).toBe(source);
    expect(await readFile(join(source, "dirty"), "utf8")).toBe("keep");
  });
  it("matches branch names exactly, not as prefixes of nested branches", async () => {
    await git(source, ["branch", "feature/login"]);
    await expect(resolve({ target: "branch", branch: "feature" })).rejects.toThrow("no remote");
    await git(source, ["switch", "feature/login"]);
    await expect(resolve({ target: "branch", branch: "feature" })).rejects.toThrow("no remote");
  });
  it("checks out a free local branch", async () => {
    await git(source, ["branch", "existing"]);
    const r = await launch({ target: "branch", branch: "existing" });
    expect(await branchAt(r.path)).toBe("existing");
    expect(r.path).toBe(join(temp, "worktrees", "repo", "existing"));
  });
  it("fetches and tracks a branch that only exists on the remote", async () => {
    const remote = await remoteFixture();
    const other = await teammate(remote);
    await git(other, ["switch", "-c", "colleague/review"]);
    await commit(other, "review me");
    await git(other, ["push", "origin", "colleague/review"]);
    const preview = await resolve({ target: "branch", branch: "colleague/review" });
    expect(preview.plan.action).toBe("track-remote");
    await expect(git(source, ["rev-parse", "--verify", "refs/remotes/origin/colleague/review"])).rejects.toThrow();
    const r = await launch({ target: "branch", branch: "colleague/review" });
    expect(await git(r.path, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("origin/colleague/review");
    expect(r.plan.mergeBaseBranch).toBe("origin/main");
  });
  it("fast-forwards a stale local branch by default and never rewinds diverged work", async () => {
    const remote = await remoteFixture();
    await git(source, ["branch", "--track", "mine", "origin/main"]);
    await git(source, ["push", "origin", "mine"]);
    await git(source, ["branch", "--set-upstream-to=origin/mine", "mine"]);
    const other = await teammate(remote);
    await git(other, ["switch", "mine"]);
    await commit(other, "from laptop");
    await git(other, ["push", "origin", "mine"]);
    const r = await launch({ target: "branch", branch: "mine" });
    expect(await git(r.path, ["log", "-1", "--format=%s"])).toBe("from laptop");
    expect(r.log.join("\n")).toContain("Fast-forwarded");

    await git(source, ["branch", "--track", "diverged", "origin/main"]);
    await git(source, ["push", "origin", "diverged"]);
    await git(source, ["branch", "--set-upstream-to=origin/diverged", "diverged"]);
    await git(other, ["fetch", "origin"]); await git(other, ["switch", "diverged"]);
    await commit(other, "remote side"); await git(other, ["push", "origin", "diverged"]);
    const local = join(temp, "local-side");
    await git(source, ["worktree", "add", local, "diverged"]); await commit(local, "local side"); await git(source, ["worktree", "remove", local]);
    const d = await launch({ target: "branch", branch: "diverged" }, "diverged-key");
    expect(await git(d.path, ["log", "-1", "--format=%s"])).toBe("local side");
    // Unpushed local commits mean no fast-forward is even planned; the preview says so.
    expect(d.plan.fastForward).toBeUndefined();
    expect(d.warnings.join("\n")).toContain("unpushed commit");
  });
  it("finishes an interrupted fast-forward when the launch is retried", async () => {
    const remote = await remoteFixture();
    await git(source, ["push", "origin", "main:refs/heads/mine"]);
    await git(source, ["fetch", "origin"]);
    await git(source, ["branch", "--track", "mine", "origin/mine"]);
    const other = await teammate(remote);
    await git(other, ["switch", "mine"]); await commit(other, "newer"); await git(other, ["push", "origin", "mine"]);
    const r = await launch({ target: "branch", branch: "mine" });
    expect(await git(r.path, ["log", "-1", "--format=%s"])).toBe("newer");
    // Simulate an interruption after checkout: the branch is still old and provisioning never finished.
    await git(r.path, ["reset", "--hard", "-q", "HEAD~1"]);
    const receipts = join(data, "receipts");
    const [file] = await readdir(receipts);
    const receipt = JSON.parse(await readFile(join(receipts, file!), "utf8"));
    await writeFile(join(receipts, file!), JSON.stringify({ ...receipt, provisioned: false }));
    const retried = await launch({ target: "branch", branch: "mine" });
    expect(await git(r.path, ["log", "-1", "--format=%s"])).toBe("newer");
    expect(retried.log.join("\n")).toContain("Fast-forwarded");
  });
  it("leaves the branch alone when fast-forward is off", async () => {
    const remote = await remoteFixture();
    await git(source, ["push", "origin", "main:refs/heads/mine"]);
    await git(source, ["fetch", "origin"]);
    await git(source, ["branch", "--track", "mine", "origin/mine"]);
    const other = await teammate(remote);
    await git(other, ["switch", "mine"]); await commit(other, "newer"); await git(other, ["push", "origin", "mine"]);
    const r = await launch({ target: "branch", branch: "mine", fastForward: false });
    expect(await git(r.path, ["log", "-1", "--format=%s"])).toBe("initial");
  });
  it("needs a different local name when a same-named local branch tracks something else", async () => {
    await remoteFixture();
    await git(source, ["push", "origin", "main:refs/heads/shared"]);
    await git(source, ["fetch", "origin"]);
    await git(source, ["branch", "--no-track", "shared"]);
    await expect(resolve({ target: "branch", branch: "shared", remote: "origin" })).rejects.toThrow("different local name");
    const r = await launch({ target: "branch", branch: "shared", remote: "origin", localName: "shared-review" });
    expect(await git(r.path, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("origin/shared");
  });
  it("rejects unknown remotes, malformed names, and branches that exist nowhere", async () => {
    await remoteFixture();
    await expect(resolve({ target: "branch", branch: "main", remote: "--upload-pack=bad" })).rejects.toThrow("configured Git remote");
    await expect(resolve({ target: "branch", branch: "bad:ref" })).rejects.toThrow("valid branch");
    await expect(resolve({ target: "branch", branch: "missing" })).rejects.toThrow("doesn't exist");
    expect(await list(source)).toHaveLength(1);
  });
});

describe("pull requests", () => {
  it("creates a detached worktree from the PR ref and re-reviews into a new folder", async () => {
    const remote = await remoteFixture();
    const other = await teammate(remote);
    await git(other, ["switch", "-c", "fork-work"]); await commit(other, "pr head");
    await git(other, ["push", "origin", "fork-work:refs/pull/7/head"]);
    const r = await launch({ target: "pr", number: 7 });
    expect(r.plan.action).toBe("detached");
    expect(await git(r.path, ["log", "-1", "--format=%s"])).toBe("pr head");
    await expect(git(r.path, ["symbolic-ref", "-q", "HEAD"])).rejects.toThrow();
    expect(await git(source, ["for-each-ref", "refs/heads"])).not.toContain("fork-work");
    await commit(other, "pr update"); await git(other, ["push", "-f", "origin", "fork-work:refs/pull/7/head"]);
    expect(await git(source, ["for-each-ref", "--format=%(refname)", "refs/flexible-worktrees"])).toBe("refs/flexible-worktrees/pr/origin/7");
    const again = await launch({ target: "pr", number: 7 }, "second-key");
    expect(again.path).toBe(`${r.path}-2`);
    expect(await git(again.path, ["log", "-1", "--format=%s"])).toBe("pr update");
  });
});

describe("existing checkouts and safety", () => {
  it("attaches dirty checkouts by path without switching branches", async () => {
    await writeFile(join(source, "keep"), "dirty");
    expect((await launch({ target: "path", path: source })).path).toBe(source);
    expect(await branchAt(source)).toBe("main");
    expect(await readFile(join(source, "keep"), "utf8")).toBe("dirty");
  });
  it("never adopts or overwrites a pre-existing destination, even if empty", async () => {
    const dest = join(temp, "worktrees", "repo", "taken");
    await mkdir(dest, { recursive: true });
    await expect(resolve({ target: "new", location: { folder: "taken" } })).rejects.toThrow("already exists");
    const p = (await resolve({ target: "new", branch: "taken" }, "k")).plan;
    expect(p.path).toBe(`${dest}-2`);
  });
  it("rejects folder traversal, relative roots, option-like branches, and subdirectories", async () => {
    expect(inputsSchema.safeParse({ target: "new", location: { folder: "../escape" } }).success).toBe(false);
    expect(inputsSchema.safeParse({ mode: "new-branch" }).success).toBe(false);
    await expect(resolve({ target: "new", location: { root: "relative" } })).rejects.toThrow("absolute");
    await expect(resolve({ target: "new", branch: "--force" })).rejects.toThrow("valid branch");
    await mkdir(join(source, "nested"));
    await expect(resolve({ target: "path", path: join(source, "nested") })).rejects.toThrow("root");
  });
  it("canonicalizes symlinked parents before claiming a path", async () => {
    await mkdir(join(temp, "real")); await symlink(join(temp, "real"), join(temp, "alias"));
    expect((await resolve({ target: "new", location: { root: join(temp, "alias"), folder: "chosen" } })).plan.path).toBe(join(temp, "real", "chosen"));
  });
  it("refuses to reuse a reserved path that now holds a different repository", async () => {
    const inputs = inputsSchema.parse({ target: "new", branch: "moved" });
    const { plan: p } = await resolve(inputs, "k");
    await create({ plan: p, inputs, pathKey: "k", initSubmodules: true }, data);
    await rm(p.path, { recursive: true, force: true });
    await git(temp, ["clone", "-q", source, p.path]);
    await git(p.path, ["switch", "-c", "moved"]);
    await expect(create({ plan: p, inputs, pathKey: "k", initSubmodules: true }, data)).rejects.toThrow("no longer matches");
  });
  it("refuses to reuse a reserved path redirected to another checkout of the same repository", async () => {
    const inputs = inputsSchema.parse({ target: "new", branch: "redirected" });
    const { plan: p } = await resolve(inputs, "k");
    await create({ plan: p, inputs, pathKey: "k", initSubmodules: true }, data);
    await rm(p.path, { recursive: true, force: true });
    await symlink(source, p.path);
    await expect(create({ plan: p, inputs, pathKey: "k", initSubmodules: true }, data)).rejects.toThrow("no longer matches");
    expect(await branchAt(source)).toBe("main");
  });
  it("refuses changed inputs for a launch that already reserved a worktree", async () => {
    const r = await launch({ target: "new", branch: "first" });
    await expect(resolve({ target: "new", branch: "second" }, "test-key")).rejects.toThrow("different worktree");
    await expect(create({ plan: { ...r.plan, path: join(temp, "elsewhere") }, inputs: inputsSchema.parse({ target: "new", branch: "first" }), pathKey: "test-key", initSubmodules: true }, data)).rejects.toThrow("different worktree");
    expect(await branchAt(r.path)).toBe("first");
  });
  it("honors cancellation before mutating", async () => {
    const inputs = inputsSchema.parse({ target: "new", branch: "x" });
    const { plan: p } = await resolve(inputs, "k");
    await expect(create({ plan: p, inputs, pathKey: "k", initSubmodules: true }, data, AbortSignal.abort())).rejects.toThrow();
    expect(await list(source)).toHaveLength(1);
  });
});

describe("provisioning", () => {
  it("copies .worktreeinclude matches without replacing files or following symlinks, once", async () => {
    await writeFile(join(source, ".gitignore"), ".env*\nlink\ncerts/\n");
    await writeFile(join(source, ".worktreeinclude"), ".env\n.env.*\n!.env.example\nlink\ncerts/\n");
    await git(source, ["add", ".gitignore", ".worktreeinclude"]); await commit(source, "include");
    await writeFile(join(source, ".env"), "secret");
    await writeFile(join(source, ".env.example"), "example");
    await mkdir(join(source, "certs")); await writeFile(join(source, "certs", "k.pem"), "pem");
    await symlink("/etc/hostname", join(source, "link"));
    const r = await launch({ target: "new", branch: "inc" });
    expect(await readFile(join(r.path, ".env"), "utf8")).toBe("secret");
    expect(await readFile(join(r.path, "certs", "k.pem"), "utf8")).toBe("pem");
    await expect(readFile(join(r.path, ".env.example"))).rejects.toThrow();
    await expect(readFile(join(r.path, "link"))).rejects.toThrow();
    expect(r.log.join("\n")).toContain("Copied 2 files");
    await writeFile(join(r.path, ".env"), "edited by agent");
    await launch({ target: "new", branch: "inc" });
    expect(await readFile(join(r.path, ".env"), "utf8")).toBe("edited by agent");
  });
  it("initializes submodules, and reports failures without failing the launch", async () => {
    const lib = join(temp, "lib");
    await mkdir(lib); await git(lib, ["init", "-b", "main"]); await commit(lib, "lib");
    await git(source, ["-c", "protocol.file.allow=always", "submodule", "add", lib, "lib"]); await commit(source, "submodule");
    const prev = process.env.GIT_CONFIG_PARAMETERS;
    process.env.GIT_CONFIG_PARAMETERS = "'protocol.file.allow'='always'";
    try {
      const r = await launch({ target: "new", branch: "sub" });
      expect(await git(join(r.path, "lib"), ["log", "-1", "--format=%s"])).toBe("lib");
    } finally { if (prev === undefined) delete process.env.GIT_CONFIG_PARAMETERS; else process.env.GIT_CONFIG_PARAMETERS = prev; }
    await rm(lib, { recursive: true, force: true });
    await rm(join(source, ".git", "modules"), { recursive: true, force: true });
    const broken = await launch({ target: "new", branch: "sub-broken" }, "broken-key");
    expect(broken.log.join("\n")).toContain("Submodules not initialized");
  });
});

it("lists merged local/remote branch rows and discovers unfetched heads without changing refs", async () => {
  const remote = await remoteFixture();
  const other = await teammate(remote);
  await git(other, ["push", "origin", "main:refs/heads/fetched", "main:refs/heads/unfetched"]);
  await git(source, ["fetch", "origin", "fetched:refs/remotes/origin/fetched"]);
  await git(source, ["remote", "add", "offline", join(temp, "missing.git")]);
  const c = await choices(source);
  expect(c.defaultBase).toBe("origin/main");
  expect(c.branches.filter(b => b.name === "main")).toEqual([expect.objectContaining({ local: true, remote: "origin", worktree: source })]);
  expect(c.branches).toContainEqual(expect.objectContaining({ name: "fetched", remote: "origin", local: false }));
  const live = await liveBranches(source);
  expect(live.branches).toContainEqual({ remote: "origin", branch: "unfetched" });
  expect(live.errors).toEqual([expect.stringContaining("offline")]);
  await expect(git(source, ["rev-parse", "--verify", "refs/remotes/origin/unfetched"])).rejects.toThrow();
});

it("derives gh --repo identities from remote URLs", () => {
  expect(repoOf("git@github.com:owner/name.git")).toBe("github.com/owner/name");
  expect(repoOf("https://github.com/owner/name")).toBe("github.com/owner/name");
  expect(repoOf("ssh://git@ghe.example.com:2222/owner/name.git")).toBe("ghe.example.com/owner/name");
  expect(repoOf("https://gitlab.com/group/sub/name.git")).toBeUndefined();
  expect(repoOf("/srv/git/name.git")).toBeUndefined();
});

describe("path templates", () => {
  const at = (...parts: string[]) => join(temp, ...parts);
  it("names folders by launch key, or as checkout siblings by sanitized branch", async () => {
    expect((await resolve({ target: "new", branch: "x" }, "thr_abc", at("wt", "{pathKey}"))).plan.path).toBe(at("wt", "thr_abc"));
    expect((await resolve({ target: "new", branch: "feature/login" }, "k", "{checkoutParent}/{repo}.{branch}")).plan.path).toBe(at("repo.feature-login"));
    expect((await resolve({ target: "new", branch: "feature/login" }, "k", "../{repo}.{branch}")).plan.path).toBe(at("repo.feature-login"));
    expect((await resolve({ target: "new", branch: "x" }, "k", "{repoPath}/.worktrees/{branch}")).plan.path).toBe(join(source, ".worktrees", "x"));
  });
  it("uses the primary checkout's name for {repo} when the source is a linked worktree", async () => {
    const linked = at("linked");
    await git(source, ["worktree", "add", "-q", "-b", "side", linked]);
    const r = await plan({ source: linked, inputs: inputsSchema.parse({ target: "new", branch: "y" }), pathTemplate: at("wt", "{repo}", "{branch}"), pathKey: "k", suggestedBranch: "bb/test" });
    expect(r.plan.path).toBe(at("wt", "repo", "y"));
  });
  it("shows placeholders for names BB assigns at launch, and requires them at launch", async () => {
    expect((await resolve({ target: "new" }, undefined, at("wt", "{repo}", "{branch}"))).plan.path).toBe(at("wt", "repo", "<automatic branch>"));
    expect((await resolve({ target: "new", branch: "x" }, undefined, at("wt", "{pathKey}"))).plan.path).toBe(at("wt", "<automatic folder>"));
    await expect(plan({ source, inputs: inputsSchema.parse({ target: "new" }), pathTemplate: at("wt", "{branch}"), pathKey: "k" })).rejects.toThrow("unresolved");
  });
  it("lets the thread override the templated parent and the folder independently", async () => {
    const tpl = at("wt", "{repo}.{branch}");
    expect((await resolve({ target: "new", branch: "x", location: { root: "{checkoutParent}/custom" } }, "k", tpl)).plan.path).toBe(at("custom", "repo.x"));
    expect((await resolve({ target: "new", branch: "x", location: { folder: "chosen" } }, "k", tpl)).plan.path).toBe(at("wt", "chosen"));
    await expect(resolve({ target: "new", branch: "x", location: { root: "relative/{repo}" } }, "k", tpl)).rejects.toThrow("absolute");
  });
  it("keeps the template's folder when the thread's folder override is blank", async () => {
    for (const folder of ["", "   "]) {
      expect((await resolve({ target: "new", branch: "x", location: { folder } }, "thr_abc", at("wt", "{pathKey}"))).plan.path).toBe(at("wt", "thr_abc"));
    }
  });
  it("validates the folder name after expansion", async () => {
    await expect(resolve({ target: "new", branch: "x" }, "k", at("wt", "back\\slash"))).rejects.toThrow("Invalid folder name");
  });
  it("rejects templates without a folder or with unknown variables", async () => {
    await expect(resolve({ target: "new", branch: "x" }, "k", `${at("wt")}/..`)).rejects.toThrow("folder name");
    await expect(resolve({ target: "new", branch: "x" }, "k", at("wt", "{unknown}"))).rejects.toThrow();
  });
});
