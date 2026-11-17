/**
 * 已下线模型的面板表面。
 *
 * 目录里不再有该节点的 modelKey 时，节点仍要保留模型身份、草稿、参数与结果，只是不可执行。
 * 这类节点过去整块换成一张诊断卡片，提示词、参考素材、模型入口和主操作全都消失——看起来
 * 像换了一个面板，而不是「同一个面板暂时不能生成」。
 *
 * 这里让面板继续按常规外观渲染（提示词、参考区、来源与模型、主操作），只把「模型已不在目录里」
 * 作为普通阻止原因交给面板展示；主操作与回车提交都由该原因真正禁用。已下线的身份没有可用
 * schema，因此参数表为空——不猜测别的模型的参数，也不回落到目录首个模型。
 */
import type { ReactNode } from "react";
import type { CanvasTaskCatalogModel } from "@woohaa3/contracts";
import {
  ExecutionPanel,
  type ExecutionPanelData,
  type ExecutionPanelModelConfig,
  type ExecutionPanelStatus
} from "../../ui/index.js";
import type { ExecutionPanelPresentation } from "../../navigation/contracts.js";
import { modelOptionForCatalog } from "./catalog-projection.js";
import type { NodePanelKind } from "./node-panel-registry.js";
import type { ModelPanelRenderers } from "../../contract/model-interaction.js";

export type OfflineModelPanelProps = {
  /** 面板类型即任务类型，决定主操作文案（生成图片 / 生成视频 …）。 */
  panelKind: NodePanelKind;
  /** 节点保存的、已不在目录里的模型身份；也是本面板的选中值。 */
  modelKey: string;
  /** 当前目录里同类型的可用模型：用户从这里显式换模型才能恢复执行。 */
  catalogModels: readonly CanvasTaskCatalogModel[];
  presentation: ExecutionPanelPresentation;
  status: ExecutionPanelStatus;
  progress?: number;
  errorMessage?: string;
  prompt: string;
  parameters: Record<string, unknown>;
  blockingReasons: readonly string[];
  readOnly: boolean;
  renderers: ModelPanelRenderers;
  references?: ReactNode;
  onDraftChange(patch: { prompt?: string; parameters?: Record<string, unknown> }): void;
  requestPresentation(intent: { kind: "expand" | "collapse" | "close" }): void;
};

export function OfflineModelPanel(props: OfflineModelPanelProps) {
  const modelConfig: ExecutionPanelModelConfig = {
    // 已下线的身份排在最前并作为默认值：面板显示节点保存的模型，不被目录首项替换。
    modelOptions: [
      { value: props.modelKey, label: props.modelKey, modelId: props.modelKey },
      ...props.catalogModels.map(modelOptionForCatalog)
    ],
    defaultModel: props.modelKey,
    parameterSchemaByModel: {},
    defaultsByModel: {}
  };
  const data: ExecutionPanelData = {
    panelPrompt: props.prompt,
    taskStatus: props.status,
    ...(props.progress !== undefined ? { progress: props.progress } : {}),
    ...(props.errorMessage !== undefined ? { errorMessage: props.errorMessage } : {}),
    parameters: { ...props.parameters, model: props.modelKey }
  };
  const { promptEditor, promptSkill } = props.renderers;
  return (
    <ExecutionPanel
      taskKind={props.panelKind}
      modelConfig={modelConfig}
      data={data}
      surface="dock"
      presentation={props.presentation}
      blockingReasons={props.blockingReasons}
      readOnly={props.readOnly}
      modelSelectorSlot={props.renderers.modelSelector?.()}
      {...(props.references !== undefined ? { referencesSlot: props.references } : {})}
      {...(promptEditor ? { promptEditorSlot: promptEditor } : {})}
      {...(promptSkill ? { onPromptSkill: promptSkill } : {})}
      onChange={(patch) => props.onDraftChange({
        ...(patch.panelPrompt !== undefined ? { prompt: patch.panelPrompt } : {}),
        ...(patch.parameters !== undefined ? { parameters: patch.parameters } : {})
      })}
      // 没有可执行身份：主操作已被 blockingReasons 禁用，这里不存在可达的提交路径。
      onRun={() => {}}
      onExpand={() => props.requestPresentation({ kind: "expand" })}
      onCollapse={() => props.requestPresentation({ kind: "collapse" })}
      onClose={() => props.requestPresentation({ kind: "close" })}
    />
  );
}
