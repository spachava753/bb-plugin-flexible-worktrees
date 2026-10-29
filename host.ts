import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";
import { choices, create, liveBranches, plan, pulls } from "./worktrees";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    choices: ({ source }, ctx) => choices(source, ctx.signal),
    liveBranches: ({ source }, ctx) => liveBranches(source, ctx.signal),
    pulls: ({ source }, ctx) => pulls(source, ctx.signal),
    plan: (args, ctx) => plan({ ...args, dataDir: ctx.experimental_paths.dataDir }, ctx.signal),
    create: (args, ctx) => create(args, ctx.experimental_paths.dataDir, ctx.signal),
  },
});
