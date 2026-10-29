import { useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc, type PluginEnvironmentProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { defaultInputs, inputsSchema, type Inputs } from "./inputs";
import { useChoices, usePreview, useRemoteData } from "./picker/data";
import { TemplateReference } from "./TemplateReference";
import { WorktreePicker } from "./WorktreePicker";
import type { rpcContract } from "./server";

function InputsForm(props: PluginEnvironmentProviderInputsProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [form, setForm] = useState<Inputs>(() => inputsSchema.safeParse(props.value ?? defaultInputs).data ?? defaultInputs);
  const [refresh, setRefresh] = useState(0);
  const hostId = props.target.kind === "existing-host" ? props.target.hostId : null;
  const target = props.projectId && hostId ? { projectId: props.projectId, hostId } : null;
  const { choices, choicesError } = useChoices(rpc, target, refresh);
  const remote = useRemoteData(rpc, target);
  const { preview, checking } = usePreview(rpc, target, form, refresh);

  // Tell BB whether the composer may submit: schema errors and preflight refusals block.
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  useEffect(() => {
    const parsed = inputsSchema.safeParse(form);
    if (!parsed.success) onChange.current({ status: "blocked", reason: parsed.error.issues[0]!.message });
    else if (preview && !preview.ok && !checking) onChange.current({ status: "blocked", reason: preview.error });
    else onChange.current({ status: "ready", value: parsed.data });
  }, [form, preview, checking]);

  // Inputs travel as JSON: drop keys the picker cleared to undefined.
  return <WorktreePicker form={form} onChange={next => setForm(JSON.parse(JSON.stringify(next)))}
    choices={choices} choicesError={choicesError} live={remote.live} pulls={remote.pulls} remoteLoading={remote.remoteLoading}
    preview={preview} checking={checking}
    onOpen={remote.loadOnce} onRefresh={() => { setRefresh(n => n + 1); remote.load(); }} />;
}
export default definePluginApp(app => {
  app.slots.settingsSection({ id: "template-reference", title: "Template reference", component: TemplateReference });
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: "flexible-worktrees",
    component: props => <InputsForm key={`${props.projectId}:${props.target.kind === "existing-host" ? props.target.hostId : "new"}`} {...props} />,
  });
});
