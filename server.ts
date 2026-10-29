import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, inputsSchema, rpcContract } from "./contract";
import { shortPath, type Inputs, type PlanResult } from "./inputs";
export { rpcContract } from "./contract";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultRoot: {
      type: "string", label: "Default worktree parent directory ({repo} = repository name)",
      default: "~/dev/worktrees/{repo}",
    },
    initSubmodules: {
      type: "boolean", label: "Initialize submodules in new worktrees",
      description: "Runs git submodule update --init --recursive after creating a worktree. Failures are reported but don't stop the launch.",
      default: true,
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  async function sourceFor(projectId: string, hostId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find(s => s.hostId === hostId);
    if (!source) throw new Error("This project has no checkout on the selected machine");
    return source.path;
  }
  /** Attaching a path another provider may remove would leave this thread without files. */
  async function checkAttach(result: PlanResult, hostId: string) {
    if (result.plan.action !== "attach") return result;
    let envs: Awaited<ReturnType<typeof bb.sdk.environments.list>> = [];
    try { envs = await bb.sdk.environments.list({ hostId, path: result.plan.path }); } catch (error) {
      // Fail closed: attaching without knowing whether another provider may delete the path is unsafe.
      throw new Error(`Couldn’t check whether another BB environment manages \`${shortPath(result.plan.path)}\` (${message(error)}). Retry in a moment.`);
    }
    const live = envs.filter(e => e.status !== "destroyed" && e.lifecycle.phase !== "destroyed");
    if (live.some(e => (e.managed || e.workspaceProvisionType === "managed-worktree") && e.environmentProviderId !== "flexible-worktrees")) {
      throw new Error(`\`${shortPath(result.plan.path)}\` belongs to another BB environment that may remove it when its threads close. Choose that environment in the environment picker to share it.`);
    }
    return live.length
      ? { ...result, warnings: [...result.warnings, "Another BB environment already uses this checkout. To share it, choose that environment in the environment picker instead."] }
      : result;
  }
  async function preflight(source: string, hostId: string, inputs: Inputs, signal?: AbortSignal) {
    const result = await host.call("plan", { source, inputs, defaultRoot: (await settings.get()).defaultRoot }, { hostId, signal, timeoutMs: 60_000 });
    return checkAttach(result, hostId);
  }

  bb.rpc.register(rpcContract, {
    async choices({ projectId, hostId }) {
      const result = await host.call("choices", { source: await sourceFor(projectId, hostId) }, { hostId });
      return { ...result, defaultRoot: (await settings.get()).defaultRoot };
    },
    async liveBranches({ projectId, hostId }) {
      return host.call("liveBranches", { source: await sourceFor(projectId, hostId) }, { hostId, timeoutMs: 180_000 });
    },
    async pulls({ projectId, hostId }) {
      return host.call("pulls", { source: await sourceFor(projectId, hostId) }, { hostId, timeoutMs: 60_000 });
    },
    async preview({ projectId, hostId, inputs }) {
      try { return { ok: true as const, ...await preflight(await sourceFor(projectId, hostId), hostId, inputs) }; } catch (error) {
        return { ok: false as const, error: message(error) };
      }
    },
  });

  bb.experimental_environments.register({
    id: "flexible-worktrees", displayName: "Flexible Worktrees",
    description: "Work on a PR, branch, or new task in its own worktree, or reuse a checkout. Files are always retained.",
    icon: "FolderGit", requires: { gitCheckout: true }, inputs: inputsSchema,
    policy: { retireGraceMs: null, pathKeys: "per-thread" },
    async validate(ctx) {
      // Same resolution as the picker preview, so predictable conflicts never become failed environments.
      try { await preflight(ctx.projectCheckout.path, ctx.host.id, ctx.inputs); } catch (error) {
        return { action: "refuse", message: message(error) };
      }
      return { action: "accept" };
    },
    async create(ctx) {
      const options = { hostId: ctx.host.id, signal: ctx.signal, timeoutMs: 1_800_000 };
      ctx.report.step("Resolving workspace");
      const { plan: p, warnings } = await checkAttach(await host.call("plan", {
        source: ctx.projectCheckout.path, inputs: ctx.inputs,
        defaultRoot: (await settings.get()).defaultRoot,
        pathKey: ctx.pathKey, suggestedBranch: ctx.suggestedBranchName,
      }, { ...options, timeoutMs: 180_000 }), ctx.host.id);
      for (const warning of warnings) ctx.report.log(warning);
      if (!await ctx.experimental_claimPath(p.path)) return { status: "failed", message: "Another launch reserved this path. Choose a different folder or reuse its environment." };
      ctx.report.step(p.action === "attach" ? "Attaching existing checkout (no Git changes)" : `Creating worktree at ${p.path}`);
      const result = await host.call("create", { plan: p, inputs: ctx.inputs, pathKey: ctx.pathKey, initSubmodules: (await settings.get()).initSubmodules }, options);
      for (const line of result.log) ctx.report.log(line);
      return {
        status: "created", path: result.path, ownsPath: p.action !== "attach",
        ...(p.mergeBaseBranch ? { mergeBaseBranch: p.mergeBaseBranch } : {}),
      };
    },
    async remove() {
      // Intentionally non-destructive, including cancellation and explicit environment deletion.
      // User-chosen directories and branches remain available outside BB.
      return { status: "removed" };
    },
  });
}
