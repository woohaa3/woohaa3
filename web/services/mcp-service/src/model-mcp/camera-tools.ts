/**
 * Model Canvas MCP HTTP：镜头 CRUD 工具
 * （自 `mcp-http.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R11）。
 */
import { z } from "zod";
import { MODEL_CAMERA_ASPECTS, SHOT_CAMERA_DEFAULT_ELEVATION, type McpCameraMutation } from "@woohaa3/contracts";
import { createToolRegistrar } from "./guide.js";
import { jsonResult, toolError } from "./tool-results.js";
import type { ModelMcpHttpOptions, ToolRegistration } from "./http-types.js";

export function registerCameraTools(reg: ToolRegistration, options: ModelMcpHttpOptions): void {
  const registerToolWithGrant = createToolRegistrar(reg);
  const defaultElevationDegrees = Math.round((SHOT_CAMERA_DEFAULT_ELEVATION * 180) / Math.PI);
  const cameraCanvasId = z.string().min(1).describe("画布 ID");
  const cameraNodeId = z.string().min(1).describe("model3d / 片场（composite-asset）节点 ID");

  function mutateCamera(nodeId: string, resolvedCanvasId: string, requestId: string, mutation: McpCameraMutation) {
    if (!options.service?.mutateCameras) return toolError("镜头编辑当前不可用", "unavailable");
    return options.service
      .mutateCameras({ canvasId: resolvedCanvasId, nodeId, requestId, mutation })
      .then((outcome) => (outcome.ok ? jsonResult(outcome) : toolError(outcome.message, outcome.code)));
  }

  registerToolWithGrant(
    "create_model_camera",
    {
      title: "创建模型镜头",
      description:
        "为一个模型节点新增一条 canonical 镜头。服务端从权威集合派生稳定 id、默认名称与连续 order，并保留请求的方位、距离、画幅与注视点偏移；既有镜头不受影响。",
      inputSchema: z.object({
        canvasId: cameraCanvasId,
        nodeId: cameraNodeId,
        requestId: z.string().min(1).describe("幂等请求身份；重试同一 requestId 返回首次结果"),
        azimuth: z.number().describe("绕世界 Y 轴方位角（弧度）"),
        distance: z.number().positive().describe("相机到 focus 的距离"),
        name: z.string().min(1).optional().describe("可选名称；省略时用默认名称"),
        elevation: z.number().min(-Math.PI / 2).max(Math.PI / 2).optional().describe(`仰角（弧度，[-90°, +90°]）；省略时默认画布 pitch（当前 ${defaultElevationDegrees}°）`),
        aspect: z.enum(MODEL_CAMERA_ASPECTS).optional().describe(`画幅；省略时默认 ${MODEL_CAMERA_ASPECTS[0]}`),
        focusOffset: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional().describe("注视点三分量偏移")
      })
    },
    async ({ canvasId, nodeId, requestId, azimuth, distance, name, elevation, aspect, focusOffset }) =>
      mutateCamera(nodeId, canvasId, requestId, {
        kind: "create",
        azimuth,
        distance,
        ...(name !== undefined ? { name } : {}),
        ...(elevation !== undefined ? { elevation } : {}),
        ...(aspect !== undefined ? { aspect } : {}),
        ...(focusOffset !== undefined ? { focusOffset } : {})
      })
  );

  registerToolWithGrant(
    "update_model_camera",
    {
      title: "更新模型镜头",
      description:
        "按 id 更新一条 canonical 镜头的方位、距离、画幅或注视点偏移；未提供的字段保持权威现值，其它镜头不受影响。",
      inputSchema: z.object({
        canvasId: cameraCanvasId,
        nodeId: cameraNodeId,
        requestId: z.string().min(1).describe("幂等请求身份"),
        cameraId: z.string().min(1).describe("要更新的镜头 id"),
        azimuth: z.number().optional(),
        distance: z.number().positive().optional(),
        elevation: z.number().min(-Math.PI / 2).max(Math.PI / 2).optional().describe("仰角（弧度，[-90°, +90°]）"),
        aspect: z.enum(MODEL_CAMERA_ASPECTS).optional(),
        focusOffset: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional()
      })
    },
    async ({ canvasId, nodeId, requestId, cameraId, azimuth, distance, elevation, aspect, focusOffset }) =>
      mutateCamera(nodeId, canvasId, requestId, {
        kind: "update",
        id: cameraId,
        ...(azimuth !== undefined ? { azimuth } : {}),
        ...(distance !== undefined ? { distance } : {}),
        ...(elevation !== undefined ? { elevation } : {}),
        ...(aspect !== undefined ? { aspect } : {}),
        ...(focusOffset !== undefined ? { focusOffset } : {})
      })
  );

  registerToolWithGrant(
    "delete_model_camera",
    {
      title: "删除模型镜头",
      description: "按 id 删除一条 canonical 镜头；不删除任何已生成的图片节点或媒体资产。",
      inputSchema: z.object({
        canvasId: cameraCanvasId,
        nodeId: cameraNodeId,
        requestId: z.string().min(1).describe("幂等请求身份"),
        cameraId: z.string().min(1).describe("要删除的镜头 id")
      })
    },
    async ({ canvasId, nodeId, requestId, cameraId }) =>
      mutateCamera(nodeId, canvasId, requestId, { kind: "remove", id: cameraId })
  );

  registerToolWithGrant(
    "rename_model_camera",
    {
      title: "重命名模型镜头",
      description: "按 id 重命名一条 canonical 镜头，不改动其 pose、画幅或注视点。",
      inputSchema: z.object({
        canvasId: cameraCanvasId,
        nodeId: cameraNodeId,
        requestId: z.string().min(1).describe("幂等请求身份"),
        cameraId: z.string().min(1).describe("要重命名的镜头 id"),
        name: z.string().min(1).describe("新名称")
      })
    },
    async ({ canvasId, nodeId, requestId, cameraId, name }) =>
      mutateCamera(nodeId, canvasId, requestId, { kind: "rename", id: cameraId, name })
  );

  registerToolWithGrant(
    "reset_model_camera",
    {
      title: "重置模型镜头",
      description:
        "按 id 重置一条 canonical 镜头：清空注视点偏移并回到给定默认方位与距离，保留稳定 id、名称、order 与画幅。默认 pose 由调用方按当前取景/模型 AABB 派生。",
      inputSchema: z.object({
        canvasId: cameraCanvasId,
        nodeId: cameraNodeId,
        requestId: z.string().min(1).describe("幂等请求身份"),
        cameraId: z.string().min(1).describe("要重置的镜头 id"),
        azimuth: z.number().describe("默认方位角（弧度）"),
        distance: z.number().positive().describe("默认距离"),
        elevation: z.number().min(-Math.PI / 2).max(Math.PI / 2).optional().describe(`默认仰角（弧度）；省略时跟随画布 pitch（当前 ${defaultElevationDegrees}°）`)
      })
    },
    async ({ canvasId, nodeId, requestId, cameraId, azimuth, distance, elevation }) =>
      mutateCamera(nodeId, canvasId, requestId, {
        kind: "reset",
        id: cameraId,
        azimuth,
        distance,
        ...(elevation !== undefined ? { elevation } : {})
      })
  );
}
