/**
 * Agent authoring 工具面：Canvas Script 工具（get/validate/submit）
 * （change: 2026-10-13-add-canvas-script-authoring，任务 4.3 / 4.4 / design D3、D8）。
 *
 * 三项工具是**服务端受限执行**的严格协议入口：MCP 只做严格 input/output schema、可信
 * 上下文与结果适配，不执行脚本、不持有画布权威。`submit_canvas_script` 保留 destructive
 * annotation（支持删除），但不注册 `orchestrate_canvas`。
 *
 * 文本 content 只作为安全摘要：不回显源码、不回显原始请求体。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  CANVAS_SCRIPT_VERSIONS,
  DEFAULT_CANVAS_SCRIPT_VERSION,
  agentProtocolVersion,
  canvasScriptError
} from "@woohaa3/contracts";
import { errorResult, structured, type AgentAuthoringToolDeps } from "./tool-policy.js";
import { CANVAS_ID_SCHEMA } from "./tool-schemas.js";

const SCRIPT_VERSION_TUPLE = CANVAS_SCRIPT_VERSIONS as unknown as ["woohaa-canvas-js-v1"];

/**
 * 源码 schema（change: 2026-10-22-remove-agent-execution-limits，任务 5.1）：只要求非空，
 * 不再按字节设置应用侧上限；服务端 codec 与隔离执行器才是权威。
 */
const SCRIPT_SOURCE_SCHEMA = z.string().min(1);

const SCRIPT_REQUEST_SCHEMA = {
  ...CANVAS_ID_SCHEMA,
  requestId: z.string().min(1),
  version: z.enum(SCRIPT_VERSION_TUPLE),
  source: SCRIPT_SOURCE_SCHEMA
} as const;

export function registerAgentScriptTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  server.registerTool(
    "get_canvas_script_api",
    {
      title: "读取 Canvas Script API",
      description:
        "按当前授权范围返回受支持脚本版本、node/group/reparent/ungroup/layout/setTitle/existing/connect/move/setPrompt/remove 签名、handle/key 与 placement 规则、执行边界（隔离与可取消）、可用节点种类和示例。只读；不执行脚本、不改变画布。不可用时明确标注原因。",
      inputSchema: z.strictObject({ ...CANVAS_ID_SCHEMA }),
      outputSchema: z.looseObject({
        available: z.boolean(),
        version: z.string().optional(),
        reason: z.string().optional()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId }) => {
      if (!deps.client.scriptCapability) {
        return errorResult(canvasScriptError("script-unavailable", "decode", "MCP 未接入 Canvas 脚本能力面"));
      }
      const outcome = await deps.client.scriptCapability({ canvasId });
      if (!outcome.ok) return errorResult(canvasScriptError(outcome.code, "decode", outcome.message, { retryable: true }));
      if (!outcome.available) return structured({ available: false, reason: outcome.reason }, `脚本能力不可用：${outcome.reason}`);
      const descriptor = outcome.descriptor;
      return structured(
        { available: true, protocolVersion: agentProtocolVersion(), ...descriptor },
        `脚本 API ${String(descriptor.version ?? DEFAULT_CANVAS_SCRIPT_VERSION)}：${outcome.nodeKinds.length} 种节点`
      );
    }
  );

  server.registerTool(
    "validate_canvas_script",
    {
      title: "验证 Canvas Script（dry-run）",
      description:
        "执行与提交一致的语法、引用、权限和领域预检，返回规范化操作、refs、预计布局、basisRevision、organization（组标题/直属成员/世界边界）和 warnings。不写画布、不占用 requestId、不保存源码。大脚本可完整传输与预检，不按固定源码/操作/时长额度拒绝。",
      inputSchema: z.strictObject({ ...SCRIPT_REQUEST_SCHEMA, expectedRevision: z.number().int().nonnegative().optional() }),
      outputSchema: z.looseObject({
        ok: z.literal(true),
        canvasId: z.string(),
        basisRevision: z.number()
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, requestId, version, source, expectedRevision }) => {
      if (!deps.client.validateScript) {
        return errorResult(canvasScriptError("script-unavailable", "decode", "MCP 未接入 Canvas 脚本能力面"));
      }
      const outcome = await deps.client.validateScript({
        canvasId,
        requestId,
        version,
        source,
        ...(expectedRevision !== undefined ? { expectedRevision } : {})
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return structured(outcome.receipt, `脚本预检通过：${outcome.receipt.normalized.length} 个操作，basis revision ${outcome.receipt.basisRevision}`);
    }
  );

  server.registerTool(
    "submit_canvas_script",
    {
      title: "提交 Canvas Script",
      description:
        "画布创建与修改的首选入口。同一任务中已知的节点、连线和修改应合并为一个脚本，先 validate_canvas_script 再提交。全部命令在一次权威事务中保存，重试相同身份与内容返回冻结首次回执。支持删除，因此可能产生破坏性变更；源码不写入画布或持久层。",
      inputSchema: z.strictObject({
        ...SCRIPT_REQUEST_SCHEMA,
        expectedRevision: z.number().int().nonnegative().optional()
      }),
      outputSchema: z.looseObject({
        ok: z.literal(true),
        canvasId: z.string(),
        requestId: z.string(),
        revision: z.number(),
        duplicate: z.boolean(),
        noop: z.boolean()
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false }
    },
    async ({ canvasId, requestId, version, source, expectedRevision }) => {
      if (!deps.client.submitScript) {
        return errorResult(canvasScriptError("script-unavailable", "decode", "MCP 未接入 Canvas 脚本能力面"));
      }
      const outcome = await deps.client.submitScript({
        canvasId,
        requestId,
        version,
        source,
        ...(expectedRevision !== undefined ? { expectedRevision } : {})
      });
      if (!outcome.ok) return errorResult(outcome.error);
      const receipt = outcome.receipt;
      const summary = receipt.duplicate
        ? `重复请求，返回首次回执（revision ${receipt.revision}）`
        : `脚本提交成功：revision ${receipt.revision}，${receipt.nodes.length} 节点 / ${receipt.edges.length} 边`;
      return structured(receipt, summary);
    }
  );
}
