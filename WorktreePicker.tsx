import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Input } from "./components/ui/input";
import { Button } from "./components/ui/button";
import { describePlan, inputsSchema, shortPath, type BranchRow, type Choices, type Inputs, type LiveBranches, type Preview, type Pull, type Pulls } from "./inputs";

export { shortPath };
export interface WorktreePickerProps {
  form: Inputs;
  onChange(form: Inputs): void;
  choices: Choices | null;
  choicesError: string;
  live: LiveBranches | null;
  pulls: Pulls | null;
  remoteLoading: boolean;
  preview: Preview | null;
  checking: boolean;
  onOpen(): void;
  onRefresh(): void;
}

type IconKind = "branch" | "new" | "pr" | "folder" | "chevron" | "refresh" | "check";
function Icon({ kind, className = "" }: { kind: IconKind; className?: string }) {
  const paths: Record<IconKind, ReactNode> = {
    branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10m12-10a10 10 0 0 1-10 10" /></>,
    new: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M18 4v8m-4-4h8" /></>,
    pr: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10m12 0V9a3 3 0 0 0-3-3h-4m2-2-2 2 2 2" /></>,
    folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />,
    chevron: <path d="m8 10 4 4 4-4" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`}>{paths[kind]}</svg>;
}

/** Render `code` spans from plan descriptions and messages. */
function Text({ children }: { children: string }) {
  return <>{children.split("`").map((part, i) => i % 2 ? <code key={i} className="break-all rounded bg-muted px-1 font-mono text-[11px]">{part}</code> : part)}</>;
}
function ago(ms: number) {
  if (!ms) return "";
  const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : minutes < 525_600 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 525_600)}y`;
}
const isPath = (q: string) => /^(\/|~(\/|$))/.test(q);
const prNumber = (q: string) => /^#?(\d{1,7})$/.exec(q.trim())?.[1];
const locationOf = (form: Inputs) => form.target === "path" ? undefined : form.location;
const LIMIT = 8;

type Option = { id: string; section: string; selected: boolean; render: ReactNode; select(): void };

export function WorktreePicker({ form, onChange, choices, choicesError, live, pulls, remoteLoading, preview, checking, onOpen, onRefresh }: WorktreePickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pathEntry, setPathEntry] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const q = query.trim().toLowerCase();
  const location = locationOf(form);
  const defaultBase = choices?.defaultBase ?? "the default branch";

  const branches = useMemo(() => {
    const rows = [...choices?.branches ?? []];
    const known = new Set(rows.map(r => `${r.remote ?? ""}\0${r.name}`));
    for (const b of live?.branches ?? []) if (!known.has(`${b.remote}\0${b.branch}`)) rows.push({ name: b.branch, remote: b.remote, local: false, date: 0, ahead: 0, behind: 0, unfetched: true });
    return rows;
  }, [choices, live]);
  const localNames = useMemo(() => new Set(branches.filter(b => b.local).map(b => b.name)), [branches]);
  const selectedBranch = form.target === "branch" ? branches.find(b => b.name === form.branch && (form.remote ? !b.local && b.remote === form.remote : b.local)) : undefined;
  const selectedPull = form.target === "pr" ? pulls?.pulls.find(p => p.number === form.number) : undefined;

  const parsed = inputsSchema.safeParse(form);
  const blocked = !parsed.success ? parsed.error.issues[0]!.message : preview && !preview.ok && !checking ? preview.error : "";
  const warnings = preview?.ok && !checking ? preview.warnings : [];

  const choose = (next: Inputs) => { onChange(next); setPathEntry(false); };
  const pickBranch = (row: BranchRow) => choose(row.local
    ? { target: "branch", branch: row.name, fastForward: true, location }
    : { target: "branch", branch: row.name, remote: row.remote, fastForward: true, location, ...(localNames.has(row.name) ? { localName: `${row.name}-2` } : {}) });
  const pickPull = (number: number) => choose({ target: "pr", number, checkout: "detached", location });

  const sections: { key: string; title: string; options: Option[]; note?: ReactNode }[] = [];
  const exact = branches.some(b => b.name.toLowerCase() === q);
  const typedName = q && !exact && !isPath(query.trim()) && !prNumber(query) ? query.trim() : "";
  sections.push({ key: "new", title: "New", options: [{
    id: "new", section: "new", selected: form.target === "new",
    render: <Row icon="new" title={typedName ? `New branch "${typedName}"` : "New branch (automatic name)"} detail={`from ${form.target === "new" && form.base || defaultBase}`} />,
    // The automatic row means BB names the branch, so it clears any typed name.
    select: () => choose({ target: "new", branch: typedName || undefined, base: form.target === "new" ? form.base : undefined, location }),
  }] });

  if (pulls?.available || prNumber(query) || !pulls) {
    const needle = q.replace(/^#/, "");
    const matches = (pulls?.pulls ?? []).filter(p => !needle || `${p.number} ${p.title} ${p.author} ${p.head}`.toLowerCase().includes(needle));
    const typed = prNumber(query);
    const options: Option[] = matches.map(p => pullOption(p, form, () => pickPull(p.number)));
    if (typed && !matches.some(p => p.number === Number(typed))) options.unshift({
      id: `pr-${typed}`, section: "pr", selected: form.target === "pr" && form.number === Number(typed),
      render: <Row icon="pr" title={`PR #${typed}`} detail="Fetch this pull request by number" />, select: () => pickPull(Number(typed)),
    });
    const note = !pulls ? (remoteLoading ? "Loading pull requests…" : undefined) : pulls.message ? <Text>{pulls.message}</Text> : !options.length && pulls.available ? (q ? "No open PRs match." : "No open PRs.") : undefined;
    if (options.length || note) sections.push({ key: "pr", title: "Pull requests", options, note });
  } else if (pulls?.message) sections.push({ key: "pr", title: "Pull requests", options: [], note: <Text>{pulls.message}</Text> });

  const branchOptions = branches.filter(b => !q || `${b.remote ?? ""}/${b.name}`.toLowerCase().includes(q)).map<Option>(b => ({
    id: `b-${b.local ? "" : b.remote}-${b.name}`, section: "branches",
    selected: form.target === "branch" && form.branch === b.name && (form.remote ? !b.local && form.remote === b.remote : b.local),
    render: <Row icon="branch" title={b.name} detail={[
      ago(b.date),
      b.worktree ? `in ${shortPath(b.worktree)}` : "",
      !b.local ? (b.unfetched ? `not fetched · ${b.remote}` : `remote only · ${b.remote}`) : "",
      b.behind ? `↓${b.behind}` : "", b.ahead ? `↑${b.ahead}` : "",
    ].filter(Boolean).join(" · ")} />,
    select: () => pickBranch(b),
  }));
  const branchNote = choicesError ? <>Couldn’t load branches. <Text>{choicesError}</Text></> : !choices ? "Loading branches…" : !branchOptions.length ? "No branches match." : undefined;
  const liveErrors = live?.errors.map(e => <span key={e} className="block"><Text>{e}</Text></span>);
  sections.push({ key: "branches", title: "Branches", options: branchOptions, note: branchNote || liveErrors?.length ? <>{branchNote}{liveErrors}</> : undefined });

  const detached = (choices?.worktrees ?? []).filter(w => w.branch === "(detached)" && (!q || w.path.toLowerCase().includes(q)));
  const worktreeOptions: Option[] = detached.map(w => ({
    id: `w-${w.path}`, section: "worktrees", selected: form.target === "path" && form.path === w.path,
    render: <Row icon="folder" title={shortPath(w.path)} detail="detached" />, select: () => choose({ target: "path", path: w.path }),
  }));
  worktreeOptions.push(isPath(query.trim())
    ? { id: "typed-path", section: "worktrees", selected: form.target === "path" && form.path === query.trim(), render: <Row icon="folder" title={`Use ${query.trim()}`} detail="Attach this checkout as-is" />, select: () => choose({ target: "path", path: query.trim() }) }
    : { id: "enter-path", section: "worktrees", selected: pathEntry, render: <Row icon="folder" title="Enter a path…" detail="Another worktree or clone on this machine" />, select: () => { onChange({ target: "path", path: form.target === "path" ? form.path : "" }); setPathEntry(true); } });
  sections.push({ key: "worktrees", title: "Worktrees", options: worktreeOptions });

  // Cap long sections; the "show more" row is itself keyboard-selectable.
  const visible = sections.map(s => {
    if (expanded[s.key] || s.options.length <= LIMIT) return s;
    const more: Option = { id: `more-${s.key}`, section: s.key, selected: false, render: <span className="px-1 text-xs text-muted-foreground">Show {s.options.length - LIMIT} more</span>, select: () => setExpanded(e => ({ ...e, [s.key]: true })) };
    return { ...s, options: [...s.options.slice(0, LIMIT), more] };
  });
  const flat = visible.flatMap(s => s.options);
  const current = Math.min(active, flat.length - 1);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      flat[current]?.select();
    }
  };

  const triggerIcon: IconKind = form.target === "new" ? "new" : form.target === "pr" ? "pr" : form.target === "path" ? "folder" : "branch";
  const attached = preview?.ok && preview.plan.action === "attach";
  const summary = form.target === "new" ? `${form.branch || "New branch"} from ${form.base || choices?.defaultBase || "default"}`
    : form.target === "branch" ? `${form.branch}${attached ? " · attached" : ""}`
    : form.target === "pr" ? `#${form.number}${selectedPull ? ` ${selectedPull.title}` : ""}`
    : (choices?.worktrees.find(w => w.path === form.path)?.branch.replace("(detached)", "") || shortPath(form.path).split("/").filter(Boolean).pop() || "Choose checkout") + " · attached";
  const tooltip = preview?.ok ? preview.plan.path || "New folder" : blocked || summary;
  const setField = (patch: Record<string, unknown>) => onChange({ ...form, ...patch } as Inputs);
  const setLocation = (key: "root" | "folder", value: string) => {
    const next = { ...location, [key]: value || undefined };
    setField({ location: next.root || next.folder ? next : undefined });
  };

  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) onOpen(); }}>
    <Popover.Trigger asChild>
      <button type="button" aria-label={`Configure workspace: ${summary}`} title={tooltip}
        className="inline-flex h-8 max-w-[260px] min-w-0 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon kind={triggerIcon} />
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
          <Input id={`${id}-search`} role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-label="Search branches, pull requests, or paths"
            aria-activedescendant={flat[current] ? `${id}-${flat[current].id}` : undefined} autoComplete="off"
            className="h-8 text-sm" placeholder="Branch, PR #, or path…" value={query}
            onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKeyDown} />
          <div id={`${id}-list`} role="listbox" aria-label="Workspace choices" className="max-h-72 overflow-y-auto rounded-lg border border-border p-1">
            {visible.map(s => <div key={s.key} role="group" aria-label={s.title} className="py-0.5">
              <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{s.title}</div>
              {s.options.map(o => {
                const index = flat.indexOf(o);
                return <button type="button" key={o.id} id={`${id}-${o.id}`} role="option" aria-selected={o.selected} tabIndex={-1}
                  onMouseEnter={() => setActive(index)} onClick={o.select}
                  className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left ${index === current ? "bg-accent text-accent-foreground" : "text-foreground"}`}>
                  <span className="min-w-0 flex-1">{o.render}</span>
                  {o.selected && <Icon kind="check" />}
                </button>;
              })}
              {s.note && <p className="px-2 py-1.5 text-xs text-muted-foreground">{s.note}</p>}
            </div>)}
          </div>

          <div className="grid gap-3 rounded-lg bg-muted/50 p-3">
            {form.target === "new" && <div className="grid grid-cols-2 gap-3">
              <Field id={`${id}-branch`} label="Branch name" value={form.branch ?? ""} placeholder="Automatic" onChange={v => setField({ branch: v || undefined })} />
              <Field id={`${id}-base`} label="Base" value={form.base ?? ""} placeholder={defaultBase} list={`${id}-bases`} onChange={v => setField({ base: v || undefined })} />
              <datalist id={`${id}-bases`}>{branches.slice(0, 200).map(b => <option key={`${b.remote}/${b.name}/${b.local}`} value={b.local ? b.name : `${b.remote}/${b.name}`} />)}</datalist>
            </div>}
            {form.target === "branch" && selectedBranch?.local && selectedBranch.behind > 0 && selectedBranch.ahead === 0 && <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={form.fastForward} onChange={e => setField({ fastForward: e.target.checked })} />
              Fast-forward to <code className="font-mono">{selectedBranch.remote}/{selectedBranch.name}</code> first
            </label>}
            {form.target === "branch" && form.remote && localNames.has(form.branch) && <Field id={`${id}-local`} label="Local branch name" value={form.localName ?? ""} placeholder={`${form.branch}-2`}
              hint={`Local ${form.branch} already exists and doesn't track ${form.remote}/${form.branch}.`} onChange={v => setField({ localName: v || undefined })} />}
            {form.target === "pr" && <div role="group" aria-label="Checkout" className="flex gap-1 rounded-lg bg-muted p-1">
              {([["detached", "Detached (review)"], ["branch", "Branch (can push)"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={form.checkout === value}
                disabled={value === "branch" && (selectedPull?.fork || !pulls?.available)} title={value === "branch" && selectedPull?.fork ? "Fork PRs can only be reviewed detached" : undefined}
                onClick={() => setField({ checkout: value })}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ${form.checkout === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}
            </div>}
            {form.target === "path" && (pathEntry || !choices?.worktrees.some(w => w.path === form.path)) && <Field id={`${id}-path`} label="Checkout path" value={form.path} placeholder="~/dev/my-repo"
              hint="An absolute path or ~/path on the selected machine. Used as-is: no Git changes." onChange={v => setField({ path: v })} />}

            <div aria-live="polite" className="grid gap-1.5 text-xs leading-relaxed">
              {checking && parsed.success ? <p className="text-muted-foreground">Checking…</p>
                : blocked ? <p role="alert" className="text-destructive"><Text>{blocked}</Text></p>
                : preview?.ok ? <p><Text>{describePlan(preview.plan)}</Text></p> : null}
              {warnings.map(w => <p key={w} className="text-amber-600 dark:text-amber-400"><Text>{w}</Text></p>)}
            </div>

            {form.target !== "path" && <div className="grid gap-2">
              <button type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <Icon kind="chevron" className={advanced ? "" : "-rotate-90"} /> Location
              </button>
              {advanced && <div className="grid grid-cols-2 gap-3">
                <Field id={`${id}-root`} label="Parent directory" value={location?.root ?? ""} placeholder={choices?.defaultRoot ?? "~/dev/worktrees/{repo}"} onChange={v => setLocation("root", v)} />
                <Field id={`${id}-folder`} label="Folder name" value={location?.folder ?? ""} placeholder="From branch name" onChange={v => setLocation("folder", v)} />
              </div>}
            </div>}
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

function pullOption(p: Pull, form: Inputs, select: () => void): Option {
  return {
    id: `pr-${p.number}`, section: "pr", selected: form.target === "pr" && form.number === p.number, select,
    render: <Row icon="pr" title={`#${p.number} ${p.title}`} detail={[p.author, `${p.head} → ${p.base}`, ago(p.updated), p.draft ? "Draft" : "", p.fork ? "Fork" : ""].filter(Boolean).join(" · ")} />,
  };
}
function Row({ icon, title, detail }: { icon: IconKind; title: string; detail?: string }) {
  return <span className="flex min-w-0 items-center gap-2">
    <Icon kind={icon} className="text-muted-foreground" />
    <span className="grid min-w-0 gap-0.5">
      <span className="truncate text-sm">{title}</span>
      {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
    </span>
  </span>;
}
function Field({ id, label, value, placeholder, hint, list, onChange }: { id: string; label: string; value: string; placeholder: string; hint?: string; list?: string; onChange(value: string): void }) {
  return <div className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
    <label htmlFor={id}>{label}</label>
    <Input id={id} list={list} aria-describedby={hint ? `${id}-hint` : undefined} className="h-8 min-w-0 bg-background text-sm" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
    {hint && <span id={`${id}-hint`} className="text-xs font-normal text-muted-foreground">{hint}</span>}
  </div>;
}
