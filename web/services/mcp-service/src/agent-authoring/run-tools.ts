/**
 * Agent authoring 工具面：节点执行闭环工具
 * （自 `tools.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R05）。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { agentCanvasError, agentProtocolVersion } from "@woohaa3/contracts";
import { auditWrap, errorResult, structured, type AgentAuthoringToolDeps } from "./tool-policy.js";
import { CANVAS_ID_SCHEMA } from "./tool-schemas.js";

export function registerAgentRunTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  // 只有 run 能力可用且下游 client 提供 run 方法时才注册，避免「看似可用」的工具名。
  if (!deps.runAvailability?.available || !deps.client.runNode) {
    return;
  }

  server.registerTool(
    "run_canvas_node",
    {
      title: "执行 Agent 画布节点",
      description:
        "为可执行节点发起生成任务。requestId 稳定派生 runId/jobId；服务端完成与浏览器相同的 model/prompt/参数/引用预检，durable begin 后返回 runId。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        requestId: z.string().min(1),
        nodeId: z.string().min(1),
        modelKey: z.string().min(1).optional(),
        assistant: z.strictObject({ connection: z.strictObject({ connectionId: z.string().min(1), adapterId: z.string().min(1), configRevision: z.number().int().nonnegative(), credentialEpoch: z.number().int().nonnegative() }), model: z.string().min(1), reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional() }).optional(),
        prompt: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional()
      }),
      outputSchema: z.looseObject({ ok: z.literal(true), runId: z.string(), jobId: z.string() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true }
    },
    async ({ canvasId, requestId, nodeId, modelKey, assistant, prompt, parameters }) => {
      return auditWrap(deps, "run_canvas_node", { canvasId, requestId }, async () => {
        const outcome = await deps.client.runNode!({
          ...(canvasId !== undefined ? { canvasId } : {}),
          requestId,
          nodeId,
          ...(assistant ? { assistant } : {}),
          ...(modelKey !== undefined ? { modelKey } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
          ...(parameters !== undefined ? { parameters } : {})
        });
        if (!outcome.ok) {
          return { result: errorResult(agentCanvasError(outcome.code, outcome.message, { retryable: outcome.retryable ?? false })), code: outcome.code };
        }
        return {
          result: structured({ ...outcome, protocolVersion: agentProtocolVersion() }, `run 已受理：${outcome.runId}`),
          code: undefined
        };
      });
    }
  );

  server.registerTool(
    "get_canvas_run",
    {
      title: "查询 Agent 画布运行",
      description:
        "查询 run 的规范状态与进度，区分 active/stale/terminal。可选有界 long-poll（waitMs）；不把 provider 临时状态声明为成功。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        nodeId: z.string().min(1),
        runId: z.string().min(1),
        waitMs: z.number().int().min(0).max(30_000).optional()
      }),
      outputSchema: z.looseObject({ ok: z.literal(true), runId: z.string(), phase: z.string(), stale: z.boolean() }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, nodeId, runId, waitMs }) => {
      return auditWrap(deps, "get_canvas_run", { canvasId }, async () => {
        const outcome = await deps.client.getRun!({
          ...(canvasId !== undefined ? { canvasId } : {}),
          nodeId,
          runId,
          ...(waitMs !== undefined ? { waitMs } : {})
        });
        if (!outcome.ok) {
          return { result: errorResult(agentCanvasError(outcome.code, outcome.message, { retryable: outcome.retryable ?? false })), code: outcome.code };
        }
        return {
          result: structured({ ...outcome.view, ok: true, protocolVersion: agentProtocolVersion() }, `run ${runId}: ${outcome.view.phase}`),
          code: undefined
        };
      });
    }
  );

  server.registerTool(
    "cancel_canvas_run",
    {
      title: "取消 Agent 画布运行",
      description: "只取消匹配的 active run；对 stale/already-terminal 返回稳定结果，不影响较新的 run。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        nodeId: z.string().min(1),
        runId: z.string().min(1)
      }),
      outputSchema: z.looseObject({ ok: z.literal(true), state: z.string() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, nodeId, runId }) => {
      return auditWrap(deps, "cancel_canvas_run", { canvasId }, async () => {
        const outcome = await deps.client.cancelRun!({
          ...(canvasId !== undefined ? { canvasId } : {}),
          nodeId,
          runId
        });
        if (!outcome.ok) {
          return { result: errorResult(agentCanvasError(outcome.code, outcome.message, { retryable: outcome.retryable ?? false })), code: outcome.code };
        }
        return { result: structured({ ...outcome, protocolVersion: agentProtocolVersion() }, `取消状态：${outcome.state}`), code: undefined };
      });
    }
  );

  server.registerTool(
    "get_node_output",
    {
      title: "读取 Agent 节点输出",
      description:
        "读取 run 的规范输出：文本返回有界正文，媒体返回受授权的稳定同源引用与 metadata；不返回 COS 凭据、内部 storage key 或大型 bytes。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        nodeId: z.string().min(1),
        runId: z.string().min(1)
      }),
      outputSchema: z.looseObject({ ok: z.literal(true), available: z.boolean() }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, nodeId, runId }) => {
      return auditWrap(deps, "get_node_output", { canvasId }, async () => {
        const outcome = await deps.client.getOutput!({
          ...(canvasId !== undefined ? { canvasId } : {}),
          nodeId,
          runId
        });
        if (!outcome.ok) {
          return { result: errorResult(agentCanvasError(outcome.code, outcome.message, { retryable: outcome.retryable ?? false })), code: outcome.code };
        }
        return {
          result: structured({ ...outcome.view, ok: true, protocolVersion: agentProtocolVersion() }, outcome.view.available ? "输出可用" : `输出不可用：${outcome.view.reason}`),
          code: undefined
        };
      });
    }
  );
}
