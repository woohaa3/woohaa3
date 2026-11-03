import { useOptionalService } from "../../react.js";
import type { ServiceConnectionView } from "@woohaa3/contracts";
/**
 * Generic Model Interaction Panel
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.4 / design D9）。
 *
 * 把既有 `ExecutionPanel` 的 catalog schema 投影、prompt、references、status 与提交行为
 * 包装成 Model Interaction Panel：它是**一个普通 Plugin Panel**，通过受限 props 消费 Host
 * 提供的 draft/submit/renderers，自身不 import Provider、Task internal API 或 raw store。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExecutionPanel,
  type ExecutionPanelData,
  type ExecutionPanelModelConfig,
  type ExecutionPanelRunSnapshot
} from "../../ui/index.js";
import type { ModelPanelProps } from "../../contract/model-interaction.js";
import { projectModelConfig } from "./generic-panel-projection.js";
import { SkillStepStatus } from "./skill-step-status.js";

export function GenericModelPanel(props: ModelPanelProps) {
  const { model, catalogModels, presentation, status, errorMessage, draft, blockingReasons, readOnly } = props;
  const service = useOptionalService("agentConversationService");
  const [sources, setSources] = useState<ServiceConnectionView[]>([]);
  useEffect(() => {
    let active = true;
    void service?.listServiceConnections?.().then(result => { if (active && result.ok) setSources(result.value); }).catch(() => {});
    return () => { active = false; };
  }, [service, model.modelKey]);
  const compatibleSources = sources.filter(source => source.scope === "personal" && source.enabled && source.bindings.some(binding => binding.consumer === "provider" && binding.modelKeys.includes(model.modelKey)));
  const selectedSource = typeof draft.parameters.serviceConnectionId === "string" ? draft.parameters.serviceConnectionId : "";
  const [submitError, setSubmitError] = useState<string | null>(null);

  const modelConfig = useMemo<ExecutionPanelModelConfig>(
    () => projectModelConfig(catalogModels, model.modelKey, props.defaultModelKey),
    [catalogModels, model.modelKey, props.defaultModelKey]
  );

  const panelData = useMemo<ExecutionPanelData>(
    () => ({
      panelPrompt: draft.prompt,
      taskStatus: status,
      ...(props.progress !== undefined ? { progress: props.progress } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      parameters: { ...draft.parameters, model: model.modelKey }
    }),
    [draft, status, errorMessage, model.modelKey, props.progress]
  );

  const handleChange = useCallback(
    (patch: Partial<ExecutionPanelData>) => {
      props.patchDraft({
        ...(patch.panelPrompt !== undefined ? { prompt: patch.panelPrompt } : {}),
        ...(patch.parameters !== undefined ? { parameters: patch.parameters } : {})
      });
    },
    [props]
  );

  const handleRun = useCallback(
    (snapshot: ExecutionPanelRunSnapshot) => {
      setSubmitError(null);
      void props.submit({ prompt: snapshot.prompt, parameters: snapshot.parameters }).then((outcome) => {
        if (!outcome.ok) setSubmitError(outcome.error);
      });
    },
    [props]
  );

  const referencesSlot = props.renderers?.references?.();
  const typeSwitchSlot = props.renderers?.typeSwitch?.();

  return (
    <div className="model-panel">
      {compatibleSources.length || selectedSource ? <label className="settings-page__hint">服务连接 <select value={selectedSource} disabled={readOnly} onChange={event => {
        const parameters = { ...draft.parameters };
        if (event.target.value) parameters.serviceConnectionId = event.target.value;
        else delete parameters.serviceConnectionId;
        props.patchDraft({ parameters });
      }}><option value="">站点默认来源</option>{compatibleSources.map(source => <option key={source.serviceConnectionId} value={source.serviceConnectionId}>{source.name}</option>)}{selectedSource && !compatibleSources.some(source => source.serviceConnectionId === selectedSource) ? <option value={selectedSource}>原来源已失效，请重新选择</option> : null}</select></label> : null}
      <ExecutionPanel
        taskKind={modelTypeToTaskKind(model.modelType)}
        modelConfig={modelConfig}
        data={panelData}
        surface="dock"
        presentation={presentation}
        blockingReasons={blockingReasons}
        readOnly={readOnly}
        allowEmptySubmit={model.promptRequirement === "optional" || model.promptRequirement === "none"}
        {...(props.actions?.viewTask ? { onViewTask: () => props.actions?.viewTask?.() } : {})}
        {...(referencesSlot !== undefined ? { referencesSlot } : {})}
        {...(typeSwitchSlot !== undefined ? { typeSwitchSlot } : {})}
        {...(props.renderers?.promptEditor ? { promptEditorSlot: props.renderers.promptEditor } : {})}
        {...(props.renderers?.promptLibrary ? { promptLibrarySlot: props.renderers.promptLibrary } : {})}
        {...(props.renderers?.promptSkill ? { onPromptSkill: props.renderers.promptSkill } : {})}
        onChange={handleChange}
        onRun={handleRun}
        onExpand={() => props.requestPresentation({ kind: "expand" })}
        onCollapse={() => props.requestPresentation({ kind: "collapse" })}
        onClose={() => props.requestPresentation({ kind: "close" })}
      />
      {model.modelType === "image" || model.modelType === "video" ? (
        <SkillStepStatus
          nodeId={props.nodeId}
          modelKey={model.modelKey}
          draft={draft}
          writable={props.writable}
          readOnly={readOnly}
        />
      ) : null}
      {submitError ? (
        <p className="node-execution-dock__error" role="alert">
          {submitError}
        </p>
      ) : null}
    </div>
  );
}

function modelTypeToTaskKind(
  modelType: string
): "text-generation" | "image-generation" | "video-generation" | "audio-generation" {
  if (modelType === "language") return "text-generation";
  if (modelType === "image") return "image-generation";
  if (modelType === "audio") return "audio-generation";
  return "video-generation";
}
