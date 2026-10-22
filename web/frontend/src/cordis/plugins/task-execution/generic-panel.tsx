/**
 * Generic Model Interaction Panel
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.4 / design D9）。
 *
 * 把既有 `ExecutionPanel` 的 catalog schema 投影、prompt、references、status 与提交行为
 * 包装成 Model Interaction Panel：它是**一个普通 Plugin Panel**，通过受限 props 消费 Host
 * 提供的 draft/submit/renderers，自身不 import Provider、Task internal API 或 raw store。
 */
import { useCallback, useMemo, useState } from "react";
import {
  ExecutionPanel,
  type ExecutionPanelData,
  type ExecutionPanelModelConfig,
  type ExecutionPanelRunSnapshot
} from "../../ui/index.js";
import type { ModelPanelProps } from "../../contract/model-interaction.js";
import { projectModelConfig } from "./generic-panel-projection.js";

export function GenericModelPanel(props: ModelPanelProps) {
  const { model, catalogModels, presentation, status, errorMessage, draft, blockingReasons, readOnly } = props;
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

  return (
    <div className="model-panel">
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
        {...(props.renderers?.promptEditor ? { promptEditorSlot: props.renderers.promptEditor } : {})}
        {...(props.renderers?.promptSkill ? { onPromptSkill: props.renderers.promptSkill } : {})}
        onChange={handleChange}
        onRun={handleRun}
        onExpand={() => props.requestPresentation({ kind: "expand" })}
        onCollapse={() => props.requestPresentation({ kind: "collapse" })}
        onClose={() => props.requestPresentation({ kind: "close" })}
      />
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
