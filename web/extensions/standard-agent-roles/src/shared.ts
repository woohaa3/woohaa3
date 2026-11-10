/**
 * 公开角色 ID（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 业务入口用它做显式绑定；宿主核心与执行通道不得 import 这些常量，也不得按它们分支。
 */
export const STANDARD_AGENT_ROLE_IDS = {
  modelAuthor: "standard-agent-roles/model-author",
  sceneDirector: "standard-agent-roles/scene-director",
  cameraComposer: "standard-agent-roles/camera-composer",
  canvasBuilder: "standard-agent-roles/canvas-builder",
  textAuthor: "standard-agent-roles/text-author"
} as const;

export type StandardAgentRoleId = (typeof STANDARD_AGENT_ROLE_IDS)[keyof typeof STANDARD_AGENT_ROLE_IDS];
