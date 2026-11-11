import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, inputsSchema, rpcContract } from "./contract";
import { DEFAULT_PATH_TEMPLATE, projectOverridesSettingSchema, shortPath, templateSchema, type Inputs, type PlanResult } from "./inputs";
import { projectTemplate } from "./settings";
export { rpcContract } from "./contract";

const PROVIDER_ID = "flexible-worktrees";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    pathTemplate: {
      type: "string", label: "Worktree path template",
      description: `Complete destination, including the folder name. Blank uses ${DEFAULT_PATH_TEMPLATE}. See the template reference below.`,
      default: DEFAULT_PATH_TEMPLATE, experimental_schema: templateSchema,
    },
    projectOverrides: {
      type: "string", label: "Per-project path templates (JSON)",
      description: "Optional JSON map of project IDs or remote identities to templates. Leave {} to use the global template. Examples are below.",
      default: "{}", experimental_multiline: true, experimental_schema: projectOverridesSettingSchema,
    },
    initSubmodules: {
      type: "boolean", label: "Initialize submodules in new worktrees",
      description: "Runs git submodule update --init --recursive after creating a worktree. Failures are reported but don't stop the launch.",
      default: true,
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  type Project = Awaited<ReturnType<typeof bb.sdk.projects.get>>;
  /** The template for this project: project ID entry, most specific remote pattern, then the global setting. */
  const templateFor = async (project: Pick<Project, "id" | "gitRemoteUrl">) => projectTemplate(await settings.get(), project.id, project.gitRemoteUrl);
  /** The project's checkout on this machine (its default source first) and its destination template. */
  async function scope(projectId: string, hostId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    const sources = project.sources.filter(s => s.hostId === hostId);
    const source = sources.find(s => s.isDefault) ?? sources[0];
    if (!source) throw new Error("This project has no checkout on the selected machine");
    return { source: source.path, pathTemplate: await templateFor(project) };
  }
  /**
   * Attaching a path another provider may remove would leave this thread without files, and BB core refuses
   * to launch into a path that another provider's environment in the same project owns. Refuse both up front.
   */
  async function checkAttach(result: PlanResult, projectId: string, hostId: string) {
    if (result.plan.action !== "attach") return result;
    let envs: Awaited<ReturnType<typeof bb.sdk.environments.list>> = [];
    try { envs = await bb.sdk.environments.list({ hostId, path: result.plan.path }); } catch (error) {
      // Fail closed: attaching without knowing whether another provider may delete the path is unsafe.
      throw new Error(`Couldn’t check whether another BB environment manages \`${shortPath(result.plan.path)}\` (${message(error)}). Retry in a moment.`);
    }
    const live = envs.filter(e => e.status !== "destroyed" && e.lifecycle.phase !== "destroyed");
    if (live.some(e => (e.managed || e.workspaceProvisionType === "managed-worktree") && e.environmentProviderId !== PROVIDER_ID)) {
      throw new Error(`\`${shortPath(result.plan.path)}\` belongs to another BB environment that may remove it when its threads close. Choose that environment in the environment picker to share it.`);
    }
    // Core rejects the launch when a same-project environment here has a different provider, managed or not.
    const owner = live.find(e => e.projectId === projectId && e.environmentProviderId !== null && e.environmentProviderId !== PROVIDER_ID);
    if (owner) {
      throw new Error(`\`${shortPath(result.plan.path)}\` is owned by the "${owner.environmentProviderId}" environment provider (environment ${owner.id}). Choose that environment in the environment picker to share it, or archive its threads and delete it (\`bb environment delete ${owner.id}\`) to attach it with Flexible Worktrees.`);
    }
    return live.length
      ? { ...result, warnings: [...result.warnings, "Another BB environment already uses this checkout. To share it, choose that environment in the environment picker instead."] }
      : result;
  }
  async function preflight({ source, pathTemplate }: { source: string; pathTemplate: string }, projectId: string, hostId: string, inputs: Inputs) {
    const result = await host.call("plan", { source, inputs, pathTemplate }, { hostId, timeoutMs: 60_000 });
    return checkAttach(result, projectId, hostId);
  }

  bb.rpc.register(rpcContract, {
    async choices({ projectId, hostId }) {
      const { source, pathTemplate } = await scope(projectId, hostId);
      return { ...await host.call("choices", { source }, { hostId }), pathTemplate };
    },
    async liveBranches({ projectId, hostId }) {
      return host.call("liveBranches", { source: (await scope(projectId, hostId)).source }, { hostId, timeoutMs: 180_000 });
    },
    async pulls({ projectId, hostId }) {
      return host.call("pulls", { source: (await scope(projectId, hostId)).source }, { hostId, timeoutMs: 60_000 });
    },
    async preview({ projectId, hostId, inputs }) {
      try { return { ok: true as const, ...await preflight(await scope(projectId, hostId), projectId, hostId, inputs) }; } catch (error) {
        return { ok: false as const, error: message(error) };
      }
    },
  });

  bb.experimental_environments.register({
    id: PROVIDER_ID, displayName: "Flexible Worktrees",
    description: "Work on a PR, branch, or new task in its own worktree, or reuse a checkout. Files are always retained.",
    icon: "FolderGit", requires: { gitCheckout: true }, inputs: inputsSchema,
    policy: { retireGraceMs: null, pathKeys: "per-thread" },
    async validate(ctx) {
      // Same resolution as the picker preview, so predictable conflicts never become failed environments.
      try { await preflight({ source: ctx.projectCheckout.path, pathTemplate: await templateFor(ctx.project) }, ctx.project.id, ctx.host.id, ctx.inputs); } catch (error) {
        return { action: "refuse", message: message(error) };
      }
      return { action: "accept" };
    },
    async create(ctx) {
      const options = { hostId: ctx.host.id, signal: ctx.signal, timeoutMs: 1_800_000 };
      ctx.report.step("Resolving workspace");
      const { plan: p, warnings } = await checkAttach(await host.call("plan", {
        source: ctx.projectCheckout.path, inputs: ctx.inputs, pathTemplate: await templateFor(ctx.project),
        pathKey: ctx.pathKey, suggestedBranch: ctx.suggestedBranchName,
      }, { ...options, timeoutMs: 180_000 }), ctx.project.id, ctx.host.id);
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
