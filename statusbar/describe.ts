import type { Local, PullRequest } from "../status";

// The bar's copy and status model, kept pure so it is easy to test and reason about.

export type Tone = "good" | "bad" | "waiting" | "muted" | "merged";
/** One status line: an icon and title in the tone's color, and optional muted detail. */
export type Status = { icon: string; tone: Tone; title: string; detail?: string };

export const formatCount = (n: number) => n.toLocaleString("en-US");
export const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

export const STATE: Record<PullRequest["state"], { label: string; icon: string; tone: Tone }> = {
  open: { label: "Open", icon: "GitPullRequestArrow", tone: "good" },
  draft: { label: "Draft", icon: "GitPullRequestDraft", tone: "muted" },
  merged: { label: "Merged", icon: "GitMerge", tone: "merged" },
  closed: { label: "Closed", icon: "GitPullRequestClosed", tone: "bad" },
};
export const TONE: Record<Tone, string> = {
  good: "text-success-foreground", bad: "text-destructive-text", waiting: "text-warning", muted: "text-muted-foreground", merged: "text-pr-merged",
};
const isOpen = (pr: PullRequest) => pr.state === "open" || pr.state === "draft";

export function checksStatus({ checks }: PullRequest): Status {
  const { state, failed, pending, passed, total } = checks;
  const skipped = total - failed - pending - passed;
  const rest = [passed && `${formatCount(passed)} passed`, skipped && `${formatCount(skipped)} skipped`];
  const join = (parts: (string | 0 | false)[]) => parts.filter(Boolean).join(" · ") || undefined;
  switch (state) {
    case "none": return { icon: "Circle", tone: "muted", title: "No checks" };
    // GitHub's rollup sets the state, so a failure or run beyond the listed checks still shows without a count.
    case "failing": return {
      icon: "CircleX", tone: "bad", title: failed ? `${plural(failed, "check")} failing` : "Checks failing",
      detail: join([pending && `${formatCount(pending)} running`, ...rest]),
    };
    case "pending": return { icon: "Clock", tone: "waiting", title: pending ? `${plural(pending, "check")} running` : "Checks running", detail: join(rest) };
    default: return { icon: "CircleCheck", tone: "good", title: "All checks passed", detail: join([total > 0 && plural(total, "check")]) };
  }
}

export function reviewStatus(pr: PullRequest): Status {
  const detail = [
    pr.unresolvedThreads > 0 && `${formatCount(pr.unresolvedThreads)} unresolved`,
    pr.comments > 0 && plural(pr.comments, "comment"),
  ].filter(Boolean).join(" · ") || undefined;
  if (pr.review === "approved") return { icon: "CircleCheck", tone: "good", title: "Approved", detail };
  if (pr.review === "changes_requested") return { icon: "CircleX", tone: "bad", title: "Changes requested", detail };
  if (!isOpen(pr)) return { icon: "Circle", tone: "muted", title: "Not reviewed", detail };
  if (pr.reviewRequests) return { icon: "Clock", tone: "waiting", title: `Waiting on ${plural(pr.reviewRequests, "reviewer")}`, detail };
  if (pr.review === "review_required") return { icon: "Circle", tone: "waiting", title: "Review required", detail };
  return { icon: "Circle", tone: "muted", title: "No review required", detail };
}

/** What stands between the PR and merging. */
export function mergeStatus(pr: PullRequest): Status {
  if (pr.state === "merged") return { icon: "GitMerge", tone: "merged", title: "Merged" };
  if (pr.state === "closed") return { icon: "GitPullRequestClosed", tone: "bad", title: "Closed without merging" };
  if (pr.inMergeQueue) return { icon: "Clock", tone: "waiting", title: "In the merge queue" };
  const detail = pr.autoMerge ? "Auto-merge on" : undefined;
  if (pr.mergeable === "conflicting" || pr.mergeState === "DIRTY") return { icon: "CircleX", tone: "bad", title: "Merge conflicts", detail };
  if (pr.state === "draft") return { icon: "GitPullRequestDraft", tone: "muted", title: "Draft", detail: "Mark ready to merge" };
  switch (pr.mergeState) {
    case "BEHIND": return { icon: "ArrowDown", tone: "waiting", title: `Behind ${pr.baseRefName}`, detail: detail ?? "Update the branch to merge" };
    // Usually a consequence of the checks or review above, so it informs rather than alarms.
    case "BLOCKED": return { icon: "Lock", tone: "muted", title: "Merging is blocked", detail: detail ?? "Branch rules not met" };
    case "UNSTABLE": return { icon: "CircleCheck", tone: "waiting", title: "Mergeable, checks not passing", detail };
    case "CLEAN": case "HAS_HOOKS": return { icon: "CircleCheck", tone: "good", title: "Ready to merge", detail };
    default: return { icon: "Clock", tone: "muted", title: "Checking mergeability", detail };
  }
}

