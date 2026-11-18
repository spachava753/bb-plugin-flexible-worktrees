import type { ReactNode } from "react";
import {
  UrlLink, experimental_Icon as Icon, experimental_useRpcKeyedQuery, experimental_useRpcMutation, useSettings,
  type ExperimentalThreadContextSegmentInput, type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Text } from "../picker/parts";
import { STATUS_BAR_SETTING, statusContract, type Local, type PullRequest } from "../status";
import { CHECK_ICON, STATE, TONE, checksLabel, checksShort, formatCount, mergeLabel, reviewLabel, summaryText, syncLabel, type Label } from "./describe";

const BODY_ID = "flexible-worktrees-pr-status-body";
const TOGGLE_ID = "flexible-worktrees-pr-status-toggle";

/** The environment's PR row, or null when the setting is off or there's nothing to show. */
export function usePullRequestStatus(environmentId: string | null) {
  const enabled = useSettings().values?.[STATUS_BAR_SETTING] === true;
  const { data } = experimental_useRpcKeyedQuery({
    contract: statusContract, method: "pullRequestStatus", keys: enabled && environmentId ? [environmentId] : [],
  });
  const row = enabled && environmentId ? data?.[environmentId] : undefined;
  return row?.outcome === "available" ? row : null;
}
export const useVisible = ({ environment }: ExperimentalThreadContextSegmentInput) => usePullRequestStatus(environment?.id ?? null) !== null;

const Sep = () => <span aria-hidden="true" className="text-subtle-foreground">·</span>;
const StateIcon = ({ pr, className }: { pr: PullRequest; className?: string }) =>
  <Icon name={STATE[pr.state].icon} fallback="GitPullRequest" aria-hidden="true" className={cn("size-3.5 shrink-0", STATE[pr.state].className, className)} />;
export const Diffstat = ({ pr }: { pr: PullRequest }) => <span className="shrink-0 whitespace-nowrap">
  <span className="text-diff-added">+{formatCount(pr.additions)}</span> <span className="text-diff-removed">−{formatCount(pr.deletions)}</span>
</span>;

