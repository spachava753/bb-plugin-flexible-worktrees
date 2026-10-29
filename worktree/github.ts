import type { Pull, Pulls } from "../inputs";
import { exec, stderr, type Repo } from "./git";

type GhPull = { number: number; title: string; author?: { login?: string }; headRefName: string; baseRefName: string; isCrossRepository: boolean; isDraft: boolean; updatedAt: string; url?: string };
const fields = "number,title,author,headRefName,baseRefName,isCrossRepository,isDraft,updatedAt";

/** Run the GitHub CLI (if installed) for JSON output. Never prompts. */
async function gh<T>(r: Repo, args: string[]): Promise<T> {
  const { stdout } = await exec("gh", args, {
    cwd: r.dir, signal: r.signal, timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return JSON.parse(stdout) as T;
}
const toPull = (p: GhPull): Pull => ({
  number: p.number, title: p.title, author: p.author?.login ?? "", head: p.headRefName, base: p.baseRefName,
  fork: p.isCrossRepository, draft: p.isDraft, updated: Date.parse(p.updatedAt) || 0,
});

/** HOST/OWNER/REPO for gh --repo, from a remote URL (scp-like, ssh://, or https://). */
export function repoOf(url: string) {
  const scp = /^[^@/\s]+@([^:/\s]+):([^\s]+?)(?:\.git)?\/?$/.exec(url);
  let host: string, path: string;
  if (scp) [host, path] = [scp[1]!, scp[2]!];
  else {
    try { const u = new URL(url); [host, path] = [u.hostname, u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")]; } catch { return undefined; }
  }
  return host && /^[^/]+\/[^/]+$/.test(path) ? `${host}/${path}` : undefined;
}
export const remoteRepo = async (r: Repo, remote: string) => repoOf(await r.remoteUrl(remote));

export async function pulls(r: Repo): Promise<Pulls> {
  try {
    return { available: true, pulls: (await gh<GhPull[]>(r, ["pr", "list", "--state", "open", "--limit", "50", "--json", fields])).map(toPull) };
  } catch (error) {
    r.signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { available: false, pulls: [] };
    const reason = stderr(error);
    if (/auth login|not logged in|authentication/i.test(reason)) return { available: false, message: "Run `gh auth login` on this machine to list PRs.", pulls: [] };
    if (/no git remotes|known GitHub host|not a git repository/i.test(reason)) return { available: false, pulls: [] };
    return { available: true, message: `Couldn’t load PRs: ${reason || "unknown error"}`, pulls: [] };
  }
}

export type PullDetails = { status: "found"; pull: Pull; repo?: string } | { status: "missing" } | { status: "unavailable" };
/** One PR, from `repo` (HOST/OWNER/REPO) or gh's default repository. */
export async function pullDetails(r: Repo, number: number, repo?: string): Promise<PullDetails> {
  try {
    const row = await gh<GhPull>(r, ["pr", "view", String(number), "--json", `${fields},url`, ...(repo ? ["--repo", repo] : [])]);
    return { status: "found", pull: toPull(row), repo: /^https?:\/\/([^/]+\/[^/]+\/[^/]+)\/pull\//.exec(row.url ?? "")?.[1] };
  } catch (error) {
    r.signal?.throwIfAborted();
    return /could not resolve|not found|no pull requests? found/i.test(stderr(error)) ? { status: "missing" } : { status: "unavailable" };
  }
}
/** Target branch of an open PR on `remote` whose head is this branch, when gh can tell. */
export async function pullBase(r: Repo, branch: string, remote: string) {
  const repo = await remoteRepo(r, remote);
  if (!repo) return undefined;
  try {
    return (await gh<{ baseRefName: string }[]>(r, ["pr", "list", "--repo", repo, "--state", "open", "--head", branch, "--limit", "1", "--json", "baseRefName"]))[0]?.baseRefName;
  } catch { r.signal?.throwIfAborted(); return undefined; }
}
