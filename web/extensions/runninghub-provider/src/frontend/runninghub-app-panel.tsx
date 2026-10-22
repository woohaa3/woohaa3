/**
 * RunningHub App Interaction Panel
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.2 / design D7；
 *   change: 2026-10-10-extract-optional-feature-extensions，任务 3.1：由宿主
 *   `cordis/plugins/task-execution/runninghub-app-*` 迁入 runninghub-provider 包，前台只消费
 *   公开 `ExecutionPanel` 与公共投影 `projectModelConfig`，不 import Provider/Task internal）。
 *
 * RunningHub App 模型使用专用 interaction（`runninghub-app@1`）：复用通用 `ExecutionPanel`
 * 外观与提交路径，额外显式呈现工作流模板字段（来自 catalog `inputSchema.properties`）。
 * Panel 只通过受限 props 与宿主交互。
 */
import { useCallback, useMemo, useState } from "react";
import {
  ExecutionPanel,
  projectModelConfig,
  type ExecutionPanelData,
  type ExecutionPanelModelConfig,
  type ExecutionPanelRunSnapshot,
  type ModelPanelProps
} from "@woohaa3/frontend/extension-api";

/** 专用 interaction identity（稳定；保留 `runninghub-app@1`）。 */
export const RUNNINGHUB_APP_INTERACTION_ID = "runninghub-app";
export const RUNNINGHUB_APP_INTERACTION_VERSION = 1;

export function RunningHubAppPanel(props: ModelPanelProps) {
  const { model, catalogModels, presentation, status, errorMessage, draft, blockingReasons, readOnly } = props;
  const [submitError, setSubmitError] = useState<string | null>(null);

  const modelConfig = useMemo<ExecutionPanelModelConfig>(
    () => projectModelConfig(catalogModels, model.modelKey, props.defaultModelKey),
    [catalogModels, model.modelKey, props.defaultModelKey]
  );

  // App 工作流模板字段（只读展示）：字段名来自 catalog 的 inputSchema.properties。
  const workflowFields = useMemo(() => {
    const properties = (model.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    return Object.keys(properties);
  }, [model.inputSchema]);

  const panelData = useMemo<ExecutionPanelData>(
    () => ({
      panelPrompt: draft.prompt,
      taskStatus: status,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      parameters: { ...draft.parameters, model: model.modelKey }
    }),
    [draft, status, errorMessage, model.modelKey]
  );

  const handleChange = useCallback(
    (patch: Partial<ExecutionPanelData>) => {
      props.patchDraft({
        ...(patch.panelPrompt !== undefined ? { prompt: patch.panelPrompt } : {}),
        ...(patch.parameters !== undefined ? { parameters: patch.parameters as Record<string, unknown> } : {})
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
    <div className="model-panel" data-testid="runninghub-app-panel" data-model-key={model.modelKey}>
      {workflowFields.length > 0 ? (
        <p className="execution-panel__template-summary" aria-label="工作流字段">
          工作流字段：{workflowFields.join("、")}
        </p>
      ) : null}
      <ExecutionPanel
        taskKind={model.modelType === "video" ? "video-generation" : "image-generation"}
        modelConfig={modelConfig}
        data={panelData}
        surface="dock"
        presentation={presentation}
        blockingReasons={blockingReasons}
        readOnly={readOnly}
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
