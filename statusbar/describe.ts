import type { Local, PullRequest } from "../status";

export type Tone = "good" | "bad" | "waiting" | "muted";
export type Label = { text: string; tone: Tone };

export const formatCount = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

export const STATE: Record<PullRequest["state"], { label: string; icon: string; className: string }> = {
  open: { label: "Open", icon: "GitPullRequestArrow", className: "text-success-foreground" },
  draft: { label: "Draft", icon: "GitPullRequestDraft", className: "text-muted-foreground" },
  merged: { label: "Merged", icon: "GitMerge", className: "text-pr-merged" },
  closed: { label: "Closed", icon: "GitPullRequestClosed", className: "text-destructive-text" },
};
export const TONE: Record<Tone, string> = {
  good: "text-success-foreground", bad: "text-destructive-text", waiting: "text-warning", muted: "text-muted-foreground",
};

export function checksLabel({ checks }: PullRequest): Label {
  const { state, failed, pending, passed, total } = checks;
  if (state === "none") return { text: "No checks", tone: "muted" };
  const parts = [failed && `${formatCount(failed)} failing`, pending && `${formatCount(pending)} running`, passed && `${formatCount(passed)} passed`].filter(Boolean);
  const skipped = total - failed - pending - passed;
  if (skipped) parts.push(`${formatCount(skipped)} skipped`);
  return { text: parts.join(", "), tone: state === "failing" ? "bad" : state === "pending" ? "waiting" : "good" };
}
/** Compact checks count for the bar: failures, else running, else passed of total. */
export function checksShort({ checks }: PullRequest) {
  if (checks.state === "failing") return `${formatCount(checks.failed)} failing`;
  if (checks.state === "pending") return `${formatCount(checks.pending)} running`;
  return `${formatCount(checks.passed)}/${formatCount(checks.total)}`;
}
export const CHECK_ICON: Record<PullRequest["checks"]["state"], string> = {
  failing: "CircleX", pending: "Clock", passing: "CircleCheck", none: "Circle",
};

export function reviewLabel(pr: PullRequest): Label | null {
  if (pr.state === "merged" || pr.state === "closed") return null;
  if (pr.review === "approved") return { text: "Approved", tone: "good" };
  if (pr.review === "changes_requested") return { text: "Changes requested", tone: "bad" };
  if (pr.reviewRequests) return { text: `Review requested from ${plural(pr.reviewRequests, "reviewer")}`, tone: "waiting" };
  if (pr.review === "review_required") return { text: "Review required", tone: "waiting" };
  return null;
}

/** What stands between the PR and merging, or null once it's merged or closed. */
export function mergeLabel(pr: PullRequest): Label | null {
  if (pr.state === "merged" || pr.state === "closed") return null;
  if (pr.inMergeQueue) return { text: "In the merge queue", tone: "waiting" };
  if (pr.mergeable === "conflicting" || pr.mergeState === "DIRTY") return { text: "Merge conflicts", tone: "bad" };
  if (pr.state === "draft") return { text: "Draft: mark ready to merge", tone: "muted" };
  switch (pr.mergeState) {
    case "BEHIND": return { text: `Behind ${pr.baseRefName}`, tone: "bad" };
    case "BLOCKED": return { text: "Blocked by branch rules", tone: "bad" };
    case "UNSTABLE": return { text: "Mergeable with failing checks", tone: "waiting" };
    case "CLEAN": case "HAS_HOOKS": return { text: "Ready to merge", tone: "good" };
    default: return { text: "Checking mergeability", tone: "muted" };
  }
}

/** The local checkout relative to the PR head on GitHub. */
export function syncLabel(local: Local): Label {
  const at = local.branch ? `\`${local.branch}\`` : "Detached HEAD";
  if (!local.sync) return { text: `The PR head isn’t fetched here, so ${local.branch ? `\`${local.branch}\`` : "this checkout"} may be behind`, tone: "waiting" };
  const { ahead, behind } = local.sync;
  if (!ahead && !behind) return { text: `${at} matches the PR head`, tone: "good" };
  if (ahead && behind) return { text: `${at} diverged from the PR head: ${plural(ahead, "local commit")}, ${plural(behind, "PR commit")}`, tone: "bad" };
  if (ahead) return { text: `${at} has ${plural(ahead, "commit")} not on the PR`, tone: "waiting" };
  return { text: `${at} is ${plural(behind, "commit")} behind the PR`, tone: "waiting" };
}

/** One sentence for the bar's accessible name. */
export function summaryText(pr: PullRequest, local: Local) {
  return [
    `PR #${pr.number}, ${STATE[pr.state].label}`,
    `+${formatCount(pr.additions)} −${formatCount(pr.deletions)} on GitHub`,
    `checks: ${checksLabel(pr).text}`,
    ...(pr.stack ? [`stack layer ${pr.stack.position} of ${pr.stack.size}`] : []),
    ...(reviewLabel(pr) ? [reviewLabel(pr)!.text] : []),
    ...(local.sync && !local.sync.ahead && !local.sync.behind ? [] : [syncLabel(local).text.replaceAll("`", "")]),
  ].join("; ");
}
