import { z } from "zod";
import type { PluginRpcContract } from "@get-bb/plugin-sdk/app";

// Pull request status for the bar above the composer. Shared with the browser: keep SDK runtime imports out.

export const checkSchema = z.object({
  name: z.string(),
  state: z.enum(["pass", "fail", "pending", "skipped", "neutral"]),
  url: z.string().nullable(),
});
export type Check = z.infer<typeof checkSchema>;

export const stackSchema = z.object({
  number: z.number(),
  size: z.number(),
  /** The branch the whole stack targets; the PR's own base is the layer below it. */
  base: z.string(),
  /** 1 is the layer closest to the stack's base. */
  position: z.number(),
  entries: z.array(z.object({
    position: z.number(), number: z.number(), title: z.string(), url: z.string(),
    state: z.enum(["open", "draft", "merged", "closed"]),
  })),
});
export type Stack = z.infer<typeof stackSchema>;

export const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  author: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  fork: z.boolean(),
  /** GitHub's diff against the base branch, not the local one. */
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  commits: z.number(),
  review: z.enum(["approved", "changes_requested", "review_required"]).nullable(),
  reviewRequests: z.number(),
  unresolvedThreads: z.number(),
  comments: z.number(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  /** GitHub's raw mergeStateStatus, such as BEHIND, BLOCKED, CLEAN, DIRTY, or UNSTABLE. */
  mergeState: z.string(),
  autoMerge: z.boolean(),
  inMergeQueue: z.boolean(),
  checks: z.object({
    state: z.enum(["none", "pending", "passing", "failing"]),
    passed: z.number(), failed: z.number(), pending: z.number(), skipped: z.number(), total: z.number(),
    /** Failing, then pending, then the rest; capped. */
    items: z.array(checkSchema),
  }),
  stack: stackSchema.nullable(),
  updatedAt: z.string(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const localSchema = z.object({
  /** Null when HEAD is detached. */
  branch: z.string().nullable(),
  head: z.string(),
  /** Local HEAD relative to the PR head: commits only here (ahead) and only on the PR (behind). Null when the PR head isn't fetched. */
  sync: z.object({ ahead: z.number(), behind: z.number() }).nullable(),
});
export type Local = z.infer<typeof localSchema>;

/** How the PR was found: the checked-out branch, a fetched PR ref at HEAD, or the environment's PR target. */
export const sourceSchema = z.enum(["branch", "pr-ref", "target"]);
export const statusRowSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("available"), pullRequest: pullRequestSchema, local: localSchema, source: sourceSchema, fetchedAt: z.number() }),
  z.object({ outcome: z.literal("absent"), fetchedAt: z.number() }),
  z.object({ outcome: z.literal("unavailable"), message: z.string(), fetchedAt: z.number() }),
]);
export type StatusRow = z.infer<typeof statusRowSchema>;

export const STATUS_BAR_SETTING = "showStatusBar";
export const statusTag = (environmentId: string) => `pr-status:${environmentId}`;

/** Browser-safe half of the server RPC contract (defineRpcContract is the identity function). */
export const statusContract = {
  pullRequestStatus: {
    experimental_description: "Pull request status for each environment's checkout, including detached PR heads, keyed by environment id.",
    input: z.object({ keys: z.array(z.string().min(1)).max(200) }),
    output: z.record(z.string(), statusRowSchema),
    keyTags: (key: string) => [statusTag(key)],
  },
  refreshPullRequestStatus: {
    input: z.object({ environmentId: z.string().min(1) }),
    output: z.object({ ok: z.literal(true) }),
  },
} satisfies PluginRpcContract;
