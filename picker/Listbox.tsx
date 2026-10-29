import { useState, type KeyboardEvent } from "react";
import { Icon } from "./parts";
import type { Option, Section } from "./options";

const LIMIT = 8;

/**
 * Active-descendant listbox state for options driven from a separate search input:
 * caps long sections behind a selectable "Show N more" row and handles arrow/Enter keys.
 */
export function useListbox(sections: Section[], idPrefix: string) {
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const visible = sections.map(s => {
    if (expanded[s.key] || s.options.length <= LIMIT) return s;
    const more: Option = { id: `more-${s.key}`, selected: false, render: <span className="px-1 text-xs text-muted-foreground">Show {s.options.length - LIMIT} more</span>, select: () => setExpanded(e => ({ ...e, [s.key]: true })) };
    return { ...s, options: [...s.options.slice(0, LIMIT), more] };
  });
  const flat = visible.flatMap(s => s.options);
  const current = Math.min(active, flat.length - 1);
  const optionId = (o: Option) => `${idPrefix}-${o.id}`;
  return {
    visible, flat, current, setActive, optionId, listId: `${idPrefix}-list`,
    activeId: flat[current] ? optionId(flat[current]) : undefined,
    onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((current + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        flat[current]?.select();
      }
    },
  };
}

export function Listbox({ label, listbox }: { label: string; listbox: ReturnType<typeof useListbox> }) {
  const { visible, flat, current, setActive, optionId, listId } = listbox;
  return <div id={listId} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto rounded-lg border border-border p-1">
    {visible.map(s => <div key={s.key} role="group" aria-label={s.title} className="py-0.5">
      <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{s.title}</div>
      {s.options.map(o => {
        const index = flat.indexOf(o);
        return <button type="button" key={o.id} id={optionId(o)} role="option" aria-selected={o.selected} tabIndex={-1}
          onMouseEnter={() => setActive(index)} onClick={o.select}
          className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left ${index === current ? "bg-accent text-accent-foreground" : "text-foreground"}`}>
          <span className="min-w-0 flex-1">{o.render}</span>
          {o.selected && <Icon kind="check" />}
        </button>;
      })}
      {s.note && <p className="px-2 py-1.5 text-xs text-muted-foreground">{s.note}</p>}
    </div>)}
  </div>;
}
