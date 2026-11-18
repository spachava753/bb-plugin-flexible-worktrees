import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse, makeHostResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { inputsSchema } from "./contract";
import type { Plan } from "./inputs";

const signal = new AbortController().signal;
const report = { step() {}, log() {} };

it("registers retention policy and makes cleanup non-destructive", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "flexible-worktrees" });
  plugin(bb);
  const provider = harness.registrations.environmentProviders.get("flexible-worktrees")!;
  expect(provider.policy.retireGraceMs).toBeNull();
  expect(await provider.remove({ environment: null, hostId: null, path: null, pathKey: "key", resource: null, attempt: 1, report, signal })).toEqual({ status: "removed" });
  expect(harness.experimental_hostRpcCalls).toHaveLength(0);
  await harness.lifecycle.dispose();
});

type Envs = () => unknown[];
function launch(action: Plan["action"], hostRpc: (method: string) => unknown, envs: Envs = () => []) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "flexible-worktrees", experimental_callHostRpc: ({ method }) => hostRpc(method),
    sdk: { environments: { list: async () => envs() } } as never,
  });
  plugin(bb);
  const fixture = makeMessageDispatchHookContext();
  const claim = vi.fn(async () => true);
  const inputs = inputsSchema.parse(action === "attach" ? { target: "path", path: "/repo" } : { target: "pr", number: 7 });
  const provider = harness.registrations.environmentProviders.get("flexible-worktrees")!;
  const base = { project: fixture.project!, host: makeHostResponse(), projectCheckout: { path: "/repo", experimental_ownsPath: false }, gitRemote: null, inputs };
  return {
    harness, claim, provider, base,
    create: () => provider.create({ ...base, thread: makeThreadResponse(), suggestedBranchName: "bb/test", attempt: 1, pathKey: "key", experimental_claimPath: claim, report, signal }),
  };
}
const planned = (action: Plan["action"]): { plan: Plan; warnings: string[] } => ({
  plan: { action, source: "/repo", path: "/canonical/repo", branch: "", start: "refs/flexible-worktrees/pr/7", startLabel: "PR #7", mergeBaseBranch: "origin/main" }, warnings: [],
});

it.each(["attach", "detached"] as const)("claims the canonical path before allowing mutations (%s)", async action => {
  const t = launch(action, method => {
    if (method !== "plan") throw new Error("Must not mutate when claim failed");
    return planned(action);
  });
  t.claim.mockResolvedValue(false);
  expect((await t.create()).status).toBe("failed");
  expect(t.claim).toHaveBeenCalledWith("/canonical/repo");
  await t.harness.lifecycle.dispose();
});

it("owns created worktrees and reports the merge base, but never owns attached checkouts", async () => {
  for (const action of ["attach", "detached"] as const) {
    const t = launch(action, method => method === "plan" ? planned(action) : { path: "/canonical/repo", log: ["Copied 1 file"] });
    expect(await t.create()).toEqual({ status: "created", path: "/canonical/repo", ownsPath: action !== "attach", mergeBaseBranch: "origin/main" });
    await t.harness.lifecycle.dispose();
  }
});

const env = (providerId: string | null, managed: boolean, projectId = "other-project", id = `env_${providerId}`) => ({
  id, projectId, status: "ready", lifecycle: { phase: "active" }, managed, workspaceProvisionType: managed ? "managed-worktree" : "unmanaged", environmentProviderId: providerId,
});

