import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Absolute path from an absolute or `~/` path. No other shell expansion. */
export function expand(path: string) {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new Error("Use an absolute path or ~/path");
  return resolve(expanded);
}
/** realpath() that also canonicalizes paths that don't exist yet, through their nearest existing parent. */
export async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if (!missing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}
/** Whether anything, including a dangling symlink, occupies the path. */
export async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
export async function realpathOf(path: string) {
  try { return await realpath(expand(path)); } catch (error) {
    if (missing(error)) throw new Error(`\`${path}\` doesn't exist`);
    throw error;
  }
}
export const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
