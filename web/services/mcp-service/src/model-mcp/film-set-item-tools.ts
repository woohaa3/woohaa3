/**
 * Model Canvas MCP HTTP：片场对象级变更工具
 * （自 `mcp-http.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R11）。
 */
import { z } from "zod";
import { jsonResult, toolError } from "./tool-results.js";
import type { ModelMcpHttpOptions, ToolRegistration } from "./http-types.js";

export function registerFilmSetItemTool(reg: ToolRegistration, options: ModelMcpHttpOptions): void {
  reg.server.registerTool(
    "mutate_film_set_item",
    {
      title: "修改片场内部对象",
      description:
        "按稳定 itemId 修改共享静态对象：transform（基础摆放 offset/等比 scale/yaw）或 delete。动作、播放配置和适配确认必须使用 mutate_film_set_clip 指定 clipId 与 binding；旧无 clipId 动作写入明确拒绝。连续跑酷复用现有人物 itemId 和 root 关键帧，勿复制人物几何。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("片场（composite-asset）节点 ID"),
        itemId: z.string().min(1).describe("片场内部对象稳定 ID"),
        requestId: z.string().min(1).describe("幂等请求身份"),
        kind: z.enum(["transform", "delete"]).describe("操作种类（对象动作/播放配置请改用 mutate_film_set_clip 的 binding）"),
        localTransform: z
          .object({
            offset: z.object({ x: z.number(), y: z.number(), z: z.number() }),
            scale: z.number().positive(),
            yaw: z.number()
          })
          .optional()
          .describe("transform 操作的基础局部变换")
      })
    },
    async ({ canvasId, nodeId, itemId, requestId, kind, localTransform }) => {
      if (!options.service?.mutateFilmSetItem) return toolError("片场对象能力当前不可用");
      try {
        const op = buildFilmSetItemOp({ kind, localTransform });
        const outcome = await options.service.mutateFilmSetItem({ canvasId, nodeId, itemId, requestId, op });
        return outcome.ok ? jsonResult(outcome) : toolError(outcome.message, outcome.code);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "片场对象操作非法", "malformed-request");
      }
    }
  );
}

/**
 * 构造片场对象操作（change: 2026-10-09-add-film-set-object-motion-and-editing；
 * change: 2026-10-11-extract-film-set-extension，D8/D10 —— items-only）。
 *
 * items 只保存几何与基础变换；对象动作/播放/适配一律走 `mutate_film_set_clip` binding。
 */
export function buildFilmSetItemOp(input: {
  kind: "transform" | "delete";
  localTransform?: { offset: { x: number; y: number; z: number }; scale: number; yaw: number };
}): import("@woohaa3/contracts").FilmSetItemPatchOp {
  if (input.kind === "delete") return { kind: "delete" };
  if (!input.localTransform) throw new Error("transform 操作需要 localTransform");
  return { kind: "transform", localTransform: input.localTransform };
}
