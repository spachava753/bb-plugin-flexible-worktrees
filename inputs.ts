import { z } from "zod";

// Shared with the browser: keep SDK runtime imports out of this module.
const text = z.string().trim().max(4096).refine(s => !/[\0\r\n]/.test(s), "Must be a single line");
const name = text.optional();
const location = z.object({
  root: name,
  folder: text.refine(s => !s || (s !== "." && s !== ".." && !/[\\/]/.test(s)), "Use one folder name, not a path").optional(),
}).strict().optional();

export const inputsSchema = z.discriminatedUnion("target", [
  /** Create a branch. Blank branch uses BB's suggested name; blank base uses the remote's default branch. */
  z.object({ target: z.literal("new"), branch: name, base: name, remote: name, location }).strict(),
  /** Work on a branch by name: attaches its worktree, checks it out, or fetches and tracks it. */
  z.object({
    target: z.literal("branch"), branch: text.pipe(z.string().min(1, "Choose a branch")), remote: name,
    localName: name, fastForward: z.boolean().default(true), location,
  }).strict(),
  z.object({
    target: z.literal("pr"), number: z.number().int().positive(), remote: name,
    checkout: z.enum(["detached", "branch"]).default("detached"), location,
  }).strict(),
  /** Attach an existing checkout as-is. Never mutated or owned. */
  z.object({ target: z.literal("path"), path: text.pipe(z.string().min(1, "Choose or enter a checkout path")) }).strict(),
], { error: issue => issue.code === "invalid_union" ? "Set target to new, branch, pr, or path" : undefined });
export type Inputs = z.infer<typeof inputsSchema>;
export const defaultInputs: Inputs = { target: "new" };

const fetchSchema = z.object({ remote: z.string(), from: z.string(), into: z.string(), force: z.boolean() }).strict();
export const planSchema = z.object({
  action: z.enum(["attach", "new-branch", "local-branch", "track-remote", "detached"]),
  source: z.string(),
  /** Empty only in previews whose folder depends on BB's launch-time names. */
  path: z.string(),
  /** Local branch to create or check out; empty for attach and detached. */
  branch: z.string(),
  /** Full ref or commit the worktree starts from. */
  start: z.string(),
  /** Short label for the start point shown to users, such as origin/main or PR #12. */
  startLabel: z.string(),
  fetch: fetchSchema.optional(),
  fastForward: z.object({ upstream: z.string(), fetch: fetchSchema }).strict().optional(),
  mergeBaseBranch: z.string().optional(),
}).strict();
export type Plan = z.infer<typeof planSchema>;
export const planResultSchema = z.object({ plan: planSchema, warnings: z.array(z.string()) });
export type PlanResult = z.infer<typeof planResultSchema>;
export const previewSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), plan: planSchema, warnings: z.array(z.string()) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type Preview = z.infer<typeof previewSchema>;

export const branchRowSchema = z.object({
  name: z.string(),
  /** Remote that has this branch, when it has one. */
  remote: z.string().optional(),
  local: z.boolean(),
  date: z.number(),
  worktree: z.string().optional(),
  ahead: z.number(),
  behind: z.number(),
  /** Seen only through ls-remote, not fetched yet. */
  unfetched: z.boolean().optional(),
});
export type BranchRow = z.infer<typeof branchRowSchema>;
export const worktreeSchema = z.object({ path: z.string(), branch: z.string() });
export type Worktree = z.infer<typeof worktreeSchema>;
export const choicesSchema = z.object({
  branches: z.array(branchRowSchema),
  worktrees: z.array(worktreeSchema),
  remotes: z.array(z.string()),
  defaultRemote: z.string().optional(),
  defaultBase: z.string(),
  defaultRoot: z.string(),
});
export type Choices = z.infer<typeof choicesSchema>;
export const liveBranchesSchema = z.object({ branches: z.array(z.object({ remote: z.string(), branch: z.string() })), errors: z.array(z.string()) });
export type LiveBranches = z.infer<typeof liveBranchesSchema>;
export const pullSchema = z.object({
  number: z.number(), title: z.string(), author: z.string(), head: z.string(), base: z.string(),
  fork: z.boolean(), draft: z.boolean(), updated: z.number(),
});
export type Pull = z.infer<typeof pullSchema>;
export const pullsSchema = z.object({ available: z.boolean(), message: z.string().optional(), pulls: z.array(pullSchema) });
export type Pulls = z.infer<typeof pullsSchema>;

export function shortPath(path: string) {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)|^\/home\/[^/]+(?=\/|$)/, "~");
}

/** Folder name derived from a branch: feature/x -> feature-x. */
export function slug(value: string) {
  return value.replace(/[\\/:\s]+/g, "-").replace(/[^\w.@+-]/g, "").replace(/^[-.]+|[-.]+$/g, "").replace(/-+/g, "-").slice(0, 80) || "worktree";
}
