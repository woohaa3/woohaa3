/**
 * Agent authoring 工具面：plan/mutation 写工具
 * （自 `tools.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R05）。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  AGENT_CANVAS_LIMITS,
  agentProtocolVersion,
  type AgentPlanOperation,
  type AgentSemanticKind
} from "@woohaa3/contracts";
import type { AgentAuthoringToolDeps } from "./tool-policy.js";
import {
  applyOperations,
  compileForTool
} from "./execution.js";
import { createValidationToken, AGENT_CAPABILITY_VERSION } from "./planner.js";
import { errorResult, now, structured } from "./tool-policy.js";
import {
  CANVAS_ID_SCHEMA,
  OPERATION_SCHEMA,
  PLACEMENT_SCHEMA,
  SEMANTIC_KIND_TUPLE
} from "./tool-schemas.js";

export function registerAgentPlanTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  server.registerTool(
    "validate_canvas_plan",
    {
      title: "验证 Agent 画布计划（dry-run）",
      description:
        "执行与提交一致的授权、引用、节点能力、连接、prompt/placement 预检，但不写入画布、不推进 revision、不占用 requestId。返回规范化操作、确定性实体 ID、basisRevision、warnings 与验证 token。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        requestId: z.string().min(1).optional(),
        operations: z.array(OPERATION_SCHEMA).min(1).max(AGENT_CANVAS_LIMITS.maxPlanOperations)
      }),
      outputSchema: z.looseObject({
        ok: z.literal(true),
        canvasId: z.string(),
        basisRevision: z.number(),
        normalized: z.array(z.unknown()),
        warnings: z.array(z.string())
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, requestId, operations }) => {
      const outcome = await compileForTool(deps, canvasId, "validate_canvas_plan", operations as AgentPlanOperation[], requestId);
      if (!outcome.ok) return errorResult(outcome.error);
      const compiled = outcome.compiled;
      const expiresAtMs = now(deps) + (deps.validationTokenTtlMs ?? 120_000);
      const validationToken = createValidationToken(
        {
          canvasId: compiled.canvasId,
          basisRevision: compiled.basisRevision,
          capabilityVersion: AGENT_CAPABILITY_VERSION,
          planHash: compiled.payloadHash
        },
        expiresAtMs
      );
      const result = {
        ok: true as const,
        protocolVersion: agentProtocolVersion(),
        canvasId: compiled.canvasId,
        basisRevision: compiled.basisRevision,
        normalized: compiled.normalized,
        refs: compiled.refs,
        warnings: compiled.warnings,
        validationToken
      };
      return structured(result, `计划可提交：${compiled.normalized.length} 个操作`);
    }
  );

  server.registerTool(
    "apply_canvas_plan",
    {
      title: "原子提交 Agent 画布计划",
      description:
        "提交有序 operations，允许后续 operation 通过 plan-local ref 引用同一计划中新建的节点/边。全部引用在写入前解析并编译为一个语义命令批次；任一 operation 失败整批不写入。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        requestId: z.string().min(1),
        operations: z.array(OPERATION_SCHEMA).min(1).max(AGENT_CANVAS_LIMITS.maxPlanOperations),
        validationToken: z.string().min(1).optional()
      }),
      outputSchema: z.looseObject({
        ok: z.literal(true),
        canvasId: z.string(),
        requestId: z.string(),
        revision: z.number(),
        duplicate: z.boolean(),
        noop: z.boolean()
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, requestId, operations, validationToken }) => {
      return applyOperations(deps, { canvasId, requestId, operations, validationToken, scope: "apply_canvas_plan" });
    }
  );

  server.registerTool(
    "create_canvas_node",
    {
      title: "创建 Agent 画布节点",
      description:
        "按语义种类创建节点；服务端生成稳定 ID、规范尺寸、任务字段与布局。不接受任意 canonical type 或 nodeData。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        requestId: z.string().min(1),
        kind: z.enum(SEMANTIC_KIND_TUPLE),
        title: z.string().optional(),
        prompt: z.string().optional(),
        placement: PLACEMENT_SCHEMA.optional()
      }),
      outputSchema: z.looseObject({ ok: z.literal(true), canvasId: z.string(), revision: z.number() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, requestId, kind, title, prompt, placement }) => {
      const operation: AgentPlanOperation = {
        op: "create_node",
        ref: "n0",
        kind: kind as AgentSemanticKind,
        ...(title !== undefined ? { title } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(placement !== undefined ? { placement } : {})
      };
      return applyOperations(deps, { canvasId, requestId, operations: [operation], scope: "create_canvas_node" });
    }
  );

  server.registerTool(
    "connect_canvas_nodes",
    {
      title: "连接 Agent 画布节点",
      description: "连接两个已有节点；服务端生成稳定 edgeId、规范 edge label 并收敛输入映射。不接受 edgeId/handle/inputMapping。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        requestId: z.string().min(1),
        fromNodeId: z.string().min(1),
        toNodeId: z.string().min(1),
        label: z.string().optional()
      }),
      outputSchema: z.looseObject({ ok: z.literal(true), canvasId: z.string(), revision: z.number() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, requestId, fromNodeId, toNodeId, label }) => {
      const operation: AgentPlanOperation = {
        op: "connect",
        ref: "e0",
        from: { nodeId: fromNodeId },
        to: { nodeId: toNodeId },
        ...(label !== undefined ? { label } : {})
      };
      return applyOperations(deps, { canvasId, requestId, operations: [operation], scope: "connect_canvas_nodes" });
    }
  );

  server.registerTool(
    "delete_canvas_entities",
    {
      title: "删除 Agent 画布实体",
      description: "删除一个或多个节点及其后代和关联边，作为单个原子计划提交；返回实际删除的节点与边。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        requestId: z.string().min(1),
        nodeIds: z.array(z.string().min(1)).min(1)
      }),
      outputSchema: z.looseObject({ ok: z.literal(true), canvasId: z.string(), revision: z.number() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false }
    },
    async ({ canvasId, requestId, nodeIds }) => {
      const operation: AgentPlanOperation = { op: "delete", targets: nodeIds.map((nodeId) => ({ nodeId })) };
      return applyOperations(deps, { canvasId, requestId, operations: [operation], scope: "delete_canvas_entities" });
    }
  );
}
