import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { Plan, Worktree } from "../inputs";
import { realpathOf } from "./fs";

export const exec = promisify(execFile);
export async function git(cwd: string, args: string[], signal?: AbortSignal, timeout = 120_000) {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    signal, timeout, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trimEnd();
}
/** First meaningful line of a failed command's stderr. */
export function stderr(error: unknown) {
  const text = String((error as { stderr?: unknown }).stderr ?? (error as Error).message ?? "");
  return text.split("\n").map(s => s.replace(/^(fatal|error): /, "").trim()).find(Boolean) ?? "";
}

export type Fetch = NonNullable<Plan["fetch"]>;
/** A fetch failure; `summary` is the message without the diagnostic detail and advice. */
export class FetchError extends Error {
  constructor(readonly summary: string, detail: string) {
    super(`${summary} (${detail || "unknown error"}). Check this machine's network and Git credentials, then retry.`);
  }
}

/** One checkout's Git operations, bound to a cancellation signal. Every command uses argv, never a shell. */
export function repo(dir: string, signal?: AbortSignal) {
  const run = (args: string[], timeout?: number) => git(dir, args, signal, timeout);
  /** Like run(), but a failed command yields null. Cancellation still throws. */
  const attempt = async (args: string[], timeout?: number) => {
    try { return await run(args, timeout); } catch {
      signal?.throwIfAborted();
      return null;
    }
  };
  const self = {
    dir, signal, run, attempt,
    oid: (rev: string) => run(["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]),
    refExists: async (ref: string) => await attempt(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]) !== null,
    /** check-ref-format; also rejects patterns such as `*`. */
    validRef: async (ref: string, ...flags: string[]) => await attempt(["check-ref-format", ...flags, ref]) !== null,
    currentBranch: async () => await attempt(["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "",
    remotes: async () => (await run(["remote"])).split("\n").filter(Boolean),
    remoteUrl: async (remote: string) => await attempt(["remote", "get-url", "--", remote]) ?? "",
    /** Canonical shared .git directory; throws when it can't be determined. */
    commonDir: async () => realpath(await run(["rev-parse", "--path-format=absolute", "--git-common-dir"])),
    /** Exact refnames the remote has among `refs`; null when it can't be reached. */
    remoteHas: async (remote: string, refs: string[]) => {
      const raw = await attempt(["ls-remote", "--", remote, ...refs]);
      return raw === null ? null : new Set(raw.split("\n").map(line => line.split("\t")[1]).filter(r => r && refs.includes(r)));
    },
    /** for-each-ref rows with the requested atoms, keyed by the given names. */
    refs: async <K extends string>(fields: Record<K, string>, patterns: string[], sort?: string) => {
      const keys = Object.keys(fields) as K[];
      const raw = await run(["for-each-ref", ...(sort ? [`--sort=${sort}`] : []), `--format=${keys.map(k => `%(${fields[k]})`).join("%00")}`, "--", ...patterns]);
      return raw.split("\n").filter(Boolean).map(line => {
        const values = line.split("\0");
        return Object.fromEntries(keys.map((k, i) => [k, values[i] ?? ""])) as Record<K, string>;
      });
    },
    worktrees: async (): Promise<Worktree[]> => {
      const raw = await run(["worktree", "list", "--porcelain", "-z"]);
      return raw.split("\0\0").filter(Boolean).flatMap(record => {
        const fields = record.split("\0");
        const path = fields.find(f => f.startsWith("worktree "))?.slice(9);
        if (!path || fields.includes("bare")) return [];
        return [{ path, branch: fields.find(f => f.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? "(detached)" }];
      });
    },
    /** Fetch exactly one ref: no tags, pruning, or submodules. Force only for plugin-private PR refs. */
    fetch: async (f: Fetch) => {
      if (f.remote.startsWith("-")) throw new Error("Invalid remote");
      try {
        await run(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--", f.remote, `${f.force ? "+" : ""}${f.from}:${f.into}`], 600_000);
      } catch (error) {
        signal?.throwIfAborted();
        throw new FetchError(`Couldn’t fetch \`${f.from.replace(/^refs\/heads\//, "")}\` from \`${f.remote}\``, stderr(error));
      }
    },
  };
  return self;
}
export type Repo = ReturnType<typeof repo>;

/** Canonical root of a checkout; refuses non-checkouts and subdirectories. */
export async function checkoutRoot(path: string, signal?: AbortSignal) {
  const root = await realpathOf(path);
  const r = repo(root, signal);
  if (await r.attempt(["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("Not a Git checkout");
  if (root !== await realpath(await r.run(["rev-parse", "--show-toplevel"]))) throw new Error("Choose the checkout root, not a subdirectory");
  return root;
}
export const list = (source: string, signal?: AbortSignal) => repo(source, signal).worktrees();
