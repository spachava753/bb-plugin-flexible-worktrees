import type { Fetch, Repo } from "./git";

/** A branch on a configured remote. */
export type RemoteBranch = { remote: string; branch: string };
export const HEADS = "refs/heads/";
export const heads = (branch: string) => HEADS + branch;
export const trackingRef = ({ remote, branch }: RemoteBranch) => `refs/remotes/${remote}/${branch}`;
/** Display and diff-base form: origin/main. */
export const branchLabel = ({ remote, branch }: RemoteBranch) => `${remote}/${branch}`;
export const remoteLabel = (ref: string) => ref.replace(/^refs\/remotes\//, "");
export const fetchOf = (rb: RemoteBranch): Fetch => ({ remote: rb.remote, from: heads(rb.branch), into: trackingRef(rb), force: false });

/** Split `[refs/remotes/]<remote>/<branch>`, allowing remote names that contain slashes. */
export function splitRemoteRef(ref: string, remotes: string[]): RemoteBranch | null {
  const rest = remoteLabel(ref);
  const remote = [...remotes].sort((a, b) => b.length - a.length).find(r => rest.startsWith(`${r}/`));
  return remote ? { remote, branch: rest.slice(remote.length + 1) } : null;
}

export function parseTrack(value: string) {
  return { ahead: Number(/ahead (\d+)/.exec(value)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(value)?.[1] ?? 0), gone: value.includes("gone") };
}

export type LocalBranch = { worktree: string; upstream: string; upstreamRemote: string; upstreamRef: string; ahead: number; behind: number; gone: boolean };
export async function localBranch(r: Repo, branch: string): Promise<LocalBranch | null> {
  const rows = await r.refs({ ref: "refname", worktree: "worktreepath", upstream: "upstream", upstreamRemote: "upstream:remotename", upstreamRef: "upstream:remoteref", track: "upstream:track" }, [heads(branch)]);
  // for-each-ref patterns also match descendants (feature matches feature/x), so require the exact ref.
  const row = rows.find(row => row.ref === heads(branch));
  if (!row) return null;
  const { ref: _, track, ...rest } = row;
  return { ...rest, ...parseTrack(track) };
}
/** The upstream to fast-forward from, when it's a live remote-tracking branch. */
export const trackedUpstream = (b: LocalBranch) =>
  b.upstream.startsWith("refs/remotes/") && b.upstreamRemote && b.upstreamRef.startsWith("refs/heads/") && !b.gone ? b.upstream : undefined;
