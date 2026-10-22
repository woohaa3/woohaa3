/**
 * Extension SDK `model` 能力分组（宿主 adapter）
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 2.2 / design D2）。
 *
 * 模型交互面板运行时导出：通用 `ExecutionPanel`、catalog→面板纯投影、受控 Lexical
 * `MentionEditor`、上传规划纯函数与配置投影。全部为宿主实际实现引用；不内联 React/SDK。
 */
import { ExecutionPanel, ExecutionPanelShell } from "../plugins/task-execution/execution-panel/ExecutionPanel.js";
import { AssistantConnectionPicker } from "../plugins/task-execution/assistant-connection-picker.js";
import { AuthoringGenerateSurface } from "../plugins/task-execution/authoring-generate-layout.js";
import { resolveAgentDetailAction } from "../plugins/task-execution/execution-panel/agent-detail-action.js";
import { projectModelConfig } from "../plugins/task-execution/generic-panel-projection.js";
import { LazyMentionEditor as MentionEditor } from "../plugins/task-execution/mention/lazy-mention-editor.js";
import {
  UPLOAD_ACCEPT,
  uploadedNodeType,
  buildUploadedAsset,
  buildUploadedTextAsset,
  planUploadedNode,
  planReplaceImage
} from "../../extension-api/upload-asset.js";
import type { ExtensionSdkGroupModule } from "./sdk-groups.js";

export const group = "model" as const;

export const namedExports = {
  ExecutionPanel,
  ExecutionPanelShell,
  AssistantConnectionPicker,
  AuthoringGenerateSurface,
  /** 生成面板状态区具名详情动作的纯派生（change: 2026-10-12-add-agent-conversation-panel）。 */
  resolveAgentDetailAction,
  projectModelConfig,
  MentionEditor,
  UPLOAD_ACCEPT,
  uploadedNodeType,
  buildUploadedAsset,
  buildUploadedTextAsset,
  planUploadedNode,
  planReplaceImage
} satisfies Record<string, unknown>;

const module: ExtensionSdkGroupModule = { group, namedExports };
export default module;