it("refuses to attach a path another provider manages, warns when sharing, and fails closed when it can't tell", async () => {
  const attach = (method: string) => method === "plan" ? planned("attach") : { path: "/canonical/repo", log: [] };
  const managed = launch("attach", attach, () => [env("worktree", true)]);
  expect(await managed.provider.validate!(managed.base)).toEqual({ action: "refuse", message: expect.stringContaining("may remove it") });
  await expect(managed.create()).rejects.toThrow("may remove it");
  expect(managed.claim).not.toHaveBeenCalled();
  await managed.harness.lifecycle.dispose();

  const logs: string[] = [];
  const shared = launch("attach", attach, () => [env("project-checkout", false), env("flexible-worktrees", true)]);
  const created = await shared.provider.create({ ...shared.base, thread: makeThreadResponse(), suggestedBranchName: "bb/test", attempt: 1, pathKey: "key", experimental_claimPath: shared.claim, report: { step() {}, log: line => logs.push(line) }, signal });
  expect(created).toEqual(expect.objectContaining({ status: "created", ownsPath: false }));
  expect(logs.join("\n")).toContain("Another BB environment already uses this checkout");
  await shared.harness.lifecycle.dispose();

  const unknown = launch("attach", attach, () => { throw new Error("database busy"); });
  expect(await unknown.provider.validate!(unknown.base)).toEqual({ action: "refuse", message: expect.stringContaining("database busy") });
  await unknown.harness.lifecycle.dispose();
});

it("refuses to attach a checkout another provider's environment owns in the same project, but only warns otherwise", async () => {
  const attach = (method: string) => method === "plan" ? planned("attach") : { path: "/canonical/repo", log: [] };
  const projectId = makeMessageDispatchHookContext().project!.id;

  const owned = launch("attach", attach, () => [env("project-checkout", false, projectId, "env_kb")]);
  const refusal = await owned.provider.validate!(owned.base);
  expect(refusal).toEqual({ action: "refuse", message: expect.stringContaining('owned by the "project-checkout" environment provider (environment env_kb)') });
  expect(refusal).toEqual({ action: "refuse", message: expect.stringContaining("bb environment delete env_kb") });
  await expect(owned.create()).rejects.toThrow("project-checkout");
  expect(owned.claim).not.toHaveBeenCalled();
  await owned.harness.lifecycle.dispose();

  for (const envs of [[env("project-checkout", false, "other-project")], [env("flexible-worktrees", false, projectId)], [env(null, false, projectId)]]) {
    const logs: string[] = [];
    const t = launch("attach", attach, () => envs);
    expect(await t.provider.validate!(t.base)).toEqual({ action: "accept" });
    const created = await t.provider.create({ ...t.base, thread: makeThreadResponse(), suggestedBranchName: "bb/test", attempt: 1, pathKey: "key", experimental_claimPath: t.claim, report: { step() {}, log: line => logs.push(line) }, signal });
    expect(created).toEqual(expect.objectContaining({ status: "created", ownsPath: false }));
    expect(logs.join("\n")).toContain("Another BB environment already uses this checkout");
    await t.harness.lifecycle.dispose();
  }
});

it("restores from the previous environment's key, asking the host to reattach rather than create", async () => {
  for (const [action, instanceKey, from] of [["attach", "thr_x", "thr_x"], ["detached", "thr_x-2", "thr_x-2"], ["detached", null, "env_old"]] as const) {
    const t = launch(action, method => method === "plan" ? planned(action) : { path: "/canonical/repo", log: [] });
    // Core clears the path on destruction and hands restore a fresh pathKey.
    const environment = { id: "env_old", path: null, environmentProviderInstanceKey: instanceKey } as never;
    const result = await t.provider.restore!({ ...t.base, thread: makeThreadResponse(), attempt: 3, pathKey: "thr_x-3", previous: { environment, resource: null }, experimental_claimPath: t.claim, report, signal });
    expect(result).toEqual(expect.objectContaining({ status: "created", path: "/canonical/repo", ownsPath: action !== "attach" }));
    const calls = t.harness.experimental_hostRpcCalls;
    expect(calls.find(c => c.method === "plan")!.input).toMatchObject({ pathKey: from });
    expect(calls.find(c => c.method === "plan")!.input).not.toHaveProperty("suggestedBranch");
    expect(calls.find(c => c.method === "create")!.input).toMatchObject({ pathKey: "thr_x-3", restoreFrom: from });
    expect(t.claim).toHaveBeenCalledWith("/canonical/repo");
    await t.harness.lifecycle.dispose();
  }
});

