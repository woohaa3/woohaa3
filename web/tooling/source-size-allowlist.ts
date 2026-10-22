/**
 * 业务源码规模门禁的显式清单
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility）。
 *
 * 单独成文件，便于门禁测试（vitest）与规模报告脚本（node）共用同一份清单，
 * 避免报告脚本为了读取清单而 import vitest。
 */

/**
 * 待还清的分拆债（**不是**例外）：文件应拆分到 ≤500 行，还清后从本清单删除。
 *
 * 2026-10-17 盘点：多分支合并后出现 33 个超限的维护业务源码，门禁在那之前一直处于红灯
 * （测试长期失败 = 没有护栏）。全部登记于此，让门禁恢复"新增超限必失败"的语义；
 * 每项都需要拆分计划，建议按模块分批（宿主脚本 → 契约 → 前端交互 → 服务组合 → bevy）。
 */
export const PENDING_SPLIT: ReadonlySet<string> = new Set<string>([
  // bevy 渲染/查询运行时（9）：最后一项为上游「调整片场总览 LOD」提交新增的 6 行超限，待拆分。
  "bevy/src/model3d/quality.rs",
  "bevy/src/canvas_query/interaction/snapshot.rs",
  "bevy/src/canvas_query/layout.rs",
  "bevy/src/canvas_query/scope.rs",
  "bevy/src/lib.rs",
  "bevy/src/model3d/runtime.rs",
  "bevy/src/model3d/runtime/quality.rs",
  "bevy/src/model_preview/mod.rs",
  "bevy/src/protocol/scene.rs",
  // 开发与装配脚本（1）
  "scripts/lib/extension-host.mjs",
  // 跨端契约（2）
  "web/contracts/src/canvas/render-scene/scene-builder.ts",
  "web/contracts/src/extension/frontend-browser.ts",
  // vendor 库（1）：不再因目录名 `vendor` 豁免门禁；worker.ts 是 worker 生命周期/调度装配，待按职责拆分。
  "web/vendor/pptask-worker-server/src/worker.ts",
  // 扩展协议实现（1）：RunningHub 协议已从 vendor 迁回本扩展（747 行），待按 App/API 两条链路拆分。
  "web/extensions/runninghub-provider/src/provider/provider.ts",
  // 扩展自身（2）
  "web/extensions/film-set/src/authoring/backend/film-set-conversion.ts",
  "web/extensions/tokenhub-provider/src/routes.ts",
  // 前端宿主（13）
  "web/frontend/src/cordis/contract/platform.ts",
  "web/frontend/src/cordis/page-scope.ts",
  "web/frontend/src/cordis/plugins/canvas-menu/plugin.ts",
  "web/frontend/src/cordis/plugins/canvas-runtime/bevy-runtime.ts",
  "web/frontend/src/cordis/plugins/canvas-runtime/composite-asset-media-session.ts",
  "web/frontend/src/cordis/plugins/canvas-runtime/host.ts",
  "web/frontend/src/cordis/plugins/canvas-runtime/video-frame-session.ts",
  "web/frontend/src/cordis/plugins/canvas-shell/interaction-2d-input.ts",
  "web/frontend/src/cordis/plugins/canvas-shell/interaction-controller.ts",
  "web/frontend/src/cordis/plugins/canvas-shell/interaction-performance.ts",
  "web/frontend/src/cordis/plugins/canvas-shell/interaction-types.ts",
  "web/frontend/src/cordis/plugins/task-execution/model-execution-host.tsx",
  "web/frontend/src/cordis/services/canvas-remote.ts",
  // 前端构建脚本（1）
  "web/scripts/build-extension-browser.mjs",
  // 本机宿主服务（6）
  "web/services/application-service/src/extensions/agent-conversation-service.ts",
  "web/services/application-service/src/extensions/control-plane.ts",
  "web/services/canvas-service/src/composition.ts",
  "web/services/canvas-service/src/model-mcp/internal-api.ts",
  "web/services/canvas-service/src/storage/sqlite/canvas-import.ts",
  "web/services/canvas-service/src/storage/sqlite/index.ts",
]);

/**
 * 显式例外（相对仓库根的 posix 路径）。每项必须经审查，记录 owner/原因/后续计划。
 * key 为文件路径，value 为原因与计划。
 */
export const EXCEPTIONS: Readonly<Record<string, string>> = {
  // 当前为空：拆分债由 PENDING_SPLIT 跟踪；如有充分证据的遗留例外再登记。
};

/** 某路径是否属于“已登记的拆分债或例外”。 */
export function isKnownLongFile(path: string): boolean {
  return PENDING_SPLIT.has(path) || path in EXCEPTIONS;
}
