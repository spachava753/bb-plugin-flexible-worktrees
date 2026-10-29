import { basename, dirname, join } from "node:path";
import { templateSchema, type TemplateToken } from "../inputs";
import { canonical, exists, expand } from "./fs";

export type DestinationOptions = {
  /** The project's path template: a complete path, including the folder. */
  template: string;
  /** Canonical source checkout ({repoPath}) and primary checkout name ({repo}). */
  source: string;
  repo: string;
  /** BB's launch key; absent in previews. */
  pathKey?: string;
  /** Per-thread overrides: a templated parent directory, and a literal folder name. */
  root?: string;
  folder?: string;
};
/** Filesystem-safe {branch}: separators and reserved punctuation become "-"; the Git branch name is unchanged. */
export const branchSegment = (branch: string) => branch.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-");
const placeholders: Partial<Record<TemplateToken, string>> = { branch: "<automatic branch>", pathKey: "<automatic folder>" };

/**
 * Resolve destinations for one launch. `branch` fills {branch}; empty means BB names it at launch.
 * Launch-time names render as placeholders in previews and must be known at launch.
 * Template-derived folders get -2, -3… on collision; an explicit folder that exists is refused.
 */
export function destinations(o: DestinationOptions) {
  const preview = !o.pathKey;
  return async (branch: string) => {
    const values: Record<TemplateToken, string | undefined> = {
      repo: o.repo, repoPath: o.source, checkoutParent: dirname(o.source),
      branch: branch ? branchSegment(branch) : undefined, pathKey: o.pathKey,
    };
    const render = (template: string) => templateSchema.parse(template).replace(/\{([^{}]+)\}/g, (_, token: TemplateToken) => {
      const value = values[token] ?? (preview ? placeholders[token] : undefined);
      if (value === undefined) throw new Error("Destination is unresolved: BB didn't provide a branch name for this launch.");
      return value;
    });
    let root = o.root ? expand(render(o.root)) : undefined;
    // Blank overrides (including whitespace the schema trimmed away) keep the template's parts.
    let folder = o.folder || undefined;
    if (!root || !folder) {
      const rendered = render(o.template);
      if (!basename(rendered) || [".", ".."].includes(basename(rendered))) throw new Error("Path template must end in a folder name");
      const full = expand(rendered, o.source);
      root ??= dirname(full);
      folder ??= basename(full);
    }
    // Checked after expansion: a variable's value can contain characters a folder name can't.
    if (folder === "." || folder === ".." || /[\\/\0\r\n]/.test(folder)) throw new Error("Invalid folder name");
    if (o.folder) {
      const path = await canonical(join(root, folder));
      if (await exists(path)) throw new Error(`\`${path}\` already exists. Choose another folder, or pick it under Worktrees to attach it.`);
      return path;
    }
    for (let n = 1; n < 100; n++) {
      const path = await canonical(join(root, n === 1 ? folder : `${folder}-${n}`));
      if (!await exists(path)) return path;
    }
    throw new Error("Too many folders with this name; choose a folder name");
  };
}
