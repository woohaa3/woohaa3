/**
 * Agent authoring 工具面：读工具（capabilities/list/graph/changes）与指南
 * （自 `tools.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R05）。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  AGENT_CANVAS_LIMITS,
  AGENT_NODE_DESCRIPTORS,
  CANVAS_SCRIPT_LIMITS,
  CANVAS_SCRIPT_VERSIONS,
  DEFAULT_CANVAS_SCRIPT_VERSION,
  agentCanvasError,
  agentProtocolVersion,
  type AgentCanvasCapabilities
} from "@woohaa3/contracts";
import { errorResult, structured, type AgentAuthoringToolDeps } from "./tool-policy.js";
import { CANVAS_ID_SCHEMA } from "./tool-schemas.js";

export function registerAgentGraphTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  server.registerTool(
    "get_canvas_capabilities",
    {
      title: "读取 Agent 画布能力",
      description:
        "返回协议版本、语义节点种类、支持操作、placement modes、prompt/plan/response 上限及 run 可用性。创建节点或提交计划前先调用；能力响应是事实源。",
      inputSchema: z.strictObject({ ...CANVAS_ID_SCHEMA }),
      outputSchema: z.looseObject({
        protocolVersion: z.number(),
        nodeKinds: z.array(z.looseObject({ kind: z.string() })),
        operations: z.array(z.string())
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId }) => {
      // 与脚本 API 使用同一已授权领域能力；不能用部署层的静态 true 代替实际配置。
      let scriptAvailability: { available: boolean; reason?: string } = {
        available: false, reason: "MCP 未接入 Canvas 脚本能力面"
      };
      if (deps.client.scriptCapability) {
        const outcome = await deps.client.scriptCapability({ canvasId });
        if (!outcome.ok) return errorResult(agentCanvasError(outcome.code, outcome.message, { retryable: false }));
        scriptAvailability = outcome.available
          ? { available: true }
          : { available: false, reason: outcome.reason };
      }
      const capabilities = buildCapabilities({ ...deps, scriptAvailability });
      return structured(capabilities, `Agent 画布能力：${capabilities.nodeKinds.map((n) => n.kind).join(", ")}`);
    }
  );

  server.registerTool(
    "list_canvases",
    {
      title: "列出可访问画布",
      description: "按当前已认证 principal 稳定分页列出可访问画布（id/title/revision/updatedAt/nodeCount）。",
      inputSchema: z.strictObject({
        cursor: z.string().min(1).optional(),
        limit: z.number().int().positive().optional()
      }),
      outputSchema: z.looseObject({ canvases: z.array(z.looseObject({ canvasId: z.string() })) }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ cursor, limit }) => {
      const outcome = await deps.client.listCanvases({
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {})
      });
      if (!outcome.ok) return errorResult(agentCanvasError(outcome.code, outcome.message, { retryable: false }));
      return structured(outcome, `可访问画布 ${outcome.canvases.length} 个`);
    }
  );

  server.registerTool(
    "get_canvas_graph",
    {
      title: "读取 Agent 画布图",
      description:
        "从权威 published 画布返回 title/revision、裁剪后的 nodes/edges 与节点 affordances。支持 nodeIds、aroundNodeId/depth、includePrompt、limit/cursor；cursor 绑定 revision。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        nodeIds: z.array(z.string().min(1)).optional(),
        aroundNodeId: z.string().min(1).optional(),
        depth: z.number().int().min(0).optional(),
        includePrompt: z.boolean().optional(),
        limit: z.number().int().positive().optional(),
        cursor: z.string().min(1).optional()
      }),
      outputSchema: z.looseObject({
        protocolVersion: z.number(),
        canvasId: z.string(),
        revision: z.number(),
        nodes: z.array(z.unknown()),
        edges: z.array(z.unknown())
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input) => {
      const outcome = await deps.client.getGraph(input);
      if (!outcome.ok) {
        return errorResult(
          agentCanvasError(outcome.code, outcome.message, {
            retryable: outcome.code === "unavailable" || outcome.code === "timeout",
            ...(outcome.currentRevision !== undefined ? { currentRevision: outcome.currentRevision } : {})
          })
        );
      }
      return structured(outcome.graph, `画布 ${outcome.graph.canvasId} revision ${outcome.graph.revision}，${outcome.graph.nodes.length} 节点`);
    }
  );

  server.registerTool(
    "get_canvas_changes",
    {
      title: "读取 Agent 画布增量",
      description:
        "返回 sinceRevision 之后的 changed nodes/edges 与 tombstones。起始 revision 已被压缩或不可用时返回 resetRequired，要求重新读取 graph snapshot。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        sinceRevision: z.number().int().nonnegative(),
        limit: z.number().int().positive().optional()
      }),
      outputSchema: z.looseObject({
        protocolVersion: z.number(),
        canvasId: z.string(),
        currentRevision: z.number(),
        resetRequired: z.boolean()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input) => {
      const outcome = await deps.client.getChanges(input);
      if (!outcome.ok) {
        return errorResult(
          agentCanvasError(outcome.code, outcome.message, {
            retryable: outcome.code === "unavailable" || outcome.code === "timeout",
            ...(outcome.currentRevision !== undefined ? { currentRevision: outcome.currentRevision } : {})
          })
        );
      }
      return structured(outcome.delta, `画布 ${outcome.delta.canvasId} 增量到 revision ${outcome.delta.currentRevision}`);
    }
  );

  registerAgentGuide(server);
}

/**
 * MCP 指南（任务 7.4）：discover -> inspect -> validate -> apply -> run 的最小示例。
 */