export function Summary({ environment, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const row = usePullRequestStatus(environment?.id ?? null);
  if (!row) return null;
  const { pullRequest: pr, local } = row;
  const checks = checksLabel(pr);
  const review = reviewLabel(pr);
  const sync = local.sync;
  return <button type="button" id={TOGGLE_ID} aria-expanded={isExpanded} aria-controls={BODY_ID} aria-label={summaryText(pr, local)} onClick={onToggle}
    className={cn("flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden rounded px-2 py-1 text-xs transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      isExpanded ? "text-foreground" : "text-muted-foreground")}>
    <StateIcon pr={pr} />
    <span className="shrink-0">#{pr.number}</span>
    {pr.state !== "open" && <span className="shrink-0" data-promptbox-hide-compact="">{STATE[pr.state].label}</span>}
    <Sep /><Diffstat pr={pr} />
    {pr.checks.state !== "none" && <>
      <Sep />
      <span className={cn("flex shrink-0 items-center gap-1", TONE[checks.tone])} title={`Checks: ${checks.text}`}>
        <Icon name={CHECK_ICON[pr.checks.state]} aria-hidden="true" className="size-3.5 shrink-0" />
        <span data-promptbox-hide-compact="">{checksShort(pr)}</span>
      </span>
    </>}
    {pr.stack && <>
      <Sep />
      <span className="flex shrink-0 items-center gap-1" title={`Stack #${pr.stack.number}: layer ${pr.stack.position} of ${pr.stack.size}`}>
        <Icon name="Layers" aria-hidden="true" className="size-3.5 shrink-0" />{pr.stack.position}/{pr.stack.size}
      </span>
    </>}
    {review && review.tone !== "waiting" && <span className="contents" data-promptbox-hide-compact="">
      <Sep /><span className={cn("min-w-0 truncate", TONE[review.tone])}>{review.text}</span>
    </span>}
    {sync && (sync.ahead > 0 || sync.behind > 0) && <span className="contents" data-promptbox-hide-compact="">
      <Sep />
      <span className="shrink-0 whitespace-nowrap text-warning" title={syncLabel(local).text.replaceAll("`", "")}>
        {sync.ahead > 0 && `↑${sync.ahead}`}{sync.ahead > 0 && sync.behind > 0 && " "}{sync.behind > 0 && `↓${sync.behind}`}
      </span>
    </span>}
  </button>;
}

export function Action({ environment }: ExperimentalThreadContextSegmentProps) {
  const row = usePullRequestStatus(environment?.id ?? null);
  if (!row) return null;
  return <UrlLink href={row.pullRequest.url} target="_blank" rel="noopener noreferrer" aria-label={`Open PR #${row.pullRequest.number} on GitHub`} title="Open on GitHub"
    className="mr-1 flex size-5 shrink-0 items-center justify-center rounded text-subtle-foreground transition-colors hover:bg-state-active hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <Icon name="ExternalLink" aria-hidden="true" className="size-3.5" />
  </UrlLink>;
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return <><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0">{children}</dd></>;
}
const Toned = ({ label }: { label: Label }) => <span className={TONE[label.tone]}><Text>{label.text}</Text></span>;
const CHECK_CLASS = { fail: "text-destructive-text", pending: "text-warning", pass: "text-success-foreground", skipped: "text-muted-foreground", neutral: "text-muted-foreground" } as const;
const CHECK_GLYPH = { fail: "CircleX", pending: "Clock", pass: "CircleCheck", skipped: "CircleSlash", neutral: "Circle" } as const;
const SHOWN_CHECKS = 6;

export function Details({ environment, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const row = usePullRequestStatus(environment?.id ?? null);
  const refresh = experimental_useRpcMutation({ contract: statusContract, method: "refreshPullRequestStatus" });
  if (!row || !isExpanded) return null;
  const { pullRequest: pr, local } = row;
  return <section id={BODY_ID} role="region" aria-labelledby={TOGGLE_ID} className="grid gap-2 border-t border-border bg-popover px-3 pb-2 pt-2 text-xs">
    <div className="flex min-w-0 items-start gap-2">
      <StateIcon pr={pr} className="mt-0.5" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <UrlLink href={pr.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-medium text-foreground hover:underline">
          {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
        </UrlLink>
        <span className="min-w-0 truncate text-muted-foreground">
          {STATE[pr.state].label}{pr.author && ` · ${pr.author}`} · <span className="font-mono">{pr.headRefName}</span> → <span className="font-mono">{pr.baseRefName}</span>{pr.fork && " (fork)"}
        </span>
      </div>
      <button type="button" aria-label="Refresh pull request status" title="Refresh" disabled={refresh.isPending}
        onClick={() => { void refresh.mutate({ environmentId: environment!.id }).catch(() => undefined); }}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-subtle-foreground transition-colors hover:bg-state-active hover:text-foreground disabled:cursor-default disabled:opacity-60">
        <Icon name="RefreshCw" aria-hidden="true" className={cn("size-3.5", refresh.isPending && "animate-spin")} />
      </button>
    </div>
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1">
      <Line label="Diff on GitHub"><Diffstat pr={pr} /> in {formatCount(pr.changedFiles)} {pr.changedFiles === 1 ? "file" : "files"} · {formatCount(pr.commits)} {pr.commits === 1 ? "commit" : "commits"}</Line>
      <Line label="Checks"><Checks pr={pr} /></Line>
      <Review pr={pr} />
      {mergeLabel(pr) && <Line label="Merge">
        <Toned label={mergeLabel(pr)!} />{pr.autoMerge && !pr.inMergeQueue && <span className="text-muted-foreground"> · Auto-merge on</span>}
      </Line>}
      {pr.stack && <Line label="Stack"><StackMap pr={pr} /></Line>}
      <Line label="Checkout"><LocalSync local={local} /></Line>
    </dl>
  </section>;
}

function Checks({ pr }: { pr: PullRequest }) {
  const label = checksLabel(pr);
  // Passing checks stay collapsed into the count; list what needs attention.
  const shown = pr.checks.items.filter(c => c.state === "fail" || c.state === "pending").slice(0, SHOWN_CHECKS);
  const hidden = pr.checks.failed + pr.checks.pending - shown.length;
  return <div className="grid gap-0.5">
    <Toned label={label} />
    {shown.length > 0 && <ul className="grid gap-0.5">
      {shown.map((check, i) => <li key={`${check.name}:${i}`} className="flex min-w-0 items-center gap-1.5">
        <Icon name={CHECK_GLYPH[check.state]} aria-hidden="true" className={cn("size-3 shrink-0", CHECK_CLASS[check.state])} />
        {check.url ? <UrlLink href={check.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:underline">{check.name}</UrlLink> : <span className="min-w-0 truncate">{check.name}</span>}
      </li>)}
      {hidden > 0 && <li className="text-muted-foreground">and {formatCount(hidden)} more</li>}
    </ul>}
  </div>;
}

function Review({ pr }: { pr: PullRequest }) {
  const review = reviewLabel(pr);
  const extra = [
    pr.unresolvedThreads > 0 && `${formatCount(pr.unresolvedThreads)} unresolved ${pr.unresolvedThreads === 1 ? "thread" : "threads"}`,
    pr.comments > 0 && `${formatCount(pr.comments)} ${pr.comments === 1 ? "comment" : "comments"}`,
  ].filter(Boolean).join(" · ");
  if (!review && !extra) return null;
  return <Line label="Review">
    {review && <Toned label={review} />}{review && extra && <span className="text-muted-foreground"> · </span>}
    {extra && <span className={pr.unresolvedThreads > 0 ? "text-warning" : "text-muted-foreground"}>{extra}</span>}
  </Line>;
}

/** GitHub's stack map: the top layer first, down to the stack's base branch. */
function StackMap({ pr }: { pr: PullRequest }) {
  const stack = pr.stack!;
  const entries = [...stack.entries].sort((a, b) => b.position - a.position);
  return <div className="grid gap-0.5">
    <span>Layer {stack.position} of {stack.size} <span className="text-muted-foreground">· stack #{stack.number}</span></span>
    <ol className="grid gap-0.5" aria-label={`Stack #${stack.number}`}>
      {entries.map(entry => {
        const current = entry.number === pr.number;
        return <li key={entry.number} aria-current={current ? "true" : undefined} className={cn("flex min-w-0 items-center gap-1.5", current ? "font-medium text-foreground" : "text-muted-foreground")}>
          <span className="w-4 shrink-0 text-right tabular-nums text-subtle-foreground">{entry.position}</span>
          <Icon name={STATE[entry.state].icon} fallback="GitPullRequest" aria-hidden="true" className={cn("size-3 shrink-0", STATE[entry.state].className)} />
          {current ? <span className="min-w-0 truncate">#{entry.number} {entry.title} (this PR)</span>
            : <UrlLink href={entry.url} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:underline">#{entry.number} {entry.title}</UrlLink>}
        </li>;
      })}
      <li className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <span className="w-4 shrink-0" />
        <Icon name="GitBranch" aria-hidden="true" className="size-3 shrink-0" /><span className="min-w-0 truncate font-mono">{stack.base}</span>
      </li>
    </ol>
  </div>;
}

function LocalSync({ local }: { local: Local }) {
  return <span className="grid gap-0.5">
    <Toned label={syncLabel(local)} />
    <span className="font-mono text-muted-foreground">{local.head.slice(0, 10)}</span>
  </span>;
}
