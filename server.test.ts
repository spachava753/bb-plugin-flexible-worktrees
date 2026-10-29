import { expect, it, vi } from "vitest";
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
    create: () => provider.create({ ...base, thread: makeThreadResponse(), suggestedBranchName: "bb/test", attempt: 1, pathKey: "key", rebuild: false, previous: null, experimental_claimPath: claim, report, signal }),
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

const env = (providerId: string, managed: boolean) => ({ status: "ready", lifecycle: { phase: "active" }, managed, workspaceProvisionType: managed ? "managed-worktree" : "unmanaged", environmentProviderId: providerId });

it("refuses to attach a path another provider manages, warns when sharing, and fails closed when it can't tell", async () => {
  const attach = (method: string) => method === "plan" ? planned("attach") : { path: "/canonical/repo", log: [] };
  const managed = launch("attach", attach, () => [env("worktree", true)]);
  expect(await managed.provider.validate!(managed.base)).toEqual({ action: "refuse", message: expect.stringContaining("may remove it") });
  await expect(managed.create()).rejects.toThrow("may remove it");
  expect(managed.claim).not.toHaveBeenCalled();
  await managed.harness.lifecycle.dispose();

  const logs: string[] = [];
  const shared = launch("attach", attach, () => [env("project-checkout", false), env("flexible-worktrees", true)]);
  const created = await shared.provider.create({ ...shared.base, thread: makeThreadResponse(), suggestedBranchName: "bb/test", attempt: 1, pathKey: "key", rebuild: false, previous: null, experimental_claimPath: shared.claim, report: { step() {}, log: line => logs.push(line) }, signal });
  expect(created).toEqual(expect.objectContaining({ status: "created", ownsPath: false }));
  expect(logs.join("\n")).toContain("Another BB environment already uses this checkout");
  await shared.harness.lifecycle.dispose();

  const unknown = launch("attach", attach, () => { throw new Error("database busy"); });
  expect(await unknown.provider.validate!(unknown.base)).toEqual({ action: "refuse", message: expect.stringContaining("database busy") });
  await unknown.harness.lifecycle.dispose();
});

it("refuses at validation what preview would refuse", async () => {
  const t = launch("detached", () => { throw new Error("PR #7 wasn't found"); });
  expect(await t.provider.validate!(t.base)).toEqual({ action: "refuse", message: expect.stringContaining("PR #7 wasn't found") });
  await t.harness.lifecycle.dispose();
});

it("uses only public SDK entrypoints", async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), { allow: [/^vitest$/, /^@testing-library\//, /^react(?:-dom)?(?:\/|$)/, /^@radix-ui\//, /^@hugeicons\//, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^@\//] });
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
