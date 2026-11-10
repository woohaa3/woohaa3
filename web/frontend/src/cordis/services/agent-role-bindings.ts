/**
 * 业务入口的显式 Agent 角色绑定（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 这是**绑定配置**，不是角色实现：前端按用途明确选择完整角色 id，后端核心与执行通道不识别
 * 这些字符串、不按 mode 猜角色。替换默认业务角色应修改这里（本期不提供管理界面）。
 */
import type { AgentTargetMode, AssistantWorldScopeSelection } from "@woohaa3/contracts";

export const AGENT_ROLE_BINDINGS = {
  modelAuthor: "standard-agent-roles/model-author",
  sceneDirector: "standard-agent-roles/scene-director",
  cameraComposer: "standard-agent-roles/camera-composer",
  canvasBuilder: "standard-agent-roles/canvas-builder",
  textAuthor: "standard-agent-roles/text-author",
} as const;

export function roleIdForTarget(input: {
  mode?: AgentTargetMode;
  worldScope?: AssistantWorldScopeSelection;
}): string {
  if (input.mode === "world") {
    return input.worldScope?.kind === "world-camera"
      ? AGENT_ROLE_BINDINGS.cameraComposer
      : AGENT_ROLE_BINDINGS.sceneDirector;
  }
  if (input.mode === "canvas-group") return AGENT_ROLE_BINDINGS.canvasBuilder;
  if (input.mode === "text") return AGENT_ROLE_BINDINGS.textAuthor;
  return AGENT_ROLE_BINDINGS.modelAuthor;
}
