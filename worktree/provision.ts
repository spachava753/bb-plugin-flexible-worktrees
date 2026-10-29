import { constants, copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonical, exists, within } from "./fs";
import { repo, stderr } from "./git";

/** Prepare a freshly created worktree. Problems are reported as log lines, never thrown (except cancellation). */
export async function provision(source: string, path: string, opts: { initSubmodules: boolean }, signal?: AbortSignal) {
  const log: string[] = [];
  if (opts.initSubmodules && await exists(join(path, ".gitmodules"))) {
    try {
      await repo(path, signal).run(["submodule", "update", "--init", "--recursive"], 1_200_000);
      log.push("Initialized submodules.");
    } catch (error) {
      signal?.throwIfAborted();
      log.push(`Submodules not initialized: ${stderr(error) || "unknown error"}. Run \`git submodule update --init --recursive\` in the worktree.`);
    }
  }
  log.push(...await copyIncludes(source, path, signal));
  return log;
}

/** Copy untracked source files matching the worktree's tracked .worktreeinclude. Never replaces or follows symlinks. */
export async function copyIncludes(source: string, path: string, signal?: AbortSignal) {
  const patterns = join(path, ".worktreeinclude");
  try { if (!(await lstat(patterns)).isFile()) return []; } catch { return []; }
  const files = await repo(source, signal).attempt(["ls-files", "-z", "--others", "--ignored", `--exclude-from=${patterns}`]);
  if (files === null) return ["Couldn’t read .worktreeinclude patterns; no files copied."];
  const root = await realpath(path);
  let copied = 0;
  const skipped: string[] = [];
  for (const rel of files.split("\0").filter(Boolean)) {
    signal?.throwIfAborted();
    const from = join(source, rel), to = join(path, rel);
    try {
      if (!(await lstat(from)).isFile() || await exists(to)) { skipped.push(rel); continue; }
      // A tracked symlinked directory must not redirect the copy outside the worktree.
      const parent = await canonical(dirname(to));
      if (!within(root, parent)) { skipped.push(rel); continue; }
      await mkdir(parent, { recursive: true });
      await copyFile(from, join(parent, basename(to)), constants.COPYFILE_EXCL);
      copied++;
    } catch { skipped.push(rel); }
  }
  if (!copied && !skipped.length) return [".worktreeinclude matched no untracked files."];
  return [`Copied ${copied} file${copied === 1 ? "" : "s"} from .worktreeinclude${skipped.length ? `; skipped ${skipped.length} (already present, symlinks, or unreadable): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}` : ""}.`];
}
