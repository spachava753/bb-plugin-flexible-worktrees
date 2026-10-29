import type { BranchRow, Inputs, Preview, Pull } from "../inputs";
import { describePlan } from "./describe";
import { Field, Icon, Text } from "./parts";

/** Options that only make sense for the selected target. Each case emits complete inputs of its own variant. */
export function TargetFields({ id, form, onChange, branches, defaultBase, pull, canCheckoutBranch, showPath }: {
  id: string; form: Inputs; onChange(next: Inputs): void; branches: BranchRow[]; defaultBase: string;
  pull?: Pull; canCheckoutBranch: boolean; showPath: boolean;
}) {
  switch (form.target) {
    case "new": return <div className="grid grid-cols-2 gap-3">
      <Field id={`${id}-branch`} label="Branch name" value={form.branch ?? ""} placeholder="Automatic" onChange={v => onChange({ ...form, branch: v || undefined })} />
      <Field id={`${id}-base`} label="Base" value={form.base ?? ""} placeholder={defaultBase} list={`${id}-bases`} onChange={v => onChange({ ...form, base: v || undefined })} />
      <datalist id={`${id}-bases`}>{branches.slice(0, 200).map(b => <option key={`${b.remote}/${b.name}/${b.local}`} value={b.local ? b.name : `${b.remote}/${b.name}`} />)}</datalist>
    </div>;
    case "branch": {
      const row = branches.find(b => b.local && b.name === form.branch);
      const collides = Boolean(form.remote) && Boolean(row);
      return <>
        {!form.remote && row && row.behind > 0 && row.ahead === 0 && <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={form.fastForward} onChange={e => onChange({ ...form, fastForward: e.target.checked })} />
          Fast-forward to <code className="font-mono">{row.remote}/{row.name}</code> first
        </label>}
        {collides && <Field id={`${id}-local`} label="Local branch name" value={form.localName ?? ""} placeholder={`${form.branch}-2`}
          hint={`Local ${form.branch} already exists and doesn't track ${form.remote}/${form.branch}.`} onChange={v => onChange({ ...form, localName: v || undefined })} />}
      </>;
    }
    case "pr": return <div role="group" aria-label="Checkout" className="flex gap-1 rounded-lg bg-muted p-1">
      {([["detached", "Detached (review)"], ["branch", "Branch (can push)"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={form.checkout === value}
        disabled={value === "branch" && (pull?.fork || !canCheckoutBranch)} title={value === "branch" && pull?.fork ? "Fork PRs can only be reviewed detached" : undefined}
        onClick={() => onChange({ ...form, checkout: value })}
        className={`flex-1 rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50 ${form.checkout === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}
    </div>;
    case "path": return showPath ? <Field id={`${id}-path`} label="Checkout path" value={form.path} placeholder="~/dev/my-repo"
      hint="An absolute path or ~/path on the selected machine. Used as-is: no Git changes." onChange={v => onChange({ ...form, path: v })} /> : null;
  }
}

/** What launching will do, or why it can't. */
export function PlanStatus({ checking, blocked, preview, warnings }: { checking: boolean; blocked: string; preview: Preview | null; warnings: string[] }) {
  return <div aria-live="polite" className="grid gap-1.5 text-xs leading-relaxed">
    {checking ? <p className="text-muted-foreground">Checking…</p>
      : blocked ? <p role="alert" className="text-destructive"><Text>{blocked}</Text></p>
      : preview?.ok ? <p><Text>{describePlan(preview.plan)}</Text></p> : null}
    {warnings.map(w => <p key={w} className="text-amber-600 dark:text-amber-400"><Text>{w}</Text></p>)}
  </div>;
}

/** Per-thread overrides of the project's path template; blank fields keep the template's parts. */
export function LocationFields({ id, open, onToggle, root, folder, template, onChange }: {
  id: string; open: boolean; onToggle(): void; root: string; folder: string; template: string; onChange(key: "root" | "folder", value: string): void;
}) {
  return <div className="grid gap-2">
    <button type="button" aria-expanded={open} onClick={onToggle} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <Icon kind="chevron" className={open ? "" : "-rotate-90"} /> Location
    </button>
    {open && <>
      <div className="grid grid-cols-2 gap-3">
        <Field id={`${id}-root`} label="Parent directory" value={root} placeholder="From path template" onChange={v => onChange("root", v)} />
        <Field id={`${id}-folder`} label="Folder name" value={folder} placeholder="From path template" onChange={v => onChange("folder", v)} />
      </div>
      <p className="text-xs text-muted-foreground">Blank fields use the path template. Edit either to override that part for this thread.</p>
      <p className="break-all font-mono text-xs text-muted-foreground">Template: {template}</p>
    </>}
  </div>;
}
