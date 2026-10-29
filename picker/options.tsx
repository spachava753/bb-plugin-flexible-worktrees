import type { ReactNode } from "react";
import { shortPath, type BranchRow, type Choices, type Inputs, type LiveBranches, type Pulls } from "../inputs";
import { ago, Row, Text } from "./parts";

export type Option = { id: string; selected: boolean; render: ReactNode; select(): void };
export type Section = { key: string; title: string; options: Option[]; note?: ReactNode };
export type PickerData = { choices: Choices | null; choicesError: string; live: LiveBranches | null; pulls: Pulls | null; remoteLoading: boolean };
type Actions = { choose(next: Inputs): void; enterPath(): void };
type Model = { query: string; form: Inputs; data: PickerData; branches: BranchRow[]; pathEntry: boolean };

const isPath = (q: string) => /^(\/|~(\/|$))/.test(q);
export const prNumber = (q: string) => /^#?(\d{1,7})$/.exec(q.trim())?.[1];
export const locationOf = (form: Inputs) => form.target === "path" ? undefined : form.location;
const detail = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" · ");

/** Local refs plus live remote heads that haven't been fetched yet. */
export function mergeBranches(choices: Choices | null, live: LiveBranches | null): BranchRow[] {
  const rows = [...choices?.branches ?? []];
  const known = new Set(rows.map(r => `${r.remote ?? ""}\0${r.name}`));
  for (const b of live?.branches ?? []) if (!known.has(`${b.remote}\0${b.branch}`)) rows.push({ name: b.branch, remote: b.remote, local: false, date: 0, ahead: 0, behind: 0, unfetched: true });
  return rows;
}
/** The row for a branch target: local unless a remote was chosen. */
export const matchesBranch = (form: Inputs, b: BranchRow) =>
  form.target === "branch" && form.branch === b.name && (form.remote ? !b.local && form.remote === b.remote : b.local);

/** The picker's sections for this query, in display order. Each option knows how to select itself. */
export function sections(m: Model, actions: Actions): Section[] {
  const q = m.query.trim().toLowerCase();
  return [newSection(m, q, actions), pullSection(m, q, actions), branchSection(m, q, actions), worktreeSection(m, q, actions)].filter((s): s is Section => Boolean(s));
}

function newSection({ query, form, branches, data }: Model, q: string, { choose }: Actions): Section {
  const exact = branches.some(b => b.name.toLowerCase() === q);
  const typed = q && !exact && !isPath(query.trim()) && !prNumber(query) ? query.trim() : "";
  const base = form.target === "new" ? form.base : undefined;
  return { key: "new", title: "New", options: [{
    id: "new", selected: form.target === "new",
    render: <Row icon="new" title={typed ? `New branch "${typed}"` : "New branch (automatic name)"} detail={`from ${base || data.choices?.defaultBase || "the default branch"}`} />,
    // The automatic row means BB names the branch, so it clears any typed name.
    select: () => choose({ target: "new", branch: typed || undefined, base, location: locationOf(form) }),
  }] };
}

function pullSection({ query, form, data: { pulls, remoteLoading } }: Model, q: string, { choose }: Actions): Section | null {
  const typed = prNumber(query);
  if (pulls && !pulls.available && !typed) return pulls.message ? { key: "pr", title: "Pull requests", options: [], note: <Text>{pulls.message}</Text> } : null;
  const pick = (number: number) => () => choose({ target: "pr", number, checkout: "detached", location: locationOf(form) });
  const selected = (number: number) => form.target === "pr" && form.number === number;
  const needle = q.replace(/^#/, "");
  const matches = (pulls?.pulls ?? []).filter(p => !needle || `${p.number} ${p.title} ${p.author} ${p.head}`.toLowerCase().includes(needle));
  const options: Option[] = matches.map(p => ({
    id: `pr-${p.number}`, selected: selected(p.number), select: pick(p.number),
    render: <Row icon="pr" title={`#${p.number} ${p.title}`} detail={detail(p.author, `${p.head} → ${p.base}`, ago(p.updated), p.draft && "Draft", p.fork && "Fork")} />,
  }));
  // Any number can be fetched by its pull/merge-request ref, listed or not.
  if (typed && !matches.some(p => p.number === Number(typed))) options.unshift({
    id: `pr-${typed}`, selected: selected(Number(typed)), select: pick(Number(typed)),
    render: <Row icon="pr" title={`PR #${typed}`} detail="Fetch this pull request by number" />,
  });
  const note = !pulls ? (remoteLoading ? "Loading pull requests…" : undefined)
    : pulls.message ? <Text>{pulls.message}</Text>
    : !options.length && pulls.available ? (q ? "No open PRs match." : "No open PRs.") : undefined;
  return options.length || note ? { key: "pr", title: "Pull requests", options, note } : null;
}

function branchSection({ form, branches, data: { choices, choicesError, live } }: Model, q: string, { choose }: Actions): Section {
  const localNames = new Set(branches.filter(b => b.local).map(b => b.name));
  const location = locationOf(form);
  const options = branches.filter(b => !q || `${b.remote ?? ""}/${b.name}`.toLowerCase().includes(q)).map<Option>(b => ({
    id: `b-${b.local ? "" : b.remote}-${b.name}`, selected: matchesBranch(form, b),
    render: <Row icon="branch" title={b.name} detail={detail(
      ago(b.date), b.worktree && `in ${shortPath(b.worktree)}`,
      !b.local && (b.unfetched ? `not fetched · ${b.remote}` : `remote only · ${b.remote}`),
      b.behind > 0 && `↓${b.behind}`, b.ahead > 0 && `↑${b.ahead}`,
    )} />,
    select: () => choose(b.local
      ? { target: "branch", branch: b.name, fastForward: true, location }
      : { target: "branch", branch: b.name, remote: b.remote, fastForward: true, location, ...(localNames.has(b.name) ? { localName: `${b.name}-2` } : {}) }),
  }));
  const status = choicesError ? <>Couldn’t load branches. <Text>{choicesError}</Text></> : !choices ? "Loading branches…" : !options.length ? "No branches match." : undefined;
  const liveErrors = live?.errors.map(e => <span key={e} className="block"><Text>{e}</Text></span>);
  return { key: "branches", title: "Branches", options, note: status || liveErrors?.length ? <>{status}{liveErrors}</> : undefined };
}

function worktreeSection({ query, form, data: { choices }, pathEntry }: Model, q: string, { choose, enterPath }: Actions): Section {
  const path = query.trim();
  const detached = (choices?.worktrees ?? []).filter(w => w.branch === "(detached)" && (!q || w.path.toLowerCase().includes(q)));
  const options: Option[] = detached.map(w => ({
    id: `w-${w.path}`, selected: form.target === "path" && form.path === w.path,
    render: <Row icon="folder" title={shortPath(w.path)} detail="detached" />, select: () => choose({ target: "path", path: w.path }),
  }));
  options.push(isPath(path)
    ? { id: "typed-path", selected: form.target === "path" && form.path === path, render: <Row icon="folder" title={`Use ${path}`} detail="Attach this checkout as-is" />, select: () => choose({ target: "path", path }) }
    : { id: "enter-path", selected: pathEntry, render: <Row icon="folder" title="Enter a path…" detail="Another worktree or clone on this machine" />, select: enterPath });
  return { key: "worktrees", title: "Worktrees", options };
}
