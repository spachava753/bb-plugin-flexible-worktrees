import type { ReactNode } from "react";
import { Input } from "../components/ui/input";

export type IconKind = "branch" | "new" | "pr" | "folder" | "chevron" | "refresh" | "check";
const paths: Record<IconKind, ReactNode> = {
  branch: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="5" r="2" /><path d="M6 7v10m12-10a10 10 0 0 1-10 10" /></>,
  new: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M18 4v8m-4-4h8" /></>,
  pr: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10m12 0V9a3 3 0 0 0-3-3h-4m2-2-2 2 2 2" /></>,
  folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
  check: <path d="m5 12 4 4L19 6" />,
};
export function Icon({ kind, className = "" }: { kind: IconKind; className?: string }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`}>{paths[kind]}</svg>;
}

/** Render `code` spans from plan descriptions and messages. */
export function Text({ children }: { children: string }) {
  return <>{children.split("`").map((part, i) => i % 2 ? <code key={i} className="break-all rounded bg-muted px-1 font-mono text-[11px]">{part}</code> : part)}</>;
}

export function Row({ icon, title, detail }: { icon: IconKind; title: string; detail?: string }) {
  return <span className="flex min-w-0 items-center gap-2">
    <Icon kind={icon} className="text-muted-foreground" />
    <span className="grid min-w-0 gap-0.5">
      <span className="truncate text-sm">{title}</span>
      {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
    </span>
  </span>;
}

export function Field({ id, label, value, placeholder, hint, list, onChange }: { id: string; label: string; value: string; placeholder: string; hint?: string; list?: string; onChange(value: string): void }) {
  return <div className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
    <label htmlFor={id}>{label}</label>
    <Input id={id} list={list} aria-describedby={hint ? `${id}-hint` : undefined} className="h-8 min-w-0 bg-background text-sm" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
    {hint && <span id={`${id}-hint`} className="text-xs font-normal text-muted-foreground">{hint}</span>}
  </div>;
}

/** Compact relative age: 5m, 3h, 2d, 1y. */
export function ago(ms: number) {
  if (!ms) return "";
  const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : minutes < 525_600 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 525_600)}y`;
}
