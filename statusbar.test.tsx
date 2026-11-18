// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalThreadContextSegmentRegistration } from "@get-bb/plugin-sdk/app";
import type { PullRequest, StatusRow } from "./status";

afterEach(cleanup);

const pullRequest: PullRequest = {
  number: 7, title: "Add widgets", url: "https://github.com/acme/widget/pull/7", state: "open", author: "sam", headRefName: "widgets", baseRefName: "auth",
  headRefOid: "a".repeat(40), fork: false, additions: 1204, deletions: 310, changedFiles: 18, commits: 7, review: "changes_requested", reviewRequests: 0,
  unresolvedThreads: 2, comments: 4, mergeable: "mergeable", mergeState: "BLOCKED", autoMerge: false, inMergeQueue: false,
  checks: { state: "failing", passed: 9, failed: 1, pending: 1, skipped: 0, total: 11, items: [
    { name: "CI / test", state: "fail", url: "https://ci/test" }, { name: "CI / e2e", state: "pending", url: null }, { name: "CI / lint", state: "pass", url: "https://ci/lint" },
  ] },
  stack: { number: 3, size: 3, base: "main", position: 2, entries: [
    { position: 1, number: 6, title: "Auth", url: "https://github.com/acme/widget/pull/6", state: "merged" },
    { position: 2, number: 7, title: "Add widgets", url: "https://github.com/acme/widget/pull/7", state: "open" },
    { position: 3, number: 8, title: "Widget UI", url: "https://github.com/acme/widget/pull/8", state: "draft" },
  ] },
  updatedAt: "2026-11-18T00:00:00Z",
};
const available: StatusRow = { outcome: "available", source: "pr-ref", fetchedAt: 1, pullRequest, local: { branch: null, head: "a".repeat(40), sync: { ahead: 0, behind: 0 } } };

/** Mounts the segment's parts the way bb's context row does. */
async function mount(row: StatusRow, settings: Record<string, boolean>, git: { segments: string[]; status: unknown } = { segments: [], status: {} }) {
  const app = await loadPluginApp(() => import("./app"));
  const segment = app.threadContextSegments.find(s => s.id === "pull-request-status") as ExperimentalThreadContextSegmentRegistration;
  const input = { threadId: "thr_1", projectId: "proj_1", environment: { id: "env_pr" } };
  function Row() {
    const [open, setOpen] = useState(false);
    if (!segment.useVisible!(input)) return <p>hidden</p>;
    const segments = [{ key: "flexible-worktrees/pull-request-status", pluginId: "flexible-worktrees" }, ...git.segments.map(key => ({ key, pluginId: key.split("/")[0]! }))];
    const props = { ...input, segments, isExpanded: open, onToggle: () => setOpen(o => !o) };
    const { summary: Summary, action: Action, details: Details } = segment;
    return <div><Summary {...props} />{Action && <Action {...props} />}{Details && <Details {...props} />}</div>;
  }
  return renderSlot({ component: Row }, {}, {
    settings,
    rpc: {
      pullRequestStatus: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map(k => [k, row])),
      refreshPullRequestStatus: () => ({ ok: true }),
      status: () => git.status,
    } as never,
  });
}

it("stays hidden, and reads nothing, until the setting is on", async () => {
  const slot = await mount(available, { showStatusBar: false });
  expect(screen.getByText("hidden")).toBeTruthy();
  await new Promise(r => setTimeout(r, 20));
  expect(slot.inspection.rpcCalls).toHaveLength(0);
  slot.lifecycle.unmount();
});

it("keeps the last PR visible, marked, when a refresh failed", async () => {
  const slot = await mount({ ...available, refreshError: "GitHub didn’t answer in time." }, { showStatusBar: true });
  const toggle = await screen.findByRole("button", { name: /not refreshed: GitHub didn’t answer in time\.$/ });
  fireEvent.click(toggle);
  expect(within(screen.getByRole("region")).getByText(/Couldn’t refresh\. Showing status from .*GitHub didn’t answer in time\./)).toBeTruthy();
  slot.lifecycle.unmount();
});

