import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { inputsSchema, planSchema, type Inputs, type Plan } from "../inputs";

/**
 * Durable ownership receipt keyed by BB's pathKey, not a launch/lifecycle registry.
 * Retries reuse its plan; `provisioned` keeps finished launches from re-running setup. No paths are ever deleted.
 */
const receiptSchema = z.object({ inputs: inputsSchema, plan: planSchema, provisioned: z.boolean() }).strict();
export type Receipt = z.infer<typeof receiptSchema>;

export function receipts(dataDir: string, pathKey: string) {
  const dir = join(dataDir, "receipts");
  const file = join(dir, `${createHash("sha256").update(pathKey).digest("hex")}.json`);
  return {
    async read(): Promise<Receipt | undefined> {
      let raw: string;
      try { raw = await readFile(file, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
      const parsed = receiptSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error("This launch has an unrecognized ownership receipt (from an older plugin version). Start a new thread.");
      return parsed.data;
    },
    /** `create` refuses to replace an existing receipt. */
    async write(receipt: Receipt, create: boolean) {
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(receipt), { flag: create ? "wx" : "w", mode: 0o600 });
    },
  };
}

/** A retry must carry the same inputs (and, once planned, the same plan) as the launch that wrote the receipt. */
export function assertSameLaunch(receipt: Receipt, inputs: Inputs, plan?: Plan) {
  if (JSON.stringify(receipt.inputs) !== JSON.stringify(inputs) || (plan && JSON.stringify(receipt.plan) !== JSON.stringify(plan))) {
    throw new Error("This launch already reserved a different worktree. Restore the original settings or start a new thread.");
  }
}
