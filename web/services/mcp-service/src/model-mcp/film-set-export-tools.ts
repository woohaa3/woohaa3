/**
 * Model Canvas MCP HTTP：片场导出工具
 * （change: 2026-10-19-extend-film-set-for-motion-graphics，D8）。
 *
 * `export_film_set_clip` 只提交本机宿主原生录制任务；`get_film_set_export` 查询阶段与结果。
 * 原生录制不可用（纯浏览器 / 平台不支持 / 执行器未就绪）时返回 `recording-unavailable` 与
 * 具体原因，不尝试驱动浏览器页面取帧。
 */
import { z } from "zod";
import { FILM_SET_EXPORT_PROFILES } from "@woohaa3/contracts";
import { createToolRegistrar } from "./guide.js";
import { jsonResult, toolError } from "./tool-results.js";
import type { ModelMcpHttpOptions, ToolRegistration } from "./http-types.js";

export function registerFilmSetExportTools(reg: ToolRegistration, options: ModelMcpHttpOptions): void {
  const register = createToolRegistrar(reg);

  register(
    "export_film_set_clip",
    {
      title: "导出片场拍摄镜头（原生录制）",
      description:
        "按 profile 导出所选拍摄镜头的完整动画：standard（短边 720、30fps，缺省）、hd（1080p30）、hd60（1080p60）。经本机宿主原生录制任务渲染并落库，成功后片场右侧出现视频节点。同一 requestId 幂等；原生录制不可用时返回 recording-unavailable 与具体原因，此时请让用户在界面点「生成视频」走浏览器导出。像素、播放头与页面状态都不会经这里传递。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("片场（composite-asset）节点 ID"),
        clipId: z.string().min(1).describe("拍摄镜头 ID"),
        requestId: z.string().min(1).describe("幂等请求身份；重试返回同一任务"),
        profile: z.enum(FILM_SET_EXPORT_PROFILES).describe("导出档位：standard / hd / hd60"),
        expectedContentHash: z.string().min(1).optional().describe("当前片场内容身份；不一致时拒绝")
      })
    },
    async ({ canvasId, nodeId, clipId, requestId, profile, expectedContentHash }) => {
      if (!options.service?.exportFilmSetClip) {
        return toolError("当前宿主未提供原生录制能力（纯浏览器或平台不支持），无法经 MCP 导出", "recording-unavailable");
      }
      const outcome = await options.service.exportFilmSetClip({
        canvasId,
        nodeId,
        clipId,
        requestId,
        profile,
        ...(expectedContentHash ? { expectedContentHash } : {})
      });
      return outcome.ok ? jsonResult(outcome) : toolError(outcome.message, outcome.code);
    }
  );

  register(
    "get_film_set_export",
    {
      title: "查询片场导出任务",
      description:
        "按 jobId 返回导出阶段、进度与失败原因。成功只在视频节点原子提交后成立，响应里带新视频节点 id。任务在宿主里持续执行，页面切换或重载不会取消。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        jobId: z.string().min(1).describe("export_film_set_clip 返回的任务 id")
      })
    },
    async ({ canvasId, jobId }) => {
      if (!options.service?.getFilmSetExport) {
        return toolError("当前宿主未提供原生录制能力（纯浏览器或平台不支持），无法查询导出任务", "recording-unavailable");
      }
      const outcome = await options.service.getFilmSetExport({ canvasId, jobId });
      return outcome.ok ? jsonResult(outcome) : toolError(outcome.message, outcome.code);
    }
  );
}
