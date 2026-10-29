// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor, screen, cleanup, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Inputs, Plan, Preview } from "./inputs";

afterEach(cleanup);
const plan = (inputs: Inputs): Plan => inputs.target === "path"
  ? { action: "attach", source: "/repo", path: inputs.path, branch: "", start: "", startLabel: "" }
  : inputs.target === "branch" && inputs.branch === "main"
  ? { action: "attach", source: "/repo", path: "/repo", branch: "main", start: "", startLabel: "", mergeBaseBranch: "origin/main" }
  : { action: "new-branch", source: "/repo", path: "/worktrees/repo/x", branch: "x", start: "refs/remotes/origin/main", startLabel: "origin/main", mergeBaseBranch: "origin/main" };

async function setup(opts: { value?: unknown; fail?: boolean; gh?: boolean; preview?: (inputs: Inputs) => Preview | Promise<Preview> } = {}) {
  const app = await loadPluginApp(() => import("./app"));
  const onChange = vi.fn();
  const slot = renderSlot(app.environmentProviderInputs[0]!, {
    projectId: "project", target: { kind: "existing-host", hostId: "host" }, value: (opts.value ?? null) as never, onChange,
  }, { rpc: {
    choices: () => {
      if (opts.fail) throw new Error("Offline");
      return {
        branches: [
          { name: "main", local: true, remote: "origin", worktree: "/repo", date: Date.now(), ahead: 0, behind: 0 },
          { name: "mine", local: true, remote: "origin", date: Date.now(), ahead: 0, behind: 2 },
          { name: "colleague/review", remote: "origin", local: false, date: Date.now(), ahead: 0, behind: 0 },
        ],
        worktrees: [{ path: "/repo", branch: "main" }, { path: "/worktrees/review", branch: "(detached)" }],
        remotes: ["origin"], defaultRemote: "origin", defaultBase: "origin/main", pathTemplate: "{checkoutParent}/{repo}.{branch}",
      };
    },
    liveBranches: () => ({ branches: [{ remote: "origin", branch: "colleague/review" }, { remote: "origin", branch: "brand-new" }], errors: [] }),
    pulls: () => opts.gh === false ? { available: false, pulls: [] } : { available: true, pulls: [
      { number: 12, title: "Fix login", author: "sam", head: "fix-login", base: "main", fork: false, draft: false, updated: Date.now() },
      { number: 13, title: "Fork tweak", author: "eve", head: "tweak", base: "main", fork: true, draft: true, updated: Date.now() },
    ] },
    preview: (({ inputs }: { inputs: Inputs }) => opts.preview?.(inputs) ?? { ok: true, plan: plan(inputs), warnings: [] }) as (input: unknown) => unknown,
  } });
  return { slot, onChange };
}
const lastValue = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.lastCall?.[0];
const openPicker = () => fireEvent.click(screen.getByRole("button", { name: /^Configure workspace/ }));

