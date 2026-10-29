import { useId, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { inputsSchema, type Inputs, type Preview } from "./inputs";
import { summarize, targetIcon } from "./picker/describe";
import { LocationFields, PlanStatus, TargetFields } from "./picker/Details";
import { Listbox, useListbox } from "./picker/Listbox";
import { locationOf, mergeBranches, sections, type PickerData } from "./picker/options";
import { Icon } from "./picker/parts";

export interface WorktreePickerProps extends PickerData {
  form: Inputs;
  onChange(form: Inputs): void;
  preview: Preview | null;
  checking: boolean;
  onOpen(): void;
  onRefresh(): void;
}

/** Compact composer trigger plus the portalled "Work on…" popover. */
export function WorktreePicker({ form, onChange, preview, checking, onOpen, onRefresh, ...data }: WorktreePickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pathEntry, setPathEntry] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const { choices, pulls, remoteLoading } = data;
  const branches = useMemo(() => mergeBranches(choices, data.live), [choices, data.live]);
  const pull = form.target === "pr" ? pulls?.pulls.find(p => p.number === form.number) : undefined;

  const parsed = inputsSchema.safeParse(form);
  const blocked = !parsed.success ? parsed.error.issues[0]!.message : preview && !preview.ok && !checking ? preview.error : "";
  const warnings = preview?.ok && !checking ? preview.warnings : [];

  const listbox = useListbox(sections({ query, form, data, branches, pathEntry }, {
    choose: next => { onChange(next); setPathEntry(false); },
    enterPath: () => { onChange({ target: "path", path: form.target === "path" ? form.path : "" }); setPathEntry(true); },
  }), id);
  const summary = summarize(form, choices, preview, pull);
  const location = locationOf(form);

  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) onOpen(); }}>
    <Popover.Trigger asChild>
      <button type="button" aria-label={`Configure workspace: ${summary}`} title={preview?.ok ? preview.plan.path || "New folder" : blocked || summary}
        className="inline-flex h-8 max-w-[260px] min-w-0 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon kind={targetIcon(form)} />
        <span className="truncate">{summary}</span>
        {blocked ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-label="Configuration required" />
          : warnings.length > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-label="Has warnings" />}
        <Icon kind="chevron" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content align="end" side="bottom" sideOffset={8} collisionPadding={12} aria-labelledby={`${id}-title`}
        onOpenAutoFocus={e => { e.preventDefault(); document.getElementById(`${id}-search`)?.focus(); }}
        style={{ width: "min(440px, calc(100vw - 24px))", maxHeight: "var(--radix-popover-content-available-height)", overflowY: "auto" }}
        className="z-50 rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
        <div className="grid gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 id={`${id}-title`} className="text-sm font-semibold">Work on…</h2>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Refresh branches and pull requests" disabled={remoteLoading} onClick={onRefresh}>
              <Icon kind="refresh" className={remoteLoading ? "animate-spin" : ""} />
            </Button>
          </div>
          <Input id={`${id}-search`} role="combobox" aria-expanded="true" aria-controls={listbox.listId} aria-label="Search branches, pull requests, or paths"
            aria-activedescendant={listbox.activeId} autoComplete="off" className="h-8 text-sm" placeholder="Branch, PR #, or path…" value={query}
            onChange={e => { setQuery(e.target.value); listbox.setActive(0); }} onKeyDown={listbox.onKeyDown} />
          <Listbox label="Workspace choices" listbox={listbox} />
          <div className="grid gap-3 rounded-lg bg-muted/50 p-3">
            <TargetFields id={id} form={form} onChange={onChange} branches={branches} defaultBase={choices?.defaultBase ?? "the default branch"}
              pull={pull} canCheckoutBranch={Boolean(pulls?.available)} showPath={pathEntry || !choices?.worktrees.some(w => form.target === "path" && w.path === form.path)} />
            <PlanStatus checking={checking && parsed.success} blocked={blocked} preview={preview} warnings={warnings} />
            {form.target !== "path" ? <LocationFields id={id} open={advanced} onToggle={() => setAdvanced(!advanced)}
              root={location?.root ?? ""} folder={location?.folder ?? ""} defaultRoot={choices?.defaultRoot ?? "~/dev/worktrees/{repo}"}
              onChange={(key, value) => {
                const next = { ...location, [key]: value || undefined };
                onChange({ ...form, location: next.root || next.folder ? next : undefined });
              }} /> : null}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="text-xs text-muted-foreground" title="Archiving or deleting a thread keeps its worktree and branch. Remove them with git worktree when finished.">Files are kept when threads close.</span>
          <Popover.Close asChild><Button type="button" size="sm" className="h-7 px-3 text-xs" disabled={Boolean(blocked)}>Done</Button></Popover.Close>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