it("says whose commits a merged PR took, without a merge line the header already covers", async () => {
  const slot = await mount({ ...available, pullRequest: { ...pullRequest, state: "merged" } }, { showStatusBar: true });
  const toggle = await screen.findByRole("button", { name: /^PR #7, Merged: Merged/ });
  // The state icon already says merged; neither a second merged glyph nor a checks glyph follows it.
  expect(toggle.querySelectorAll("[aria-hidden=true]").length).toBeLessThan(4);
  fireEvent.click(toggle);
  const details = within(screen.getByRole("region"));
  expect(details.getByText(/7 commits by sam merged into/)).toBeTruthy();
  expect(within(details.getByRole("list", { name: "Pull request status" })).queryByText("Merged")).toBeNull();
  slot.lifecycle.unmount();
});

it("hides when the checkout has no PR", async () => {
  const slot = await mount({ outcome: "absent", fetchedAt: 1 }, { showStatusBar: true });
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
  expect(screen.getByText("hidden")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("leads with what to act on, and opens a drawer with the PR's checklist and stack", async () => {
  const slot = await mount(available, { showStatusBar: true });
  const toggle = await screen.findByRole("button", { name: "PR #7, Open: 1 check failing; stack layer 2 of 3" });
  expect(within(toggle).getByText("1 check failing")).toBeTruthy();
  expect(within(toggle).getByText("2/3", { exact: false })).toBeTruthy();
  // bb's Git segment isn't in this row, so GitHub's line count shows.
  expect(within(toggle).getByText("+1,204")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open PR #7 on GitHub" }).getAttribute("href")).toBe(pullRequest.url);
  expect(screen.queryByRole("region")).toBeNull();

  fireEvent.click(toggle);
  const details = within(screen.getByRole("region"));
  expect(details.getByText(/sam wants to merge 7 commits into/)).toBeTruthy();
  expect(details.getByText("18 files", { exact: false })).toBeTruthy();
  const status = within(details.getByRole("list", { name: "Pull request status" }));
  // Only checks that need attention are listed, each linking to its run.
  expect(status.getByRole("link", { name: /^Failing:\s*CI \/ test$/ }).getAttribute("href")).toBe("https://ci/test");
  expect(status.getByText("CI / e2e")).toBeTruthy();
  expect(status.queryByText("CI / lint")).toBeNull();
  expect(status.getByText("Changes requested")).toBeTruthy();
  expect(status.getByText("2 unresolved · 4 comments")).toBeTruthy();
  expect(status.getByText("Merging is blocked")).toBeTruthy();
  expect(status.getByText("In sync with the PR")).toBeTruthy();
  expect(status.getByText("Detached · aaaaaaa")).toBeTruthy();
  const stack = within(details.getByRole("list", { name: "Stack #3" }));
  expect(stack.getAllByRole("listitem").map(li => li.textContent)).toEqual(["#8 Widget UIDraft", "#7 Add widgetsThis PR", "#6 AuthMerged", "main"]);
  expect(stack.getByRole("link", { name: /#8 Widget UI/ }).getAttribute("href")).toBe("https://github.com/acme/widget/pull/8");

  expect(toggle.getAttribute("aria-controls")).toBe("flexible-worktrees-pr-status-body-thr_1");
  fireEvent.click(details.getByRole("button", { name: "Refresh pull request status" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some(c => c.method === "refreshPullRequestStatus")).toBe(true));
  // While open, the drawer's header carries the line count, so the bar drops its own.
  expect(within(toggle).queryByText("+1,204")).toBeNull();
  fireEvent.click(details.getByRole("button", { name: "Collapse pull request status" }));
  expect(screen.queryByRole("region")).toBeNull();
  expect(document.activeElement).toBe(toggle);
  slot.lifecycle.unmount();
});

it("leaves the line count to bb's Git segment when it shows the same commits", async () => {
  const git = (mergeBase: { insertions: number; deletions: number }, hasUncommittedChanges = false) =>
    ({ env_pr: { outcome: "available", workspace: { workingTree: { hasUncommittedChanges }, mergeBase } } });
  for (const [status, shown] of [[git({ insertions: 1204, deletions: 310 }), false], [git({ insertions: 1204, deletions: 310 }, true), true], [git({ insertions: 5, deletions: 0 }), true]] as const) {
    const slot = await mount(available, { showStatusBar: true }, { segments: ["bb--git/changed-files"], status });
    const toggle = await screen.findByRole("button", { name: /^PR #7/ });
    await waitFor(() => expect(slot.inspection.rpcCalls.some(c => c.method === "status")).toBe(true));
    await waitFor(() => expect(within(toggle).queryByText("+1,204") !== null).toBe(shown));
    slot.lifecycle.unmount();
  }
});
