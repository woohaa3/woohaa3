/**
 * 导入本轮 Codex 内建生图（change: 2026-11-03-add-codex-image-import）。
 *
 * 工具参数只有 canvasId、requestId 与可选 index。路径由宿主按本轮登记表取用。
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentAuthoringToolDeps } from "./tool-policy.js";
import { errorResult, structured } from "./tool-policy.js";
import { CANVAS_ID_SCHEMA } from "./tool-schemas.js";

export function registerImportGeneratedImageTool(server: McpServer, deps: AgentAuthoringToolDeps): void {
  server.registerTool(
    "import_generated_image",
    {
      title: "导入 Codex 生成的图片",
      description: "把本轮 Codex 内建生图的第 index 张（从 0 开始）导入当前 2D 组，成为成品图片节点。不要提供磁盘路径。",
      inputSchema: z.strictObject({
        ...CANVAS_ID_SCHEMA,
        requestId: z.string().min(1),
        index: z.number().int().nonnegative().optional()
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input) => {
      if (!deps.client.importGeneratedImage) {
        return errorResult({ code: "unavailable", message: "生图导入未装配", retryable: false });
      }
      const outcome = await deps.client.importGeneratedImage({
        ...(input.canvasId !== undefined ? { canvasId: input.canvasId } : {}),
        requestId: input.requestId,
        ...(input.index !== undefined ? { index: input.index } : {})
      });
      if (!outcome.ok) {
        return errorResult({
          code: outcome.code,
          message: outcome.message,
          retryable: false,
          ...(outcome.totalGenerated !== undefined ? { details: { totalGenerated: outcome.totalGenerated } } : {})
        });
      }
      return structured(
        { ok: true, duplicate: outcome.duplicate, ...outcome.receipt },
        `已导入图片 ${outcome.receipt.nodeId}`
      );
    }
  );
}
