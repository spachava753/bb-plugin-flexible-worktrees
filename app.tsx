import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc, type PluginEnvironmentProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { defaultInputs, inputsSchema, type Choices, type Inputs, type LiveBranches, type Preview, type Pulls } from "./inputs";
import { WorktreePicker } from "./WorktreePicker";
import type { rpcContract } from "./server";

const failed = (e: unknown) => String(e instanceof Error ? e.message : e);

function InputsForm(props: PluginEnvironmentProviderInputsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [form, setForm] = useState<Inputs>(() => inputsSchema.safeParse(props.value ?? defaultInputs).data ?? defaultInputs);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [choicesError, setChoicesError] = useState("");
  const [live, setLive] = useState<LiveBranches | null>(null);
  const [pulls, setPulls] = useState<Pulls | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const remoteLoaded = useRef(false);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  const hostId = props.target.kind === "existing-host" ? props.target.hostId : null;
  const target = props.projectId && hostId ? { projectId: props.projectId, hostId } : null;

  useEffect(() => {
    const parsed = inputsSchema.safeParse(form);
    if (!parsed.success) onChange.current({ status: "blocked", reason: parsed.error.issues[0]!.message });
    else if (preview && !preview.ok && !checking) onChange.current({ status: "blocked", reason: preview.error });
    else onChange.current({ status: "ready", value: parsed.data });
  }, [form, preview, checking]);

  useEffect(() => {
    if (!target) return;
    let active = true;
    setChoicesError("");
    rpc.call("choices", target).then(result => { if (active) setChoices(result); })
      .catch(e => { if (active) setChoicesError(failed(e)); });
    return () => { active = false; };
  }, [props.projectId, hostId, refresh]);

  // Network lookups wait until the popover opens; local branches render first.
  const loadRemote = useCallback(() => {
    if (!target) return;
    remoteLoaded.current = true;
    setRemoteLoading(true);
    Promise.allSettled([
      rpc.call("liveBranches", target).then(setLive),
      rpc.call("pulls", target).then(setPulls),
    ]).then(results => {
      if (results[0].status === "rejected") setLive({ branches: [], errors: ["Couldn’t reach remotes; showing last fetched branches."] });
      if (results[1].status === "rejected") setPulls({ available: false, pulls: [] });
      setRemoteLoading(false);
    });
  }, [props.projectId, hostId]);

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
  }, [form, props.projectId, hostId, refresh]);

  // Inputs travel as JSON: drop keys the picker cleared to undefined.
  return <WorktreePicker form={form} onChange={next => setForm(JSON.parse(JSON.stringify(next)))} choices={choices} choicesError={choicesError}
    live={live} pulls={pulls} remoteLoading={remoteLoading} preview={preview} checking={checking}
    onOpen={() => { if (!remoteLoaded.current) loadRemote(); }}
    onRefresh={() => { setRefresh(n => n + 1); loadRemote(); }} />;
}
export default definePluginApp(app => {
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: "flexible-worktrees",
    component: props => <InputsForm key={`${props.projectId}:${props.target.kind === "existing-host" ? props.target.hostId : "new"}`} {...props} />,
  });
});
