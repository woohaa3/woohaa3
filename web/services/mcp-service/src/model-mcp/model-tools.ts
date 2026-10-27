/**
 * Model Canvas MCP HTTP：模型读取/提交/预览工具
 * （自 `mcp-http.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R11）。
 */
import { z } from "zod";
import { decodeModelCameras, MODEL_CAMERA_ASPECTS, type CanvasCommand } from "@woohaa3/contracts";
import type { AgentPlanOperation } from "@woohaa3/contracts";
import { runToolPlan } from "../agent-authoring/tools.js";
import { buildModelApiGuideText, createToolRegistrar } from "./guide.js";
import { jsonResult, textResult, toolError } from "./tool-results.js";
import type { ModelMcpHttpOptions, ToolRegistration } from "./http-types.js";

export function registerModelTools(reg: ToolRegistration, options: ModelMcpHttpOptions): void {
  const registerToolWithGrant = createToolRegistrar(reg);

  registerToolWithGrant(
    "get_model_api",
    {
      title: "读取 3D 模型脚本 API",
      description: "返回首选/兼容脚本版本、完整 SceneBuilder 与 motion 方法签名、坐标系、轨道限制与单人物关键帧跑酷示例。生成或修改脚本前先调用。"
    },
    async () => textResult(buildModelApiGuideText())
  );

  registerToolWithGrant(
    "list_model_requests",
    {
      title: "列出 3D 模型节点",
      description: "从权威画布列出 model3d / 片场（composite-asset）节点（含标题、提示词、前序参考输入、脚本状态与镜头数量）。",
      inputSchema: z.object({ canvasId: z.string().min(1).describe("画布 ID") })
    },
    async ({ canvasId }) => {
      if (!options.service?.listModelNodes) return toolError("模型 MCP 当前不可用");
      const outcome = await options.service.listModelNodes({ canvasId });
      return outcome.ok ? jsonResult(outcome) : toolError(outcome.message, outcome.code);
    }
  );

  registerToolWithGrant(
    "get_model_node",
    {
      title: "读取 3D 模型节点",
      description:
        "从权威画布读取指定节点当前的真实 nodeType、modelContentVersion、placement、提示词、modelScript、语言版本、应用状态、规范化镜头集合（cameras），以及该节点的前序参考输入（连入的文本内容与图片/视频/音频的稳定引用）。生成模型前先调用它了解可用素材。" +
        "需要与聚焦面板一致的点数/面数时传 includeStatistics=true；不要按 API 成本表自行推算。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("model3d / 片场（composite-asset）节点 ID"),
        resource: z.literal("group-appearance").optional().describe("读普通组自身形象时必须显式指定；片场没有该子资源，其模型由 items 组成"),
        includeStatistics: z.boolean().optional().describe("附带当前脚本的对象数/点数/面数统计（会执行一次权威脚本，成本与提交相同）")
      })
    },
    async ({ canvasId, nodeId, resource, includeStatistics }) => {
      if (!options.service) return toolError("模型 MCP 当前不可用");
      const outcome = await options.service.getModelNode({
        canvasId,
        nodeId,
        ...(resource ? { resource } : {}),
        ...(includeStatistics === true ? { includeStatistics: true } : {})
      });
      return outcome.ok ? jsonResult(outcome) : toolError(outcome.message, outcome.code);
    }
  );

  registerToolWithGrant(
    "get_model_statistics",
    {
      title: "读取或预检模型规模",
      description:
        "返回指定模型节点的对象数、点数、面数（含按几何种类拆分的明细），数值与模型聚焦信息面板共用同一统计函数，不是 GPU 实测值。" +
        "省略 source 统计当前权威脚本；提供 source 时只统计候选脚本，不写画布、不推进 revision，因此可以在提交前核对减面效果。" +
        "segment 缺省 shape 是 capsule（点数/面数成本远高于 box），务必以本工具的返回值为准，不要手算。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("model3d / 片场（composite-asset）节点 ID"),
        source: z.string().min(1).optional().describe("候选脚本；省略时统计当前权威 modelScript")
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, nodeId, source }) => {
      if (!options.service?.getModelStatistics) return toolError("模型统计当前不可用", "unavailable");
      const outcome = await options.service.getModelStatistics({
        canvasId,
        nodeId,
        ...(source === undefined ? {} : { source })
      });
      if (!outcome.ok) return toolError(outcome.message, outcome.code);
      return jsonResult(outcome);
    }
  );

  registerToolWithGrant(
    "get_model_cameras",
    {
      title: "读取模型节点镜头",
      description:
        "读取指定 3D 模型节点当前的规范化镜头集合（id/name/order/azimuth/distance/aspect/focusOffset）。单条增删改前先调用它了解现有镜头与 id；读取不推进画布 revision。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("model3d / 片场（composite-asset）节点 ID")
      })
    },
    async ({ canvasId, nodeId }) => {
      if (!options.service) return toolError("模型 MCP 当前不可用");
      const outcome = await options.service.getModelNode({ canvasId, nodeId });
      if (!outcome.ok) return toolError(outcome.message, outcome.code);
      return jsonResult({ ok: true, canvasId: outcome.canvasId, nodeId: outcome.nodeId, cameras: outcome.cameras });
    }
  );

  registerToolWithGrant(
    "submit_model_script",
    {
      title: "提交 3D 模型脚本",
      description:
        "校验并把版本化 JavaScript 写入 model3d 节点的权威 modelScript。片场不支持顶层模型脚本：生成片场对象用 submit_film_set，替换已有对象用 import_model_snapshot（指定 itemId）。" +
        "model3d 编辑必须提供 requestId，并可用 expectedModelContentHash 做并发 precondition；省略 version 时使用首选版本。" +
        "成功回执包含该脚本的对象数/点数/面数（与模型聚焦面板同源），回复用户时应直接引用，不要自行估算。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("model3d / 片场（composite-asset）节点 ID"),
        source: z.string().min(1).describe("使用 SceneBuilder API 的确定性 JavaScript"),
        version: z.enum(["woohaa-model-js-v2"]).optional().describe("脚本版本；仅支持 woohaa-model-js-v2"),
        requestId: z.string().min(1).describe("model3d/片场编辑的稳定幂等身份（必填）"),
        resource: z.literal("group-appearance").optional().describe("只编辑普通组自身形象；片场模型由 items 组成"),
        expectedContentHash: z.string().min(1).optional().describe("group-appearance 必填；使用 get_model_node 返回的 contentHash"),
        expectedModelContentHash: z.string().min(1).optional().describe("节点当前模型内容哈希；不一致时拒绝并发覆盖")
      })
    },
    async ({ canvasId, nodeId, source, version, requestId, resource, expectedContentHash, expectedModelContentHash }) => {
      if (!options.service) return toolError("模型 MCP 当前不可用");
      const outcome = await options.service.submitScript({
        canvasId,
        nodeId,
        source,
        requestId,
        version: version as never,
        ...(resource ? { resource, expectedContentHash } : {}),
        ...(expectedModelContentHash === undefined ? {} : { expectedModelContentHash })
      });
      if (!outcome.ok) return toolError(outcome.message, outcome.code);
      // jsonResult 的文本摘要已包含与面板同源的规模：多数客户端只读文本 content。
      return jsonResult(outcome);
    }
  );

  registerToolWithGrant(
    "render_model_preview",
    {
      title: "渲染 3D 模型预览",
      description:
        "从权威模型脚本执行出 Scene IR 并在原生无窗口渲染器中生成 PNG 预览。支持 model3d 与片场（composite-asset）；片场节点按保存的初始镜头与运动求值指定 timeSeconds（缺省 0）。只接受画布/节点标识与受限 capture options；不接受调用方源码或 Scene IR。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("3D 模型 / 片场节点 ID"),
        width: z.number().int().min(64).max(2048).optional().describe("预览宽度（像素）"),
        height: z.number().int().min(64).max(2048).optional().describe("预览高度（像素）"),
        background: z.string().optional().describe("背景：transparent 或 #rrggbb"),
        cameraPreset: z.enum(["dimetric", "initial"]).optional().describe("相机 preset：dimetric 几何检查 / initial 保存镜头"),
        clipId: z.string().min(1).optional().describe("动画片段 ID；多片段必须指定"),
        timeSeconds: z.number().min(0).optional().describe("动画采样时刻（秒）；仅片场（composite-asset），缺省 0")
      })
    },
    async ({ canvasId, nodeId, width, height, background, cameraPreset, timeSeconds, clipId }) => {
      if (!options.service) return toolError("模型 MCP 当前不可用");
      if (!options.service.renderPreview) return toolError("模型预览当前不可用", "renderer-unavailable");
      const outcome = await options.service.renderPreview({
        canvasId,
        nodeId,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(background !== undefined ? { background } : {}),
        ...(cameraPreset !== undefined ? { cameraPreset } : {}),
        ...(timeSeconds !== undefined ? { timeSeconds } : {}),
        ...(clipId ? { clipId } : {})
      });
      if (!outcome.ok) return toolError(outcome.message, outcome.code);
      return {
        content: [
          { type: "image" as const, data: outcome.pngBase64, mimeType: "image/png" },
          { type: "text" as const, text: JSON.stringify(outcome.metadata, null, 2) }
        ]
      };
    }
  );

  registerToolWithGrant(
    "set_node_prompt",
    {
      title: "填入节点提示词",
      description:
        "把用户/Agent 编写的提示词写入目标节点的权威 nodeData.prompt。写入经统一 planner 与画布语义命令并落库；不修改其它字段。canvasId 与 requestId 必填。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("目标节点 ID"),
        prompt: z.string().describe("要写入的提示词"),
        requestId: z.string().min(1).describe("显式请求身份；提供完整 planner 幂等语义")
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ canvasId, nodeId, prompt, requestId }) => {
      if (!options.agentAuthoring) return toolError("节点编排当前不可用", "unavailable");
      return applyAgentPlan(options.agentAuthoring, canvasId, requestId, "set_node_prompt", [
        { op: "set_prompt", target: { nodeId }, prompt }
      ]);
    }
  );

  registerToolWithGrant(
    "set_model_camera",
    {
      title: "设置模型节点镜头",
      description:
        "整体替换 3D 模型节点的 canonical 镜头子资源 nodeData.modelCameras。单条增删改优先用 create/update/delete/rename/reset_model_camera，避免回传完整数组。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("model3d / 片场（composite-asset）节点 ID"),
        cameras: z
          .array(
            z.object({
              id: z.string().min(1),
              name: z.string().min(1),
              order: z.number().int().nonnegative(),
              azimuth: z.number(),
              elevation: z.number().min(-Math.PI / 2).max(Math.PI / 2).describe("仰角（弧度，[-90°, +90°]）"),
              distance: z.number().positive(),
              aspect: z.enum(MODEL_CAMERA_ASPECTS),
              focusOffset: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional()
            })
          )
          .describe("完整镜头集合；按 order 持久化")
      })
    },
    async ({ canvasId, nodeId, cameras }) => {
      const decoded = decodeModelCameras(cameras);
      if (!decoded.ok) return toolError(decoded.reason, "malformed-request");
      const commands: CanvasCommand[] = [
        { type: "nodeData.patch", nodeId, value: { modelCameras: decoded.value } as never }
      ];
      return applyIntent(options, canvasId, { tool: "set_model_camera", nodeId, cameras: decoded.value }, commands);
    }
  );
}

