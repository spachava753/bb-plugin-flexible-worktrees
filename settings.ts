import { pathTemplateSchema, projectOverridesSchema } from "./inputs";
import { remoteIdentity } from "./remotes";

export { remoteIdentity };
export type PathSettings = { pathTemplate: string; projectOverrides: string };

function matches(pattern: string, identity: string) {
  const regex = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${regex}$`).test(identity);
}

/** The template for a project: its project ID entry, then the most specific remote pattern, then the global template. */
export function projectTemplate(settings: PathSettings, projectId: string, remote: string | null): string {
  const overrides = projectOverridesSchema.parse(JSON.parse(settings.projectOverrides));
  if (Object.hasOwn(overrides, projectId)) return pathTemplateSchema.parse(overrides[projectId]);
  const identity = remoteIdentity(remote);
  const candidates = !identity ? [] : Object.entries(overrides).flatMap(([key, template]) => {
    const pattern = remoteIdentity(key);
    return pattern && matches(pattern, identity) ? [{ key, pattern, template }] : [];
  }).sort((a, b) => Number(b.pattern === identity) - Number(a.pattern === identity)
    || b.pattern.replaceAll("*", "").length - a.pattern.replaceAll("*", "").length
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return pathTemplateSchema.parse(candidates[0]?.template ?? settings.pathTemplate);
}
