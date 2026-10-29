import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";
import { choices, liveBranches } from "./worktree/choices";
import { create } from "./worktree/create";
import { repo } from "./worktree/git";
import { pulls } from "./worktree/github";
import { plan } from "./worktree/plan";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    choices: ({ source }, ctx) => choices(source, ctx.signal),
    liveBranches: ({ source }, ctx) => liveBranches(source, ctx.signal),
    pulls: ({ source }, ctx) => pulls(repo(source, ctx.signal)),
    plan: (args, ctx) => plan({ ...args, dataDir: ctx.experimental_paths.dataDir }, ctx.signal),
    create: (args, ctx) => create(args, ctx.experimental_paths.dataDir, ctx.signal),
  },
});
