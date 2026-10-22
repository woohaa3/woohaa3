/**
 * React 图像编辑器内核契约（宿主入口）
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.1/3.7 / design D1/D3/D8；
 *  change: 2026-10-21-extract-photocraft-subproject，任务 2.1 / design D2）。
 *
 * 实现已下沉到 `@woohaa3/photocraft-protocol`：能力清单、命令注册表、内容状态与导出摘要
 * 都是纯函数，不需要宿主任何依赖。本模块只做重导出，保留原导入位置与符号名。
 * 逐条列举的原因见 `image-edit.ts`（esbuild 对 external `export *` 的处理）。
 */
export {
  PHOTOCRAFT_CAPABILITIES,
  PHOTOCRAFT_DISABLED_FEATURES,
  PHOTOCRAFT_REJECTIONS,
  checkPhotocraftCapabilities,
  decodeContentState,
  decodeExportResult,
  decodePhotocraftCommands,
  decodePhotocraftError,
  isPhotocraftCapabilityEnabled,
  isPhotocraftCommandDispatchable,
  isPhotocraftFeatureAllowed,
  photocraftCapabilityManifest
} from "@woohaa3/photocraft-protocol";

export type {
  PhotocraftArtifactSummary,
  PhotocraftCapability,
  PhotocraftCommand,
  PhotocraftContentState,
  PhotocraftDisabledFeature,
  PhotocraftEditorError,
  PhotocraftExportResult,
  PhotocraftRejection
} from "@woohaa3/photocraft-protocol";
