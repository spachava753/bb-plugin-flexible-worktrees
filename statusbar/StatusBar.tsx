import { useState, type ReactNode } from "react";
import {
  UrlLink, experimental_Icon as Icon, useSettings,
  type ExperimentalThreadContextSegmentInput, type ExperimentalThreadContextSegmentProps, type PluginRpcContract,
} from "@get-bb/plugin-sdk/app";
// Through the namespace, not by name: a git install builds this bundle against the installing BB's SDK, and a named
// import that SDK lacks (these arrived in 0.6.65) fails the whole build. Only the bar's components call them, and
// they never mount on a BB without context segments (see app.tsx).
import * as sdk from "@get-bb/plugin-sdk/app";
const { experimental_useRpcKeyedQuery: useRpcKeyedQuery, experimental_useRpcMutation: useRpcMutation } = sdk;
import { cn } from "../lib/utils";
import { z } from "zod";
import { STATUS_BAR_SETTING, statusContract, type Check, type PullRequest, type Stack, type StatusRow } from "../status";
import {
  STATE, TONE, checksStatus, formatCount, headline, mergeStatus, showsChecksGlyph, plural, reviewStatus, summaryText, syncStatus,
  type Status, type Tone,
} from "./describe";

type Row = Extract<StatusRow, { outcome: "available" }>;
/** bb's Git segment, which shows uncommitted changes when there are any, else the commits since the merge base. */
const GIT_CHANGES = "bb--git/changed-files";
const stats = z.object({ insertions: z.number(), deletions: z.number() });
/** The part of bb's Git plugin `status` read this bar compares against; its segment already holds the same key. */
const gitContract = {
  status: {
    input: z.object({ keys: z.array(z.string()) }),
    output: z.record(z.string(), z.object({
      outcome: z.string(),
      workspace: z.object({ workingTree: z.object({ hasUncommittedChanges: z.boolean() }), mergeBase: stats.nullable() }).optional(),
    })),
  },
} satisfies PluginRpcContract;
/** Per thread: split layouts show several threads' bars at once. */
const ids = (threadId: string) => ({ toggle: `flexible-worktrees-pr-status-toggle-${threadId}`, body: `flexible-worktrees-pr-status-body-${threadId}` });
const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The environment's PR row, or null when the setting is off or there's nothing to show. */
export function usePullRequestStatus(environmentId: string | null): Row | null {
  const enabled = useSettings().values?.[STATUS_BAR_SETTING] === true;
  const { data } = useRpcKeyedQuery({
    contract: statusContract, method: "pullRequestStatus", keys: enabled && environmentId ? [environmentId] : [],
  });
  const row = enabled && environmentId ? data?.[environmentId] : undefined;
  return row?.outcome === "available" ? row : null;
}
export const useVisible = ({ environment }: ExperimentalThreadContextSegmentInput) => usePullRequestStatus(environment?.id ?? null) !== null;

/**
 * Whether to show GitHub's line count: not while bb's Git segment shows the same numbers right beside it (its
 * committed changes, equal to the PR's), which is the usual case for a checkout in sync with its PR.
 */
function useShowsDiff(environmentId: string, pr: PullRequest, segments: ExperimentalThreadContextSegmentProps["segments"]) {
  const gitShown = segments.some(s => s.key === GIT_CHANGES);
  const { data } = useRpcKeyedQuery({ pluginId: "bb--git", contract: gitContract, method: "status", keys: gitShown ? [environmentId] : [] });
  const workspace = gitShown ? data?.[environmentId]?.workspace : undefined;
  if (!workspace || workspace.workingTree.hasUncommittedChanges || !workspace.mergeBase) return true;
  return workspace.mergeBase.insertions !== pr.additions || workspace.mergeBase.deletions !== pr.deletions;
}

