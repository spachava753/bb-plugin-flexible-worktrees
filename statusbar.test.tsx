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
async function mount(row: StatusRow, settings: Record<string, boolean>) {
  const app = await loadPluginApp(() => import("./app"));
  const segment = app.threadContextSegments.find(s => s.id === "pull-request-status") as ExperimentalThreadContextSegmentRegistration;
  const input = { threadId: "thr_1", projectId: "proj_1", environment: { id: "env_pr" } };
  function Row() {
    const [open, setOpen] = useState(false);
    if (!segment.useVisible!(input)) return <p>hidden</p>;
    const props = { ...input, segments: [{ key: "flexible-worktrees/pull-request-status", pluginId: "flexible-worktrees" }], isExpanded: open, onToggle: () => setOpen(o => !o) };
    const { summary: Summary, action: Action, details: Details } = segment;
    return <div><Summary {...props} />{Action && <Action {...props} />}{Details && <Details {...props} />}</div>;
  }
  return renderSlot({ component: Row }, {}, {
    settings,
    rpc: { pullRequestStatus: ({ keys }: { keys: string[] }) => Object.fromEntries(keys.map(k => [k, row])), refreshPullRequestStatus: () => ({ ok: true }) } as never,
  });
}

it("stays hidden, and reads nothing, until the setting is on", async () => {
  const slot = await mount(available, { showStatusBar: false });
  expect(screen.getByText("hidden")).toBeTruthy();
  await new Promise(r => setTimeout(r, 20));
  expect(slot.inspection.rpcCalls).toHaveLength(0);
  slot.lifecycle.unmount();
});

it("hides when the checkout has no PR", async () => {
  const slot = await mount({ outcome: "absent", fetchedAt: 1 }, { showStatusBar: true });
  await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
  expect(screen.getByText("hidden")).toBeTruthy();
  slot.lifecycle.unmount();
});

it("shows a detached PR's GitHub diff, checks, and stack at a glance, with details on demand", async () => {
  const slot = await mount(available, { showStatusBar: true });
  const toggle = await screen.findByRole("button", { name: /^PR #7, Open; \+1,204 −310 on GitHub; checks: 1 failing, 1 running, 9 passed; stack layer 2 of 3; Changes requested$/ });
  expect(within(toggle).getByText("1 failing")).toBeTruthy();
  expect(within(toggle).getByText("2/3", { exact: false })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open PR #7 on GitHub" }).getAttribute("href")).toBe(pullRequest.url);
  expect(screen.queryByRole("region")).toBeNull();

  fireEvent.click(toggle);
  const details = within(screen.getByRole("region"));
  expect(details.getByText("in 18 files · 7 commits", { exact: false })).toBeTruthy();
  // Only checks that need attention are listed, each linking to its run.
  expect(details.getByRole("link", { name: "CI / test" }).getAttribute("href")).toBe("https://ci/test");
  expect(details.getByText("CI / e2e")).toBeTruthy();
  expect(details.queryByText("CI / lint")).toBeNull();
  expect(details.getByText("2 unresolved threads · 4 comments")).toBeTruthy();
  expect(details.getByText("Blocked by branch rules")).toBeTruthy();
  const stack = within(details.getByRole("list", { name: "Stack #3" }));
  expect(stack.getAllByRole("listitem").map(li => li.textContent)).toEqual(["3#8 Widget UI", "2#7 Add widgets (this PR)", "1#6 Auth", "main"]);
  expect(stack.getByRole("link", { name: "#8 Widget UI" }).getAttribute("href")).toBe("https://github.com/acme/widget/pull/8");
  expect(details.getByText("Matches the PR head")).toBeTruthy();
  expect(details.getByText("aaaaaaaaaa")).toBeTruthy();

  fireEvent.click(details.getByRole("button", { name: "Refresh pull request status" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.some(c => c.method === "refreshPullRequestStatus")).toBe(true));
  slot.lifecycle.unmount();
});
