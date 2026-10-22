/**
 * RunningHub provider 稳定 identity 叶子常量
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.2 / design D3/D4）。
 *
 * 独立于 `shared.ts`（其 barrel 会引入 `data/models.json` 与 schema 纯函数）：纯 metadata 与
 * browser builder 的薄入口只允许可达本叶子的 identity，不把 Provider 模型清单带进 activation。
 */

export const RUNNINGHUB_PLUGIN_ID = "runninghub-provider";
export const RUNNINGHUB_PROVIDER_ID = "runninghub";
