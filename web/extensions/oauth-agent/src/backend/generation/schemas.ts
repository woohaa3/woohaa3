/**
 * ChatGPT 生成编排：结构化输出 schema
 * （自 `generation.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R09）。
 */
// 形状与角色共享：schema 只保留一份定义（change: 2026-11-07-add-pluggable-agent-roles）。
import { modelCandidateSchema } from "@woohaa3/contracts";

/** 结构化的模型候选 schema（contracts 与角色共用同一份）。 */
export function modelSchema(): Record<string, unknown> {
  return modelCandidateSchema();
}
