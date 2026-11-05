/**
 * Extension SDK `authoring` 能力分组（宿主 adapter）
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 2.2 / design D2）。
 *
 * 组合资产注册表（片场/炉体消费）与模型编辑会话类：宿主实际实现引用，保证 class/对象同一实例。
 * 首期只保留扩展真实使用的能力，不做 barrel 展开。
 */
import { agentDirectory, agentModelSelection, agentDirectoryModels, assistantInputController, assistantInputKey } from "../../extension-api/assistant-execution.js";
import { ModelEditorSession } from "../../extension-api/model-workspace-session.js";
import type { ExtensionSdkGroupModule } from "./sdk-groups.js";

export const group = "authoring" as const;

export const namedExports = {
  agentDirectory,
  agentModelSelection,
  agentDirectoryModels,
  assistantInputController,
  assistantInputKey,
  ModelEditorSession
} satisfies Record<string, unknown>;

const module: ExtensionSdkGroupModule = { group, namedExports };
export default module;