/**
 * 任务 7.2：把旧 `set_node_prompt` 的显式 requestId 调用切到统一 planner。
 */
async function applyAgentPlan(
  deps: import("../agent-authoring/tools.js").AgentAuthoringToolDeps,
  canvasId: string,
  requestId: string,
  scope: "set_node_prompt",
  operations: AgentPlanOperation[]
) {
  const outcome = await runToolPlan(deps, { canvasId, requestId, scope, operations });
  if (!outcome.ok) return toolError(outcome.message, outcome.code);
  return jsonResult({ ok: true, canvasId: outcome.canvasId, requestId, revision: outcome.revision, duplicate: outcome.duplicate });
}

/**
 * 把确定性的命令意图交给 Canvas 内部协议提交。
 */
export async function applyIntent(
  options: ModelMcpHttpOptions,
  canvasId: string,
  intent: unknown,
  commands: CanvasCommand[]
) {
  if (!options.service?.applyCommands) return toolError("节点编排当前不可用", "unavailable");
  const commandId = stableCommandId(canvasId, intent);
  const outcome = await options.service.applyCommands({ canvasId, commandId, baseRevision: 0, commands });
  return outcome.ok ? jsonResult(outcome) : toolError(outcome.message, outcome.code);
}

/** 稳定短哈希（无外部依赖）：同画布 + 同意图 → 同一 commandId。 */
export function stableCommandId(canvasId: string, intent: unknown): string {
  const text = `${canvasId}\u0000${JSON.stringify(intent)}`;
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return `mcp-intent:${(hash >>> 0).toString(36)}`;
}
