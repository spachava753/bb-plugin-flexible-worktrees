import type { BranchRow, Choices, LiveBranches } from "../inputs";
import { repo } from "./git";
import { defaultBase, defaultRemote } from "./plan";
import { HEADS, parseTrack, splitRemoteRef } from "./refs";

/** Branch rows for the picker from local refs only: instant, possibly stale. Local branches absorb their upstream rows. */
export async function choices(source: string, signal?: AbortSignal): Promise<Omit<Choices, "pathTemplate">> {
  const r = repo(source, signal);
  const remotes = await r.remotes();
  const remote = defaultRemote(remotes);
  const refs = await r.refs({ ref: "refname", date: "committerdate:unix", worktree: "worktreepath", upstream: "upstream", upstreamRemote: "upstream:remotename", track: "upstream:track", symref: "symref" }, ["refs/heads", "refs/remotes"], "-committerdate");
  const locals = refs.filter(row => row.ref.startsWith(HEADS));
  const upstreams = new Set(locals.map(row => row.upstream).filter(Boolean));
  const rows: BranchRow[] = locals.map(row => {
    const t = parseTrack(row.track);
    return { name: row.ref.slice(HEADS.length), local: true, date: Number(row.date) * 1000, ahead: t.ahead, behind: t.behind,
      ...(row.worktree ? { worktree: row.worktree } : {}), ...(row.upstreamRemote && row.upstream.startsWith("refs/remotes/") && !t.gone ? { remote: row.upstreamRemote } : {}) };
  });
  for (const row of refs) {
    const split = !row.ref.startsWith(HEADS) && !row.symref && !upstreams.has(row.ref) ? splitRemoteRef(row.ref, remotes) : null;
    if (split) rows.push({ name: split.branch, remote: split.remote, local: false, date: Number(row.date) * 1000, ahead: 0, behind: 0 });
  }
  rows.sort((a, b) => b.date - a.date);
  return {
    branches: rows, worktrees: await r.worktrees(), remotes,
    ...(remote ? { defaultRemote: remote } : {}), defaultBase: (await defaultBase(r, remote)).label,
  };
}

/** Query the live remote heads without changing any local refs or checkout. */
export async function liveBranches(source: string, signal?: AbortSignal): Promise<LiveBranches> {
  const r = repo(source, signal);
  const results = await Promise.all((await r.remotes()).map(async remote => {
    const raw = await r.attempt(["ls-remote", "--heads", "--", remote]);
    if (raw === null) return { branches: [], errors: [`Couldn’t reach \`${remote}\`; showing last fetched branches.`] };
    return { branches: raw.split("\n").flatMap(line => {
      const ref = line.split("\t")[1];
      return ref?.startsWith(HEADS) ? [{ remote, branch: ref.slice(HEADS.length) }] : [];
    }), errors: [] as string[] };
  }));
  return { branches: results.flatMap(r => r.branches), errors: results.flatMap(r => r.errors) };
}