it("defaults to a new branch from the remote default, compact in the composer", async () => {
  const { slot, onChange } = await setup();
  await waitFor(() => expect(lastValue(onChange)).toEqual({ status: "ready", value: { target: "new" } }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await screen.findByRole("button", { name: "Configure workspace: New branch from origin/main" });
  openPicker();
  expect(screen.getByRole("dialog", { name: "Work on…" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature/x" } });
  await waitFor(() => expect(lastValue(onChange)).toEqual({ status: "ready", value: { target: "new", branch: "feature/x" } }));
  await screen.findByText(/Creates/);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Configure workspace: feature/x from origin/main" })).toBeTruthy();
  slot.lifecycle.unmount();
});

it("returns to automatic naming from the automatic row", async () => {
  const { slot, onChange } = await setup();
  openPicker();
  fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "feature/x" } });
  await waitFor(() => expect(lastValue(onChange).value).toEqual({ target: "new", branch: "feature/x" }));
  fireEvent.click(screen.getByRole("option", { name: /New branch \(automatic name\)/ }));
  await waitFor(() => expect(lastValue(onChange).value).toEqual({ target: "new" }));
  slot.lifecycle.unmount();
});

it("searches branches and resolves local, attached, and remote-only rows", async () => {
  const { slot, onChange } = await setup();
  openPicker();
  const list = await screen.findByRole("listbox");
  await within(list).findByText("brand-new");
  expect(within(list).getByText(/in \/repo/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search branches, pull requests, or paths"), { target: { value: "colleague" } });
  expect(within(list).queryByText("mine")).toBeNull();
  fireEvent.click(within(list).getByRole("option", { name: /colleague\/review/ }));
  await waitFor(() => expect(lastValue(onChange).value).toEqual({ target: "branch", branch: "colleague/review", remote: "origin", fastForward: true }));
  fireEvent.change(screen.getByLabelText("Search branches, pull requests, or paths"), { target: { value: "mine" } });
  fireEvent.click(within(list).getByRole("option", { name: /^mine/ }));
  expect((await screen.findByRole("checkbox")).closest("label")!.textContent).toContain("origin/mine");
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect(lastValue(onChange).value).toEqual({ target: "branch", branch: "mine", fastForward: false }));
  fireEvent.change(screen.getByLabelText("Search branches, pull requests, or paths"), { target: { value: "main" } });
  fireEvent.click(within(list).getByRole("option", { name: /^main/ }));
  await screen.findByText(/Attaches existing checkout/);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByRole("button", { name: "Configure workspace: main · attached" })).toBeTruthy();
  slot.lifecycle.unmount();
});

it("selects pull requests, keeping fork PRs detached", async () => {
  const { slot, onChange } = await setup();
  openPicker();
  const list = screen.getByRole("listbox");
  fireEvent.click(await within(list).findByRole("option", { name: /#13 Fork tweak/ }));
  await waitFor(() => expect(lastValue(onChange).value).toEqual({ target: "pr", number: 13, checkout: "detached" }));
  expect((screen.getByRole("button", { name: "Branch (can push)" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(list).getByRole("option", { name: /#12 Fix login/ }));
  fireEvent.click(screen.getByRole("button", { name: "Branch (can push)" }));
  await waitFor(() => expect(lastValue(onChange).value).toEqual({ target: "pr", number: 12, checkout: "branch" }));
  slot.lifecycle.unmount();
});

it("accepts a typed PR number without the GitHub CLI, with the keyboard", async () => {
  const { slot, onChange } = await setup({ gh: false });
  openPicker();
  const search = screen.getByLabelText("Search branches, pull requests, or paths");
  fireEvent.change(search, { target: { value: "#42" } });
  await screen.findByRole("option", { name: /PR #42/ });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  await waitFor(() => expect(lastValue(onChange).value).toEqual({ target: "pr", number: 42, checkout: "detached" }));
  slot.lifecycle.unmount();
});

it("attaches a manual path even when discovery fails", async () => {
  const { slot, onChange } = await setup({ fail: true });
  openPicker();
  await screen.findByText(/Couldn’t load branches/);
  fireEvent.click(screen.getByRole("option", { name: /Enter a path/ }));
  await waitFor(() => expect(lastValue(onChange)).toEqual(expect.objectContaining({ status: "blocked" })));
  fireEvent.change(screen.getByLabelText("Checkout path"), { target: { value: "/another/repo" } });
  await waitFor(() => expect(lastValue(onChange)).toEqual({ status: "ready", value: { target: "path", path: "/another/repo" } }));
  slot.lifecycle.unmount();
});

it("blocks launch on preflight errors and keeps form actions from submitting the composer", async () => {
  const { slot, onChange } = await setup({ preview: inputs => inputs.target === "new" && inputs.branch === "taken" ? { ok: false, error: "Branch `taken` already exists." } : { ok: true, plan: plan(inputs), warnings: ["Heads up"] } });
  openPicker();
  await screen.findByText("Heads up");
  fireEvent.change(screen.getByLabelText("Branch name"), { target: { value: "taken" } });
  await waitFor(() => expect(lastValue(onChange)).toEqual({ status: "blocked", reason: "Branch `taken` already exists." }));
  expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Location/ }));
  expect(screen.getByLabelText("Parent directory")).toBeTruthy();
  for (const button of screen.getAllByRole("button")) expect(button.getAttribute("type")).toBe("button");
  for (const option of screen.getAllByRole("option")) expect(option.getAttribute("type")).toBe("button");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  slot.lifecycle.unmount();
});

it("shows input errors instead of a stale \"Checking…\" when inputs become invalid mid-preview", async () => {
  const { slot, onChange } = await setup({ preview: () => new Promise<Preview>(() => {}) });
  openPicker();
  await screen.findByText("Checking…");
  fireEvent.click(screen.getByRole("option", { name: /Enter a path/ }));
  expect(await screen.findByText("Choose or enter a checkout path")).toBeTruthy();
  expect(screen.queryByText("Checking…")).toBeNull();
  await waitFor(() => expect(lastValue(onChange)).toEqual({ status: "blocked", reason: "Choose or enter a checkout path" }));
  slot.lifecycle.unmount();
});

it("overrides the project's template per thread without materializing its defaults", async () => {
  const { slot, onChange } = await setup();
  openPicker();
  fireEvent.click(screen.getByRole("button", { name: /Location/ }));
  expect(await screen.findByText("Template: {checkoutParent}/{repo}.{branch}")).toBeTruthy();
  expect((screen.getByLabelText("Parent directory") as HTMLInputElement).placeholder).toBe("From path template");
  await waitFor(() => expect(lastValue(onChange)).toEqual({ status: "ready", value: { target: "new" } }));
  fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "chosen" } });
  await waitFor(() => expect(lastValue(onChange).value).toEqual({ target: "new", location: { folder: "chosen" } }));
  fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "" } });
  await waitFor(() => expect(lastValue(onChange).value).toEqual({ target: "new" }));
  slot.lifecycle.unmount();
});

it("keeps settings help scannable and reveals details without changing configuration", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const slot = renderSlot(app.settingsSections[0]!, {});
  const layouts = within(screen.getByRole("region", { name: "Common path layouts" }));
  for (const template of ["~/worktrees/{pathKey}", "~/worktrees/{repo}/{pathKey}", "{checkoutParent}/{repo}.{branch}"]) expect(layouts.getByText(template)).toBeTruthy();
  const variables = screen.getByText("Variables and path rules");
  const projects = screen.getByText("Per-project override examples");
  expect((variables.closest("details") as HTMLDetailsElement).open).toBe(false);
  fireEvent.click(variables);
  expect((variables.closest("details") as HTMLDetailsElement).open).toBe(true);
  for (const token of ["{repo}", "{repoPath}", "{checkoutParent}", "{branch}", "{pathKey}"]) {
    expect(within(variables.closest("details")!).getAllByText(token).length).toBeGreaterThan(0);
  }
  expect(screen.getByText("/home/user/GIT/app.feature-login")).toBeTruthy();
  fireEvent.click(projects);
  expect(JSON.parse(projects.closest("details")!.querySelector("pre")!.textContent!)).toEqual({
    "github.com/my-org/*": "{checkoutParent}/{repo}.{branch}", "proj_example": "~/special/{repo}/{pathKey}",
  });
  expect(slot.inspection.rpcCalls).toHaveLength(0);
  slot.lifecycle.unmount();
});
