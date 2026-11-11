import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { choicesSchema, inputsSchema, liveBranchesSchema, planResultSchema, planSchema, previewSchema, pullsSchema, templateSchema } from "./inputs";
export { inputsSchema, planSchema, type Inputs, type Plan } from "./inputs";

const source = z.object({ source: z.string() });
export const hostContract = defineRpcContract({
  choices: { input: source, output: choicesSchema.omit({ pathTemplate: true }) },
  liveBranches: { input: source, output: liveBranchesSchema },
  pulls: { input: source, output: pullsSchema },
  plan: {
    input: z.object({ source: z.string(), inputs: inputsSchema, pathTemplate: templateSchema, pathKey: z.string().optional(), suggestedBranch: z.string().optional() }),
    output: planResultSchema,
  },
  create: {
    // `restoreFrom` is a destroyed environment's pathKey: reattach the worktree it left behind, never create one.
    input: z.object({ plan: planSchema, inputs: inputsSchema, pathKey: z.string(), initSubmodules: z.boolean(), restoreFrom: z.string().optional() }),
    output: z.object({ path: z.string(), log: z.array(z.string()) }),
  },
});
const target = z.object({ projectId: z.string(), hostId: z.string() }).strict();
export const rpcContract = defineRpcContract({
  choices: { input: target, output: choicesSchema },
  liveBranches: { input: target, output: liveBranchesSchema },
  pulls: { input: target, output: pullsSchema },
  preview: { input: target.extend({ inputs: inputsSchema }), output: previewSchema },
});
