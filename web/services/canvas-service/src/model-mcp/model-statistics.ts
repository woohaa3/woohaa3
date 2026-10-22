/**
 * 模型 MCP 服务：模型规模统计（与聚焦信息面板同源）
 * （change: 2026-10-18-align-model-statistics-with-agent）。
 *
 * 面板读浏览器已就绪的 prepared resource；Agent 侧没有该资源，因此这里在 Canvas 侧用
 * **同一** `modelSceneStatisticsDetail` 从规范 Scene IR 派生，随 `get_model_node` /
 * `submit_model_script` / `get_model_statistics` 返回，避免 Agent 自行手算导致与面板不一致。
 *
 * 只读派生：不写 Store / Y.Doc，不推进 revision。
 */
import {
  modelSceneStatisticsDetail,
  type ModelSceneStatistics,
  type ModelSceneStatisticsBreakdown,
  type SceneV2Op
} from "@woohaa3/contracts";
import { executeSceneIr } from "./script-executor.js";
import type { ModelMcpServiceDependencies } from "./service-types.js";

export type ModelStatisticsDetail = {
  statistics: ModelSceneStatistics;
  breakdown: ModelSceneStatisticsBreakdown;
};

/** 从已校验的规范 ops 派生统计；纯函数，供提交路径直接复用执行结果。 */
export function statisticsFromOps(ops: readonly SceneV2Op[]): ModelStatisticsDetail {
  return modelSceneStatisticsDetail(ops);
}

/**
 * 执行一份脚本并派生统计。
 *
 * 与提交路径使用同一 executor 预算与确定性校验；失败返回稳定 code，不返回部分数字。
 */
export async function statisticsForSource(
  deps: ModelMcpServiceDependencies,
  source: string,
  version: unknown
): Promise<
  | { ok: true; detail: ModelStatisticsDetail }
  | { ok: false; code: string; message: string }
> {
  const execution = await executeSceneIr(source, version, deps.scriptExecutor ?? {});
  if (!execution.ok) {
    return { ok: false, code: `model-script-${execution.stage}`, message: execution.message };
  }
  return { ok: true, detail: statisticsFromOps(execution.ops) };
}
