/** 标准业务角色集合：每种角色一个模块，角色 ID 只在插件内声明。 */
import type { AgentRoleImplementation } from "@woohaa3/contracts";
import { cameraComposerRole } from "./camera-composer.js";
import { canvasBuilderRole } from "./canvas-builder.js";
import { modelAuthorRole } from "./model-author.js";
import { sceneDirectorRole } from "./scene-director.js";
import { textAuthorRole } from "./text-author.js";

export {
  cameraComposerRole,
  canvasBuilderRole,
  modelAuthorRole,
  sceneDirectorRole,
  textAuthorRole
};

export const STANDARD_AGENT_ROLES: readonly AgentRoleImplementation[] = [
  modelAuthorRole,
  sceneDirectorRole,
  cameraComposerRole,
  canvasBuilderRole,
  textAuthorRole,
];
