import { shortPath, type Choices, type Inputs, type Plan, type Preview, type Pull } from "../inputs";
import type { IconKind } from "./parts";

/** One plain sentence describing what launching will do. */
export function describePlan(p: Plan) {
  const where = `\`${shortPath(p.path)}\``;
  const fetched = p.fetch ? " (fetched at launch)" : "";
  const notes = (p.mergeBaseBranch ? ` Diff compares against \`${p.mergeBaseBranch}\`.` : "") + (p.path.includes("<automatic") ? " Automatic names are assigned at launch." : "");
  switch (p.action) {
    case "attach": return `Attaches existing checkout ${where}. No Git changes; shares files with anything else using it.`;
    case "new-branch": return `Creates ${where} on new branch ${p.branch ? `\`${p.branch}\`` : "(automatic name)"} from \`${p.startLabel}\`${fetched}.${notes}`;
    case "local-branch": return `Creates ${where} on local branch \`${p.branch}\`${p.fastForward ? `, fast-forwarded to \`${p.startLabel}\` if possible` : ""}.${notes}`;
    case "track-remote": return `Fetches \`${p.startLabel}\` and creates ${where} on local branch \`${p.branch}\` tracking it.${notes}`;
    case "detached": return `Fetches ${p.startLabel} and creates a detached worktree at ${where}.${notes}`;
  }
}

export const targetIcon = (form: Inputs): IconKind => ({ new: "new", branch: "branch", pr: "pr", path: "folder" } as const)[form.target];

/** The composer trigger's label for the current target. */
export function summarize(form: Inputs, choices: Choices | null, preview: Preview | null, pull: Pull | undefined) {
  switch (form.target) {
    case "new": return `${form.branch || "New branch"} from ${form.base || choices?.defaultBase || "default"}`;
    case "branch": return `${form.branch}${preview?.ok && preview.plan.action === "attach" ? " · attached" : ""}`;
    case "pr": return `#${form.number}${pull ? ` ${pull.title}` : ""}`;
    case "path": return (choices?.worktrees.find(w => w.path === form.path)?.branch.replace("(detached)", "") || shortPath(form.path).split("/").filter(Boolean).pop() || "Choose checkout") + " · attached";
  }
}