it("refuses at validation what preview would refuse", async () => {
  const t = launch("detached", () => { throw new Error("PR #7 wasn't found"); });
  expect(await t.provider.validate!(t.base)).toEqual({ action: "refuse", message: expect.stringContaining("PR #7 wasn't found") });
  await t.harness.lifecycle.dispose();
});

it("uses the project's template and default source consistently for choices, preview, validation, and creation", async () => {
  const fixture = makeMessageDispatchHookContext();
  const host = makeHostResponse();
  const source = (id: string, path: string, isDefault: boolean) => ({ id, projectId: fixture.project!.id, hostId: host.id, isDefault, path, type: "local_path" as const, createdAt: 0, updatedAt: 0 });
  const project = { ...fixture.project!, gitRemoteUrl: "git@github.com:team/repo.git", sources: [source("other", "/other", false), source("default", "/repo", true)] };
  const plannedResult = { plan: { action: "new-branch" as const, source: "/repo", path: "/resolved/feature", branch: "feature", start: "refs/heads/main", startLabel: "main", mergeBaseBranch: "main" }, warnings: [] };
  const { bb, harness } = createFakePluginHost({
    pluginId: "flexible-worktrees",
    settings: { pathTemplate: "~/global/{branch}", projectOverrides: '{"github.com/team/*":"~/team/{repo}.{branch}"}' },
    sdk: { projects: { get: async () => project }, environments: { list: async () => [] } } as never,
    experimental_callHostRpc: async ({ method }) => {
      if (method === "choices") return { branches: [], worktrees: [], remotes: [], defaultBase: "main" };
      if (method === "plan") return plannedResult;
      if (method === "create") return { path: plannedResult.plan.path, log: [] };
      throw new Error(`Unexpected method ${method}`);
    },
  });
  plugin(bb);
  const scope = { projectId: project.id, hostId: host.id };
  const planCalls = () => harness.experimental_hostRpcCalls.filter(c => c.method === "plan");
  expect(await harness.behavior.callRpc("choices", scope)).toMatchObject({ pathTemplate: "~/team/{repo}.{branch}" });
  expect(harness.experimental_hostRpcCalls.at(-1)).toMatchObject({ hostId: host.id, input: { source: "/repo" } });
  const inputs = inputsSchema.parse({ target: "new", branch: "feature" });
  await harness.behavior.callRpc("preview", { ...scope, inputs });
  expect(planCalls().at(-1)).toMatchObject({ input: { source: "/repo", pathTemplate: "~/team/{repo}.{branch}" } });
  const provider = harness.registrations.environmentProviders.get("flexible-worktrees")!;
  const base = { project, host, projectCheckout: { path: "/repo", experimental_ownsPath: false }, gitRemote: null, inputs };
  expect(await provider.validate!(base)).toEqual({ action: "accept" });
  expect(planCalls().at(-1)).toMatchObject({ input: { pathTemplate: "~/team/{repo}.{branch}" } });
  const claim = vi.fn(async () => true);
  expect((await provider.create({ ...base, thread: makeThreadResponse(), suggestedBranchName: "bb/test", attempt: 1, pathKey: "key", experimental_claimPath: claim, report, signal })).status).toBe("created");
  expect(claim).toHaveBeenCalledWith("/resolved/feature");
  expect(planCalls().at(-1)).toMatchObject({ input: { source: "/repo", pathTemplate: "~/team/{repo}.{branch}", pathKey: "key" } });
  await harness.behavior.setSettings({ projectOverrides: JSON.stringify({ [project.id]: "~/project/{pathKey}" }) });
  expect(await harness.behavior.callRpc("choices", scope)).toMatchObject({ pathTemplate: "~/project/{pathKey}" });
  await harness.lifecycle.dispose();
});

