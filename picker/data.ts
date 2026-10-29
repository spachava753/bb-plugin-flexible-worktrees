import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginRpcClient } from "@get-bb/plugin-sdk/app";
import { inputsSchema, type Choices, type Inputs, type LiveBranches, type Preview, type Pulls } from "../inputs";
import type { rpcContract } from "../server";

type Rpc = PluginRpcClient<typeof rpcContract>;
export type Target = { projectId: string; hostId: string } | null;
const failed = (e: unknown) => String(e instanceof Error ? e.message : e);

/** Local branches and worktrees: instant, reloaded on refresh. */
export function useChoices(rpc: Rpc, target: Target, refresh: number) {
  const [choices, setChoices] = useState<Choices | null>(null);
  const [choicesError, setChoicesError] = useState("");
  useEffect(() => {
    if (!target) return;
    let active = true;
    setChoicesError("");
    rpc.call("choices", target).then(result => { if (active) setChoices(result); })
      .catch(e => { if (active) setChoicesError(failed(e)); });
    return () => { active = false; };
  }, [target?.projectId, target?.hostId, refresh]);
  return { choices, choicesError };
}

/** Live remote heads and pull requests. Network lookups wait until first asked for; local branches render first. */
export function useRemoteData(rpc: Rpc, target: Target) {
  const [live, setLive] = useState<LiveBranches | null>(null);
  const [pulls, setPulls] = useState<Pulls | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const loaded = useRef(false);
  const load = useCallback(() => {
    if (!target) return;
    loaded.current = true;
    setRemoteLoading(true);
    Promise.allSettled([
      rpc.call("liveBranches", target).then(setLive),
      rpc.call("pulls", target).then(setPulls),
    ]).then(results => {
      if (results[0].status === "rejected") setLive({ branches: [], errors: ["Couldn’t reach remotes; showing last fetched branches."] });
      if (results[1].status === "rejected") setPulls({ available: false, pulls: [] });
      setRemoteLoading(false);
    });
  }, [target?.projectId, target?.hostId]);
  return { live, pulls, remoteLoading, load, loadOnce: () => { if (!loaded.current) load(); } };
}

/** Debounced host preflight of the current inputs. `checking` is true while a valid request is pending. */
export function usePreview(rpc: Rpc, target: Target, form: Inputs, refresh: number) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const parsed = inputsSchema.safeParse(form);
    if (!target || !parsed.success) { setPreview(null); setChecking(false); return; }
    let active = true;
    setChecking(true);
    const timer = setTimeout(() => {
      rpc.call("preview", { ...target, inputs: parsed.data }).then(result => { if (active) setPreview(result); })
        // Transport failures don't block: the server re-validates at launch.
        .catch(() => { if (active) setPreview(null); })
        .finally(() => { if (active) setChecking(false); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [form, target?.projectId, target?.hostId, refresh]);
  return { preview, checking };
}