/** The local checkout relative to the PR head on GitHub. */
export function syncStatus(local: Local): Status {
  const detached = local.branch ? undefined : "Detached";
  if (!local.sync) return { icon: "Clock", tone: "waiting", title: "PR head not fetched here", detail: detached };
  const { ahead, behind } = local.sync;
  if (!ahead && !behind) return { icon: "CircleCheck", tone: "good", title: "In sync with the PR", detail: detached };
  if (ahead && behind) return { icon: "CircleX", tone: "bad", title: "Diverged from the PR", detail: `${formatCount(ahead)} local, ${formatCount(behind)} on the PR` };
  if (ahead) return { icon: "ArrowUp", tone: "waiting", title: `${plural(ahead, "commit")} not on the PR`, detail: local.branch ? "Push to update it" : detached };
  return { icon: "ArrowDown", tone: "waiting", title: `${plural(behind, "commit")} behind the PR`, detail: detached };
}
export const inSync = (local: Local) => !!local.sync && !local.sync.ahead && !local.sync.behind;

/** Which status the headline is, so the bar can skip the glyph or line that would repeat it. */
export type Headline = Status & { kind: "state" | "checks" | "review" | "merge" };

/**
 * The single most important thing about the PR right now, for the collapsed bar: what blocks it, what it waits on,
 * or that it's ready. Ordered the way a developer would act on it.
 */
export function headline(pr: PullRequest): Headline {
  if (pr.state === "merged") return { icon: STATE.merged.icon, tone: "merged", title: "Merged", kind: "state" };
  if (pr.state === "closed") return { icon: STATE.closed.icon, tone: "bad", title: "Closed", kind: "state" };
  const merge = { ...mergeStatus(pr), kind: "merge" as const }, review = { ...reviewStatus(pr), kind: "review" as const }, checks = { ...checksStatus(pr), kind: "checks" as const };
  if (pr.mergeable === "conflicting" || pr.mergeState === "DIRTY") return merge;
  if (pr.checks.state === "failing") return checks;
  if (pr.review === "changes_requested") return review;
  if (pr.inMergeQueue) return merge;
  if (pr.state === "draft") return { icon: STATE.draft.icon, tone: "muted", title: "Draft", kind: "state" };
  if (pr.mergeState === "BEHIND") return merge;
  if (pr.checks.state === "pending") return checks;
  if (review.tone === "waiting") return review;
  return merge;
}
/**
 * Whether the bar should add a checks glyph after the headline: only for an open PR, when the headline isn't the
 * checks already, and when it says something a green headline doesn't.
 */
export function showsChecksGlyph(pr: PullRequest) {
  const lead = headline(pr);
  return isOpen(pr) && pr.checks.state !== "none" && lead.kind !== "checks" && !(lead.tone === "good" && pr.checks.state === "passing");
}

/** One sentence for the bar's accessible name. */
export function summaryText(pr: PullRequest, local: Local, refreshError?: string) {
  return [
    `PR #${pr.number}, ${STATE[pr.state].label}: ${headline(pr).title}`,
    ...(showsChecksGlyph(pr) ? [`checks: ${checksStatus(pr).title}`] : []),
    ...(pr.stack ? [`stack layer ${pr.stack.position} of ${pr.stack.size}`] : []),
    ...(inSync(local) ? [] : [`checkout: ${syncStatus(local).title}`]),
    ...(refreshError ? [`not refreshed: ${refreshError.replaceAll("`", "")}`] : []),
  ].join("; ");
}