describe("pull request status", () => {
  const prRow = (state: string, checks = "passing") => ({
    outcome: "available", source: "pr-ref", fetchedAt: 1, local: { branch: null, head: "a".repeat(40), sync: { ahead: 0, behind: 0 } },
    pullRequest: {
      number: 7, title: "Add widgets", url: "https://github.com/acme/widget/pull/7", state, author: "sam", headRefName: "widgets", baseRefName: "main",
      headRefOid: "a".repeat(40), fork: false, additions: 1, deletions: 2, changedFiles: 1, commits: 1, review: null, reviewRequests: 0,
      unresolvedThreads: 0, comments: 0, mergeable: "mergeable", mergeState: "CLEAN", autoMerge: false, inMergeQueue: false,
      checks: { state: checks, passed: 1, failed: 0, pending: 0, skipped: 0, total: 1, items: [] }, stack: null, updatedAt: "2026-11-18T00:00:00Z",
    },
  });
  const environment = (overrides: Record<string, unknown> = {}) => ({
    id: "env_pr", hostId: "host_1", path: "/worktrees/pr-7", isGitRepo: true, status: "ready", lifecycle: { phase: "active" }, hostLifecycle: "active",
    environmentProviderId: "flexible-worktrees", environmentProviderSelection: { inputs: { target: "pr", number: 7, remote: "upstream" } }, ...overrides,
  });
  function setup(env: () => unknown, status: () => unknown) {
    const { bb, harness } = createFakePluginHost({
      pluginId: "flexible-worktrees",
      sdk: { environments: { get: async () => env() } } as never,
      experimental_callHostRpc: async ({ method }) => {
        if (method !== "prStatus") throw new Error(`Unexpected method ${method}`);
        return status();
      },
    });
    const invalidate = vi.spyOn(bb.rpc, "experimental_invalidate");
    plugin(bb);
    const read = async () => (await harness.behavior.callRpc("pullRequestStatus", { keys: ["env_pr"] }) as Record<string, { outcome: string }>).env_pr!;
    return { harness, invalidate, read };
  }

  it("asks the environment's machine, passing the PR target so detached checkouts keep their PR", async () => {
    const t = setup(() => environment(), () => prRow("open"));
    expect(await t.read()).toMatchObject({ outcome: "available", pullRequest: { number: 7 } });
    expect(t.harness.experimental_hostRpcCalls).toEqual([expect.objectContaining({ method: "prStatus", hostId: "host_1", input: { path: "/worktrees/pr-7", pr: { number: 7, remote: "upstream" } } })]);
    // Cached: a second read doesn't ask again.
    await t.read();
    expect(t.harness.experimental_hostRpcCalls).toHaveLength(1);
    await t.harness.lifecycle.dispose();
  });

  it("shows nothing for environments without a live checkout, and reports unreachable machines", async () => {
    for (const env of [environment({ path: null }), environment({ status: "destroyed" }), environment({ hostLifecycle: "removed" }), environment({ isGitRepo: false })]) {
      const t = setup(() => env, () => prRow("open"));
      expect(await t.read()).toMatchObject({ outcome: "absent" });
      expect(t.harness.experimental_hostRpcCalls).toHaveLength(0);
      await t.harness.lifecycle.dispose();
    }
    const other = setup(() => environment({ environmentProviderId: "worktree", environmentProviderSelection: null }), () => prRow("open"));
    await other.read();
    expect(other.harness.experimental_hostRpcCalls[0]!.input).toEqual({ path: "/worktrees/pr-7" });
    await other.harness.lifecycle.dispose();
    const offline = setup(() => environment(), () => { throw new Error("host offline"); });
    expect(await offline.read()).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("host offline") });
    await offline.harness.lifecycle.dispose();
    const unknown = setup(() => { throw new Error("database busy"); }, () => prRow("open"));
    expect(await unknown.read()).toMatchObject({ outcome: "unavailable", message: expect.stringContaining("database busy") });
    await unknown.harness.lifecycle.dispose();
  });

  it("keeps showing the last PR, marked, when a refresh fails, until a read succeeds", async () => {
    let fail = false;
    const t = setup(() => environment(), () => {
      if (fail) return { outcome: "unavailable", message: "GitHub didn’t answer in time.", fetchedAt: 2 };
      return prRow("open");
    });
    await t.read();
    fail = true;
    await t.harness.behavior.callRpc("refreshPullRequestStatus", { environmentId: "env_pr" });
    expect(await t.read()).toMatchObject({ outcome: "available", pullRequest: { number: 7 }, fetchedAt: 1, refreshError: "GitHub didn’t answer in time." });
    expect(t.invalidate).toHaveBeenLastCalledWith(["pr-status:env_pr"]);
    fail = false;
    await t.harness.behavior.callRpc("refreshPullRequestStatus", { environmentId: "env_pr" });
    expect(await t.read()).not.toHaveProperty("refreshError");
    expect(t.harness.experimental_hostRpcCalls).toHaveLength(3);
    await t.harness.lifecycle.dispose();
  });

  it("limits how many machines one batched read asks at once", async () => {
    let running = 0, peak = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "flexible-worktrees",
      sdk: { environments: { get: async ({ environmentId }: { environmentId: string }) => environment({ id: environmentId }) } } as never,
      experimental_callHostRpc: async () => {
        peak = Math.max(peak, ++running);
        await new Promise(resolve => setTimeout(resolve, 5));
        running--;
        return prRow("open");
      },
    });
    plugin(bb);
    const keys = Array.from({ length: 12 }, (_, i) => `env_${i}`);
    expect(Object.keys(await harness.behavior.callRpc("pullRequestStatus", { keys }) as object)).toEqual(keys);
    expect(peak).toBe(4);
    await harness.lifecycle.dispose();
  });

  it("re-reads watched rows and refreshes clients only when the row changes", async () => {
    vi.useFakeTimers();
    try {
      let current = prRow("open", "pending");
      const t = setup(() => environment(), () => ({ ...current, fetchedAt: Date.now() }));
      await t.read();
      const stop = t.harness.behavior.experimental_watchRpc("pullRequestStatus", { key: "env_pr" });
      // Pending checks re-check after 20 seconds; an unchanged row doesn't refresh clients.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(t.harness.experimental_hostRpcCalls).toHaveLength(2);
      expect(t.invalidate).not.toHaveBeenCalled();
      current = prRow("open", "passing");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(t.invalidate).toHaveBeenCalledWith(["pr-status:env_pr"]);
      // Settled checks back off to a minute.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(t.harness.experimental_hostRpcCalls).toHaveLength(3);
      stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(t.harness.experimental_hostRpcCalls).toHaveLength(3);
      await t.harness.lifecycle.dispose();
    } finally { vi.useRealTimers(); }
  });
});

it("validates destination settings before saving and describes them concisely", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "flexible-worktrees" });
  plugin(bb);
  const descriptors = harness.registrations.settingsDescriptors;
  expect(Object.keys(descriptors)).toEqual(["pathTemplate", "projectOverrides", "initSubmodules", "showStatusBar"]);
  expect(descriptors.showStatusBar.default).toBe(false);
  expect(descriptors.pathTemplate.default).toBe("~/worktrees/{pathKey}");
  expect(descriptors.pathTemplate.description).toContain("Blank uses ~/worktrees/{pathKey}");
  await expect(harness.behavior.setSettings({ projectOverrides: '{"project":false}' })).rejects.toThrow();
  await expect(harness.behavior.setSettings({ pathTemplate: "{unknown}" })).rejects.toThrow();
  await harness.behavior.setSettings({ pathTemplate: "" });
  await harness.behavior.setSettings({ pathTemplate: "../{repo}.{branch}" });
  await harness.lifecycle.dispose();
});

it("uses only public SDK entrypoints", async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^vitest$/, /^@testing-library\//, /^react(?:-dom)?(?:\/|$)/, /^@radix-ui\//, /^@hugeicons\//, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^@\//] });
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
