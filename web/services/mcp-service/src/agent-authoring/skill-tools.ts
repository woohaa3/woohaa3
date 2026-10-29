/**
 * Skill 媒体步骤续接工具
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 4.1–4.3）。
 *
 * 只有宿主显式声明 continuation 能力并注入 client 时才注册；未声明时工具不出现，
 * 外部 Agent 不会「先看到工具、再被拒绝」。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { agentCanvasError, agentProtocolVersion, redactSkillStepForAgent } from "@woohaa3/contracts";
import { auditWrap, errorResult, structured, type AgentAuthoringToolDeps } from "./tool-policy.js";
import { CANVAS_ID_SCHEMA } from "./tool-schemas.js";

const STEP_ID_SCHEMA = {
  skillRunId: z.string().min(1),
  stepId: z.string().min(1),
  nodeId: z.string().min(1).optional()
} as const;

export function registerAgentSkillTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  const client = deps.skillClient;
  if (!deps.skillAvailability?.available || !client) return;

  server.registerTool(
    "wait_for_skill_step",
    {
      title: "等待 Skill 媒体步骤",
      description:
        "按 skillRunId + stepId 有界等待步骤结果；用户重生成时自动跟随最新尝试。只等待，不提交生成；超时或取消等待不会取消媒体任务，也不会重复调用 Provider。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        ...STEP_ID_SCHEMA,
        waitMs: z.number().int().min(0).max(30_000).optional(),
        followLatest: z.boolean().optional()
      }),
      outputSchema: z.looseObject({ ok: z.literal(true), phase: z.string(), attempt: z.number().int().positive() }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, skillRunId, stepId, nodeId, waitMs, followLatest }) => {
      return auditWrap(deps, "wait_for_skill_step", { canvasId }, async () => {
        const outcome = await client.wait({
          ...(canvasId !== undefined ? { canvasId } : { canvasId: "" }),
          skillRunId,
          stepId,
          ...(nodeId !== undefined ? { nodeId } : {}),
          waitMs: waitMs ?? 15_000,
          ...(followLatest !== undefined ? { followLatest } : {})
        });
        if (!outcome.ok) {
          return { result: errorResult(agentCanvasError(outcome.code, outcome.message, { retryable: outcome.retryable ?? false })), code: outcome.code };
        }
        const view = { ...outcome.value, step: redactSkillStepForAgent(outcome.value.step) };
        return {
          result: structured({ ...view, ok: true, protocolVersion: agentProtocolVersion() }, `步骤 ${stepId}: ${view.phase}（attempt ${view.attempt}）`),
          code: undefined
        };
      });
    }
  );

  server.registerTool(
    "get_latest_skill_step_output",
    {
      title: "读取 Skill 步骤最新媒体",
      description:
        "读取步骤 latestSuccessfulRunId 的稳定同源媒体引用与安全 metadata；当前尝试失败时明确区分，只有 allowFallback=true 才返回旧成功版本。不返回 storage key、签名 URL、data/blob URL 或原始 bytes。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        ...STEP_ID_SCHEMA,
        allowFallback: z.boolean().optional()
      }),
      outputSchema: z.looseObject({ ok: z.literal(true), available: z.boolean() }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, skillRunId, stepId, nodeId, allowFallback }) => {
      return auditWrap(deps, "get_latest_skill_step_output", { canvasId }, async () => {
        const outcome = await client.latestOutput({
          ...(canvasId !== undefined ? { canvasId } : { canvasId: "" }),
          skillRunId,
          stepId,
          ...(nodeId !== undefined ? { nodeId } : {}),
          ...(allowFallback !== undefined ? { allowFallback } : {})
        });
        if (!outcome.ok) {
          return { result: errorResult(agentCanvasError(outcome.code, outcome.message, { retryable: outcome.retryable ?? false })), code: outcome.code };
        }
        const view = outcome.value;
        return {
          result: structured({ ...view, ok: true, protocolVersion: agentProtocolVersion() }, view.available ? "最新媒体可用" : `媒体不可用：${view.reason}`),
          code: undefined
        };
      });
    }
  );
}