export function registerAgentGuide(server: McpServer): void {
  server.registerTool(
    "get_agent_canvas_guide",
    {
      title: "读取 Agent Canvas 指南",
      description: "返回 Agent 建图与执行的最小示例与约定（discover -> inspect -> validate -> apply -> run）。",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => structured({ protocolVersion: agentProtocolVersion(), guide: AGENT_CANVAS_GUIDE }, "Agent Canvas 指南")
  );
}

export const AGENT_CANVAS_GUIDE = `# Agent Canvas 指南

推荐调用顺序：\`list_canvases\` -> \`get_canvas_capabilities\` -> \`get_canvas_graph\`
-> \`validate_canvas_plan\` -> \`apply_canvas_plan\` -> \`run_canvas_node\` -> \`get_canvas_run\` -> \`get_node_output\`。

## 最小示例：建一条「文本 -> 图片」提示词链路并执行

\`\`\`json
{
  "name": "apply_canvas_plan",
  "arguments": {
    "canvasId": "my-canvas",
    "requestId": "req-1",
    "operations": [
      { "op": "create_node", "ref": "t", "kind": "text", "prompt": "一只猫", "placement": { "mode": "auto" } },
      { "op": "create_node", "ref": "i", "kind": "image", "placement": { "mode": "after", "anchor": { "ref": "t" } } },
      { "op": "connect", "ref": "e0", "from": { "ref": "t" }, "to": { "ref": "i" } }
    ]
  }
}
\`\`\`

执行（run 可用时）：

\`\`\`json
{ "name": "run_canvas_node", "arguments": { "canvasId": "my-canvas", "requestId": "req-2", "nodeId": "<image nodeId>" } }
\`\`\`

## 约定

- 写工具都要求显式 \`requestId\`；重试同一 requestId + 相同 payload 返回首次回执。
- 先用 \`validate_canvas_plan\` 获得 \`validationToken\`，再提交；basis revision 变化会返回 \`plan-stale\`。
- 节点只表达语义 kind（text/image/video/audio/model），不传 canonical type 或任意 nodeData。
- \`orchestrate_canvas\` 已 deprecated，请改用上面的类型化工具。
`;

export function buildCapabilities(deps: AgentAuthoringToolDeps): AgentCanvasCapabilities {
  const run = deps.runAvailability ?? { available: false, reason: "本部署未启用 MCP 节点执行" };
  const script = deps.scriptAvailability ?? { available: false, reason: "本部署未启用 Canvas 脚本能力" };
  const baseFlow = ["list_canvases", "get_canvas_capabilities", "get_canvas_graph"];
  const scriptFlow = script.available
    ? ["get_canvas_script_api", "validate_canvas_script", "submit_canvas_script"]
    : ["get_canvas_script_api"];
  const tail = run.available ? ["run_canvas_node", "get_canvas_run", "get_node_output"] : [];
  return {
    protocolVersion: agentProtocolVersion(),
    nodeKinds: AGENT_NODE_DESCRIPTORS.map((descriptor) => ({
      kind: descriptor.kind,
      canonicalType: descriptor.canonicalType,
      label: descriptor.label,
      supportsPrompt: descriptor.supportsPrompt,
      executable: descriptor.executable,
      defaultSize: descriptor.defaultSize
    })),
    operations: ["create_node", "connect", "set_prompt", "move_node", "delete", "create_group", "reparent", "ungroup", "set_title", "layout"],
    grouping: { available: script.available, operations: ["group", "reparent", "ungroup", "setTitle"] },
    layout: { available: script.available, modes: ["grid"], coordinateSpace: "world" },
    placementModes: ["absolute", "auto", "after", "before", "below"],
    limits: AGENT_CANVAS_LIMITS,
    // 批量写入统一走 Canvas Script；不可用时仅引导读取原因，不推荐 JSON 提交。
    recommendedFlow: [...baseFlow, ...scriptFlow, ...tail],
    run: { available: run.available, ...(run.reason !== undefined ? { reason: run.reason } : {}) },
    script: {
      available: script.available,
      ...(script.available
        ? {
            version: DEFAULT_CANVAS_SCRIPT_VERSION,
            versions: [...CANVAS_SCRIPT_VERSIONS],
            guideTool: "get_canvas_script_api",
            limits: CANVAS_SCRIPT_LIMITS,
            sourcePersisted: false as const
          }
        : {}),
      ...(!script.available && script.reason !== undefined ? { reason: script.reason } : {})
    }
  };
}