/** Text colors: yellow is too faint for text on light themes, so waiting text stays plain and its icon carries the tone. */
const TEXT: Record<Tone, string> = { ...TONE, waiting: "" };
const Glyph = ({ name, tone, className }: { name: string; tone: Tone; className?: string }) =>
  <Icon name={name} fallback="Circle" aria-hidden="true" className={cn("size-3.5 shrink-0", TONE[tone], className)} />;
const Dot = () => <span aria-hidden="true" className="text-subtle-foreground">·</span>;
export const Diffstat = ({ pr }: { pr: PullRequest }) => <span className="shrink-0 whitespace-nowrap tabular-nums">
  <span className="text-diff-added">+{formatCount(pr.additions)}</span> <span className="text-diff-removed">−{formatCount(pr.deletions)}</span>
</span>;

export function Summary({ threadId, environment, segments, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const row = usePullRequestStatus(environment?.id ?? null);
  if (!row) return null;
  return <SummaryButton row={row} threadId={threadId} environmentId={environment!.id} segments={segments} isExpanded={isExpanded} onToggle={onToggle} />;
}

function SummaryButton({ row, threadId, environmentId, segments, isExpanded, onToggle }: { row: Row; threadId: string; environmentId: string } & Pick<ExperimentalThreadContextSegmentProps, "segments" | "isExpanded" | "onToggle">) {
  const { pullRequest: pr, local, refreshError } = row;
  const { toggle, body } = ids(threadId);
  const showDiff = useShowsDiff(environmentId, pr, segments);
  const lead = headline(pr);
  const checks = checksStatus(pr);
  const sync = local.sync;
  return <button type="button" id={toggle} aria-expanded={isExpanded} aria-controls={body} aria-label={summaryText(pr, local, refreshError)} onClick={onToggle}
    className={cn("group/pr flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded px-2 py-1 text-left text-xs transition-colors hover:bg-state-hover",
      FOCUS, "animate-in fade-in duration-300 motion-reduce:animate-none", isExpanded ? "text-foreground" : "text-muted-foreground")}>
    <span className="flex shrink-0 items-center gap-1.5"><Glyph name={STATE[pr.state].icon} tone={STATE[pr.state].tone} /><span className="tabular-nums">#{pr.number}</span></span>
    {refreshError && <span title={`Not refreshed: ${refreshError}`} className="-ml-1 flex shrink-0"><Glyph name="AlertTriangle" tone="muted" /></span>}
    {/* The headline always shows and truncates; the secondary items give way in the compact composer. */}
    <span className={cn("flex min-w-0 items-center gap-1", refreshError && "opacity-60")}>
      {lead.icon !== STATE[pr.state].icon && <Glyph name={lead.icon} tone={lead.tone} />}
      <span className={cn("min-w-0 truncate", TEXT[lead.tone])}>{lead.title}</span>
    </span>
    {showsChecksGlyph(pr) && <span title={checks.title} className="flex shrink-0"><Glyph name={checks.icon} tone={checks.tone} /></span>}
    {pr.stack && <span title={`Stack #${pr.stack.number}: layer ${pr.stack.position} of ${pr.stack.size}`} className="flex shrink-0 items-center gap-0.5 tabular-nums" data-promptbox-hide-compact="">
      <Icon name="Layers" aria-hidden="true" className="size-3.5 shrink-0" />{pr.stack.position}/{pr.stack.size}
    </span>}
    {sync && (sync.ahead > 0 || sync.behind > 0) && <span title={syncStatus(local).title} className="flex shrink-0 items-center gap-1 tabular-nums" data-promptbox-hide-compact="">
      {sync.ahead > 0 && <span className="flex items-center"><Glyph name="ArrowUp" tone="waiting" className="size-3" />{sync.ahead}</span>}
      {sync.behind > 0 && <span className="flex items-center"><Glyph name="ArrowDown" tone="waiting" className="size-3" />{sync.behind}</span>}
    </span>}
    {/* While the drawer is open, its header carries the count with the file count. */}
    {showDiff && !isExpanded && <span title="PR diff on GitHub" className="contents" data-promptbox-hide-compact=""><Diffstat pr={pr} /></span>}
    {!isExpanded && <Icon name="ChevronDown" aria-hidden="true"
      className="ml-auto size-3.5 shrink-0 text-subtle-foreground opacity-0 transition-opacity group-hover/pr:opacity-100 group-focus-visible/pr:opacity-100 [@media(hover:none)]:hidden" />}
  </button>;
}

export function Action({ environment }: ExperimentalThreadContextSegmentProps) {
  const row = usePullRequestStatus(environment?.id ?? null);
  if (!row) return null;
  return <UrlLink href={row.pullRequest.url} target="_blank" rel="noopener noreferrer" aria-label={`Open PR #${row.pullRequest.number} on GitHub`} title="Open on GitHub"
    className={cn("mr-1 flex size-5 shrink-0 items-center justify-center rounded text-subtle-foreground transition-colors hover:bg-state-active hover:text-foreground", FOCUS)}>
    <Icon name="ExternalLink" aria-hidden="true" className="size-3.5" />
  </UrlLink>;
}

/**
 * Animates open and closed by easing the grid row between 0fr and 1fr. Content mounts on first open and stays
 * mounted, so closing animates too; while closed it is hidden from assistive tech and can't take focus.
 */
function Drawer({ id, labelledBy, open, children }: { id: string; labelledBy: string; open: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return <section id={id} role="region" aria-labelledby={labelledBy} aria-hidden={!open} inert={!open}
    className={cn("grid transition-[grid-template-rows,opacity,border-color] duration-200 ease-out motion-reduce:transition-none",
      open ? "grid-rows-[1fr] border-t border-border opacity-100" : "pointer-events-none grid-rows-[0fr] border-t border-transparent opacity-0")}>
    <div className="min-h-0 overflow-hidden bg-popover">{opened ? children : null}</div>
  </section>;
}

export function Details({ threadId, environment, segments, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const row = usePullRequestStatus(environment?.id ?? null);
  if (!row) return null;
  const { toggle, body } = ids(threadId);
  return <Drawer id={body} labelledBy={toggle} open={isExpanded}>
    <div className="grid gap-2 px-2 pb-1 pt-2 text-xs">
      <Header row={row} environmentId={environment!.id} segments={segments} />
      {row.refreshError && <p className="mx-1 flex min-w-0 items-start gap-1.5 rounded bg-muted/50 px-2 py-1 text-muted-foreground">
        <Glyph name="AlertTriangle" tone="muted" className="mt-px size-3" />
        <span className="min-w-0">Couldn’t refresh. Showing status from {time(row.fetchedAt)}. {row.refreshError.replaceAll("`", "")}</span>
      </p>}
      <Checklist row={row} />
      {row.pullRequest.stack && <StackRail pr={row.pullRequest} stack={row.pullRequest.stack} />}
      <button type="button" aria-label="Collapse pull request status"
        // The drawer turns inert as it closes, which would drop focus to the page; hand it back to the bar.
        onClick={() => { document.getElementById(toggle)?.focus(); onToggle(); }}
        className={cn("flex min-h-6 w-full cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS)}>
        <Icon name="ChevronUp" aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  </Drawer>;
}

const Branch = ({ name }: { name: string }) =>
  <code title={name} className="inline-block max-w-[14rem] truncate rounded bg-muted px-1 align-bottom font-mono text-[11px] leading-4 text-foreground/80">{name}</code>;

function Header({ row, environmentId, segments }: { row: Row; environmentId: string; segments: ExperimentalThreadContextSegmentProps["segments"] }) {
  const { pullRequest: pr } = row;
  const showDiff = useShowsDiff(environmentId, pr, segments);
  const refresh = useRpcMutation({ contract: statusContract, method: "refreshPullRequestStatus" });
  // Only the author is known, not who merged or closed it.
  const commits = plural(pr.commits, "commit");
  const by = pr.author || "someone";
  return <div className={cn(GRID, "items-start gap-y-0.5 px-1")}>
    <span className="flex h-5 items-center justify-center"><Glyph name={STATE[pr.state].icon} tone={STATE[pr.state].tone} className="size-4" /></span>
    <UrlLink href={pr.url} target="_blank" rel="noopener noreferrer" title={pr.title}
      className={cn("min-w-0 truncate text-[13px] font-medium leading-5 text-foreground decoration-muted-foreground/50 underline-offset-2 hover:underline", FOCUS)}>
      {pr.title} <span className="font-normal text-muted-foreground">#{pr.number}</span>
    </UrlLink>
    <button type="button" aria-label="Refresh pull request status" title={`Checked at ${time(row.fetchedAt)}. Refresh`}
      disabled={refresh.isPending} onClick={() => { void refresh.mutate({ environmentId }).catch(() => undefined); }}
      className={cn("-mr-0.5 flex size-5 cursor-pointer items-center justify-center justify-self-end rounded text-subtle-foreground transition-colors hover:bg-state-active hover:text-foreground disabled:cursor-default", FOCUS)}>
      <Icon name="ArrowReloadHorizontal" aria-hidden="true" className={cn("size-3.5", refresh.isPending && "animate-spin motion-reduce:animate-none")} />
    </button>
    <span />
    <p className="min-w-0 truncate leading-5 text-muted-foreground">
      {pr.state === "open" || pr.state === "draft" ? <>{by} wants to merge {commits} into </> : <>{commits} by {by} {pr.state === "merged" ? "merged" : "proposed"} into </>}
      <Branch name={pr.baseRefName} /> from <Branch name={pr.headRefName} />{pr.fork && " (fork)"}
    </p>
    {showDiff ? <span className="whitespace-nowrap text-right leading-5 text-muted-foreground"><Diffstat pr={pr} /> <Dot /> {plural(pr.changedFiles, "file")}</span> : <span />}
  </div>;
}

/** The same grid as bb's changed-files drawer: an icon column, the line, and right-aligned detail. */
const GRID = "grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2";

function Line({ status, label, children }: { status: Status; label: string; children?: ReactNode }) {
  return <li>
    <div className={cn(GRID, "min-h-6 rounded px-1")}>
      <span className="flex justify-center"><Glyph name={status.icon} tone={status.tone} /></span>
      <span className="min-w-0 truncate"><span className="sr-only">{label}: </span><span className={status.tone === "muted" ? "text-muted-foreground" : "text-foreground"}>{status.title}</span></span>
      {status.detail ? <span className="truncate text-right text-muted-foreground">{status.detail}</span> : <span />}
    </div>
    {children}
  </li>;
}

function Checklist({ row }: { row: Row }) {
  const { pullRequest: pr, local } = row;
  const sync = syncStatus(local);
  return <ul className="grid" aria-label="Pull request status">
    <Line status={checksStatus(pr)} label="Checks"><CheckRuns checks={pr.checks.items} more={pr.checks.failed + pr.checks.pending} /></Line>
    <Line status={reviewStatus(pr)} label="Review" />
    {pr.state !== "merged" && <Line status={mergeStatus(pr)} label="Merge" />}
    <Line status={{ ...sync, detail: [sync.detail, local.head.slice(0, 7)].filter(Boolean).join(" · ") }} label="Checkout" />
  </ul>;
}

const CHECK: Record<Check["state"], { icon: string; tone: Tone }> = {
  fail: { icon: "CircleX", tone: "bad" }, pending: { icon: "Clock", tone: "waiting" }, pass: { icon: "CircleCheck", tone: "good" },
  skipped: { icon: "Circle", tone: "muted" }, neutral: { icon: "Circle", tone: "muted" },
};
const SHOWN_CHECKS = 5;

/** The checks that need attention, each opening its run. Passing checks stay folded into the count. */
function CheckRuns({ checks, more }: { checks: Check[]; more: number }) {
  const shown = checks.filter(c => c.state === "fail" || c.state === "pending").slice(0, SHOWN_CHECKS);
  if (!shown.length) return null;
  const hidden = more - shown.length;
  return <ul className="grid">
    {shown.map((check, i) => {
      const line = <>
        <span />
        <span className="flex min-w-0 items-center gap-1.5"><Glyph name={CHECK[check.state].icon} tone={CHECK[check.state].tone} className="size-3" /><span className="min-w-0 truncate"><span className="sr-only">{check.state === "fail" ? "Failing: " : "Running: "}</span>{check.name}</span></span>
        {check.url ? <Icon name="ExternalLink" aria-hidden="true" className="size-3 text-subtle-foreground opacity-0 transition-opacity group-hover/check:opacity-100" /> : <span />}
      </>;
      return <li key={`${check.name}:${i}`}>
        {check.url
          ? <UrlLink href={check.url} target="_blank" rel="noopener noreferrer" className={cn(GRID, "group/check min-h-6 rounded px-1 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS)}>{line}</UrlLink>
          : <div className={cn(GRID, "min-h-6 px-1 text-muted-foreground")}>{line}</div>}
      </li>;
    })}
    {hidden > 0 && <li className={cn(GRID, "min-h-6 px-1 text-muted-foreground")}><span /><span>and {formatCount(hidden)} more</span><span /></li>}
  </ul>;
}

const DOT: Record<PullRequest["state"], string> = { open: "bg-success", draft: "bg-muted-foreground", merged: "bg-pr-merged", closed: "bg-destructive" };

/** GitHub's stack map as a rail: the top layer first, down to the branch the stack targets. */
function StackRail({ pr, stack }: { pr: PullRequest; stack: Stack }) {
  const entries = [...stack.entries].sort((a, b) => b.position - a.position);
  const line = (first: boolean, last: boolean) =>
    <span aria-hidden="true" className={cn("absolute left-1/2 w-px -translate-x-1/2 bg-muted-foreground/60", first ? "top-1/2" : "top-0", last ? "bottom-1/2" : "bottom-0")} />;
  return <div className="grid">
    <h3 className={cn(GRID, "min-h-6 px-1 text-[11px] font-medium text-muted-foreground")}>
      <span className="flex justify-center"><Icon name="Layers" aria-hidden="true" className="size-3.5" /></span>
      <span>Stack <span className="font-normal text-subtle-foreground">· layer {stack.position} of {stack.size}</span></span>
      <span className="text-right font-normal text-subtle-foreground">#{stack.number}</span>
    </h3>
    <ol className="grid" aria-label={`Stack #${stack.number}`}>
      {entries.map((entry, i) => {
        const current = entry.number === pr.number;
        const dot = <span className="relative grid h-full min-h-6 place-items-center">
          {line(i === 0, false)}
          <span className={cn("relative size-2 rounded-full ring-2 ring-popover", current ? "bg-foreground" : DOT[entry.state])} />
        </span>;
        const text = <span className="min-w-0 truncate"><span className="tabular-nums text-subtle-foreground">#{entry.number}</span> {entry.title}</span>;
        const trailing = <span className="text-right text-subtle-foreground">{current ? "This PR" : STATE[entry.state].label}</span>;
        return <li key={entry.number} aria-current={current ? "true" : undefined}>
          {current
            ? <div className={cn(GRID, "rounded bg-state-hover px-1 font-medium text-foreground")}>{dot}{text}{trailing}</div>
            : <UrlLink href={entry.url} target="_blank" rel="noopener noreferrer" className={cn(GRID, "rounded px-1 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS)}>{dot}{text}{trailing}</UrlLink>}
        </li>;
      })}
      <li className={cn(GRID, "px-1 text-muted-foreground")}>
        <span className="relative grid h-full min-h-6 place-items-center">{line(false, true)}<Icon name="GitBranch" aria-hidden="true" className="relative size-3 bg-popover" /></span>
        <span className="min-w-0 truncate font-mono text-[11px]">{stack.base}</span><span />
      </li>
    </ol>
  </div>;
}
