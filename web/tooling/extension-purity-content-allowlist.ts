/**
 * 字段级扩展纯粹性的历史债。由声明字面量扫描生成，清债时删除对应条目。
 * 阶段对应 change 2026-10-26-abstract-extension-content-fields 的后续任务组。
 */
import type { ContentFieldDebt } from "./extension-purity-allowlist.js";

export const CONTENT_FIELD_DEBT: readonly ContentFieldDebt[] = [
  {
    file: "web/contracts/src/canvas/command-reducer/edit-command-film-set.ts",
    literals: ["filmSetContent","filmSetNodeId"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/command-reducer/edit-command.ts",
    literals: ["filmSetObjectContainersHidden"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/command-reducer/film-set-clip-commands.ts",
    literals: ["filmSetAnimations"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/command-reducer/film-set-item-commands.ts",
    literals: ["film-set","filmSetAnimations","filmSetContent"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/command-reducer/film-set-object-containers.ts",
    literals: ["film-set","filmSetContent","filmSetNodeId","filmSetObjectContainersHidden"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/command-reducer/film-set-shot-previews.ts",
    literals: ["shotPreview"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/command-reducer/node-commands.ts",
    literals: ["filmSetNodeId"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/command-reducer/node-data-validation.ts",
    literals: ["film-set","filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/command-satisfaction.ts",
    literals: ["filmSetContent"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/edit-command-types.ts",
    literals: ["filmSetNodeId","filmSetObjectContainersHidden"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/edit-command.ts",
    literals: ["filmSetNodeId"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/edit-plan-film-set-clip.ts",
    literals: ["filmSetContent","filmSetNodeId"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/edit-plan-film-set.ts",
    literals: ["filmSetContent"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/edit-plan-node-data.ts",
    literals: ["filmSetObjectContainersHidden"],
    stage: "command",
    reason: "历史债：内核仍含扩展命令或编辑分支。去向：第 3 组改为 extension.command。"
  },
  {
    file: "web/contracts/src/canvas/domain/core/composite-asset-identity.ts",
    literals: ["film-set"],
    stage: "identity",
    reason: "历史债：身份白名单或旧格式 reader 仍在内核。去向：第 7 组清债。"
  },
  {
    file: "web/services/canvas-service/src/animation/legacy-film-set-animations.ts",
    literals: ["filmSetContent"],
    stage: "identity",
    reason: "历史债：身份白名单或旧格式 reader 仍在内核。去向：第 7 组清债。"
  },
  {
    file: "web/services/canvas-service/src/animation/legacy-film-set-content.ts",
    literals: ["film-set","filmSetContent"],
    stage: "identity",
    reason: "历史债：身份白名单或旧格式 reader 仍在内核。去向：第 7 组清债。"
  },
  {
    file: "web/services/canvas-service/src/animation/legacy-film-set-history.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "identity",
    reason: "历史债：身份白名单或旧格式 reader 仍在内核。去向：第 7 组清债。"
  },
  {
    file: "web/services/canvas-service/src/animation/legacy-film-set-identities.ts",
    literals: ["filmSetContent"],
    stage: "identity",
    reason: "历史债：身份白名单或旧格式 reader 仍在内核。去向：第 7 组清债。"
  },
  {
    file: "web/services/canvas-service/src/animation/legacy-film-set-reader.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "identity",
    reason: "历史债：身份白名单或旧格式 reader 仍在内核。去向：第 7 组清债。"
  },
  {
    file: "web/services/canvas-service/src/storage/core/compat-inventory.ts",
    literals: ["filmSetContent"],
    stage: "identity",
    reason: "历史债：身份白名单或旧格式 reader 仍在内核。去向：第 7 组清债。"
  },
  {
    file: "web/frontend/src/cordis/contract/authoring.ts",
    literals: ["film-set"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/events/catalog.ts",
    literals: ["film-set","filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/canvas-runtime/canvas-runtime-options.ts",
    literals: ["filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/canvas-runtime/plugin.tsx",
    literals: ["filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/canvas-shell/canvas-motion-issues.ts",
    literals: ["filmSetContent"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/canvas-shell/canvas-node-index.ts",
    literals: ["filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/canvas-shell/clipboard/payload.ts",
    literals: ["filmSetContent","filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/canvas-shell/interaction-double-click.ts",
    literals: ["filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/canvas-shell/interaction-hover.ts",
    literals: ["filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/canvas-shell/interaction-types.ts",
    literals: ["filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/canvas-shell/shot-preview-scene-input.ts",
    literals: ["filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/model-editor/model-editor-workspace.tsx",
    literals: ["film-set"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/model-editor/model-focus-kind.ts",
    literals: ["film-set"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/model-scene/plugin.ts",
    literals: ["scenePlacement"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/run-state/agent-turn-projection.ts",
    literals: ["film-set"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/run-state/store.ts",
    literals: ["film-set"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/plugins/task-execution/plugin.tsx",
    literals: ["film-set"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/services/canvas-remote.ts",
    literals: ["film-set"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/services/hover-store.ts",
    literals: ["filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/cordis/ui/assistant-execution/authoring-composer.tsx",
    literals: ["film-set"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/extension-api/composite-assets.ts",
    literals: ["shotPreviewLinks"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "web/frontend/src/extension-api/model-workspace.ts",
    literals: ["filmSetNodeId"],
    stage: "interaction",
    reason: "历史债：前端仍按扩展身份或字段分支。去向：第 5 组改为交互策略。"
  },
  {
    file: "scripts/lib/film-set-shooting-shot-migration.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "scripts/lib/model-native-migration.ts",
    literals: ["film-set","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "scripts/migrate-model-native-nodes.mjs",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/backend/src/ports/assistant-delivery.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/backend/src/ports/authoring-adapters.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/backend/chatgpt-dto.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/animation-snapshot.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/builtin-node-capabilities.ts",
    literals: ["scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/canvas-node-model.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/composite-asset-scene.ts",
    literals: ["scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/domain/core/shot-preview-node.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/domain/core/shot-reference.ts",
    literals: ["film-set","filmSetAnimations","filmSetNodeId","shotPreview"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/domain/runtime-node-data.ts",
    literals: ["filmSetContent"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-animations.ts",
    literals: ["filmSetAnimations"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-clip-compilation.ts",
    literals: ["filmSetAnimations","filmSetContent"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-clip-edit.ts",
    literals: ["filmSetAnimations","filmSetContent"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-clip-ops.ts",
    literals: ["filmSetContent"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-clip-view.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-composition.ts",
    literals: ["filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-content.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-conversion/candidate.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-conversion/instruction.ts",
    literals: ["film-set","filmSetAnimations","filmSetContent"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-item-edit.ts",
    literals: ["filmSetAnimations","filmSetContent"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-object-container.ts",
    literals: ["film-set","filmSetContent","filmSetNodeId"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-object-replacement.ts",
    literals: ["filmSetAnimations","filmSetContent"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-shot-image-reference.ts",
    literals: ["filmSetNodeId","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-shot-preview.ts",
    literals: ["filmSetAnimations","filmSetNodeId","shotPreview"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/film-set-shot-reference.ts",
    literals: ["film-set","filmSetNodeId"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/node-history/codec.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/node-history/types.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/protocol.ts",
    literals: ["filmSetNodeId"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/run-state/film-set-feedback.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/canvas/run-state/types.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/extension/assistant/assistant-execution.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/extension/assistant/conversation-codec.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/contracts/src/extension/assistant/conversation.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/animation/film-set-scene-space-migration.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/animation/film-set-shooting-shot-migration.ts",
    literals: ["filmSetAnimations","filmSetContent"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/model-mcp/content-identity.ts",
    literals: ["scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/model-mcp/model-reader.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/model-mcp/preview-service.ts",
    literals: ["scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/model-mcp/service-types.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/storage/core/node-history-service/current-state.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/storage/core/node-history-service/registration.ts",
    literals: ["filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/storage/core/node-history-service/restore.ts",
    literals: ["filmSetContent"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/storage/migrations/film-set-shooting-shots.ts",
    literals: ["film-set","filmSetAnimations","filmSetContent","scenePlacement","shotPreview"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/services/canvas-service/src/task/shot-reference-resolution.ts",
    literals: ["filmSetNodeId"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "web/tooling/source-size-allowlist.ts",
    literals: ["film-set"],
    stage: "node-data",
    reason: "历史债：内核仍读取扩展 nodeData 字段。去向：第 2 组改为 owner codec。"
  },
  {
    file: "bevy/src/canvas_query/interaction/tests.rs",
    literals: ["filmSetNodeId"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/canvas_query/interaction/tests/node_action.rs",
    literals: ["filmSetNodeId"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/canvas_query/shot_preview.rs",
    literals: ["filmSetNodeId","shotPreview"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/canvas2d/ownership_links.rs",
    literals: ["filmSetNodeId"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/model3d/filmset_camera.rs",
    literals: ["filmSetNodeId","shotPreview"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/model3d/preparation/schedule.rs",
    literals: ["film-set"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/model3d/tests/demand.rs",
    literals: ["filmSetNodeId","shotPreview"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/model3d/tests/filmset_camera.rs",
    literals: ["filmSetNodeId","shotPreview"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/model3d/tests/overview_lod.rs",
    literals: ["filmSetNodeId","shotPreview"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/model3d/tests/playback_representation.rs",
    literals: ["filmSetNodeId","shotPreview"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/protocol/scene.rs",
    literals: ["filmSetNodeId","shotPreview","shotPreviewLinks"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/protocol/tests_shot_preview.rs",
    literals: ["filmSetNodeId","shotPreview","shotPreviewLinks"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "bevy/src/shot_node_preview/plan.rs",
    literals: ["filmSetNodeId","shotPreview"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "web/backend/src/recording-executor/scheduler.ts",
    literals: ["filmSetNodeId"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "web/contracts/src/canvas/render-scene/film-set-projection.ts",
    literals: ["scenePlacement"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "web/contracts/src/canvas/render-scene/scene-builder.ts",
    literals: ["filmSetNodeId","shotPreview","shotPreviewLinks"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "web/contracts/src/canvas/render-scene/shot-preview-projection.ts",
    literals: ["filmSetNodeId","shotPreview"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "web/contracts/src/canvas/render-scene/wire-scene.ts",
    literals: ["shotPreview","shotPreviewLinks"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "web/contracts/src/canvas/render-scene/wire-shot-preview.ts",
    literals: ["filmSetNodeId"],
    stage: "render",
    reason: "历史债：渲染 wire 或场景构建仍含扩展字段。去向：第 6 组改为通用原语。"
  },
  {
    file: "web/contracts/src/canvas/mcp-internal/types.ts",
    literals: ["film-set","filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "route",
    reason: "历史债：内核仍写死扩展路由、工具或媒体作用域。去向：第 4 组改为内容路由。"
  },
  {
    file: "web/services/agent-connections/src/target-prompt.ts",
    literals: ["film-set","filmSetAnimations","filmSetContent"],
    stage: "route",
    reason: "历史债：内核仍写死扩展路由、工具或媒体作用域。去向：第 4 组改为内容路由。"
  },
  {
    file: "web/services/agent-connections/src/target-tools.ts",
    literals: ["film-set"],
    stage: "route",
    reason: "历史债：内核仍写死扩展路由、工具或媒体作用域。去向：第 4 组改为内容路由。"
  },
  {
    file: "web/services/canvas-service/src/api/canvas-api.ts",
    literals: ["film-set"],
    stage: "route",
    reason: "历史债：内核仍写死扩展路由、工具或媒体作用域。去向：第 4 组改为内容路由。"
  },
  {
    file: "web/services/canvas-service/src/clients/media-client.ts",
    literals: ["film-set"],
    stage: "route",
    reason: "历史债：内核仍写死扩展路由、工具或媒体作用域。去向：第 4 组改为内容路由。"
  },
  {
    file: "web/services/mcp-service/src/model-mcp/animation-tools.ts",
    literals: ["film-set","filmSetAnimations","filmSetContent","scenePlacement"],
    stage: "route",
    reason: "历史债：内核仍写死扩展路由、工具或媒体作用域。去向：第 4 组改为内容路由。"
  },
  {
    file: "web/services/mcp-service/src/model-mcp/film-set-clip-tools.ts",
    literals: ["filmSetAnimations","filmSetContent"],
    stage: "route",
    reason: "历史债：内核仍写死扩展路由、工具或媒体作用域。去向：第 4 组改为内容路由。"
  }
];
