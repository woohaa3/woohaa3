/**
 * Model Canvas MCP HTTP：片场节点创建与模型快照导入工具
 * （自 `mcp-http.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R11）。
 */
import { z } from "zod";
import { FILM_SET_CONTENT_VERSION } from "@woohaa3/contracts";
import { createToolRegistrar } from "./guide.js";
import { jsonResult, toolError } from "./tool-results.js";
import type { ModelMcpHttpOptions, ToolRegistration } from "./http-types.js";

export function registerAnimationTools(reg: ToolRegistration, options: ModelMcpHttpOptions): void {
  const registerToolWithGrant = createToolRegistrar(reg);

  registerToolWithGrant("submit_film_set", {
    title: "保存片场内容",
    description: "在已有片场中生成或编辑对象，原子保存完整 items-only 片场。所有动画字段（title/sceneCamera/scenePlacement/filmSetContent/filmSetAnimations）都必须放在 animation 对象内。先 get_model_node 获取 animation 与 snapshotHash；复制未修改的对象、片段、运动、镜头和摆放，新增主要对象分别作为 model item。片场只有地面或为空也可提交，不需要已有模型，不创建替代节点。model item 格式：{id,kind:'model',name,localTransform:{offset:{x,y,z},scale:1,yaw:0},model:{modelScript:<完整脚本>,modelScriptLanguage:'javascript',modelScriptVersion:'woohaa-model-js-v2'}}；模型 contentVersion/哈希由宿主派生，不要编造。禁止顶层 modelScript。sceneCamera 只是无拍摄镜头时的回退构图，不是镜头，提交也不会自动创建镜头；用户要求镜头/机位/拍摄时，必须通过 filmSetAnimations.clips 或随后用 mutate_film_set_clip 创建至少一个镜头（静态构图也要 static），不能只设置 sceneCamera。只修改单个已有对象脚本用 import_model_snapshot；只修改片段动作用 mutate_film_set_clip。此工具只允许整个片场目标，不用于受限对象/片段/镜头目标。",
    inputSchema: z.object({
      canvasId: z.string().min(1), nodeId: z.string().min(1), requestId: z.string().min(1),
      expectedSnapshotHash: z.string().min(1).describe("get_model_node 返回的 snapshotHash；并发变更时拒绝，请重新读取后合并"),
      animation: z.object({
        title: z.string().optional(),
        scenePlacement: z.record(z.string(), z.unknown()).optional(),
        sceneCamera: z.record(z.string(), z.unknown()).optional(),
        origin: z.record(z.string(), z.unknown()).optional(),
        // 版本号跟随内容契约常量，MUST NOT 写字面量：schema 升版时这里会一起前移，
        // 否则工具入口在 v4、保存端也要求 v4 的情况下会把所有提交挡在参数校验（回归：
        // backend/src/ports/model-mcp.integration.test.ts「只有地面的片场生成独立模型」）。
        filmSetContent: z.object({ schemaVersion: z.literal(FILM_SET_CONTENT_VERSION), items: z.array(z.record(z.string(), z.unknown())) }).describe(`完整对象集合，保留原有地面和未修改对象；模型源码位于 item.model 中（内容 schema ${FILM_SET_CONTENT_VERSION}）`),
        filmSetAnimations: z.record(z.string(), z.unknown()).describe("复制读取到的完整 filmSetAnimations；不要丢弃已有片段和 binding")
      })
    })
  }, async (input) => {
    if (!options.service?.commitAnimation) return toolError("片场能力当前不可用");
    const outcome = await options.service.commitAnimation(input);
    if (!outcome.ok) return toolError(outcome.message, outcome.code);
    const clips = (outcome as {
      animation?: { filmSetAnimations?: { clips?: unknown[] } };
    }).animation?.filmSetAnimations?.clips;
    return jsonResult(clips?.length === 0 ? {
      ...outcome,
      clipCount: 0,
      hint: "当前片场还没有拍摄镜头；sceneCamera 只是回退构图。若用户要求镜头/机位/拍摄，请用 get_film_set_clips 的 missingClipHash 调 mutate_film_set_clip(op.kind:'create') 创建至少一个镜头（静态构图也用 static）。"
    } : outcome);
  });

  registerToolWithGrant(
    "create_film_set_node",
    {
      title: "创建片场节点",
      description:
        "创建一个自包含的片场节点（composite-asset + extensionId=\"film-set\"）：复制完整模型源码/语言/版本/摆放，并保存初始镜头、运动脚本与时间线。可传 sourceNodeId 记录来源说明（复制快照，不建立运行依赖）；省略时直接创建。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("新片场节点稳定 ID"),
        requestId: z.string().min(1).describe("幂等请求身份"),
        title: z.string().optional().describe("节点标题"),
        modelScript: z.string().min(1).describe("完整模型脚本"),
        modelScriptVersion: z.string().min(1).describe("模型脚本版本（仅 woohaa-model-js-v2）"),
        sourceNodeId: z.string().min(1).optional().describe("可选来源模型节点 ID；仅作来源说明"),
        motionScript: z.string().optional().describe("运动脚本；省略或空串表示无运动"),
        duration: z.number().min(0).max(3600).optional().describe("时间线时长（秒）；默认 0"),
        loop: z.boolean().optional().describe("是否循环播放；默认 false"),
        x: z.number().optional().describe("画布 x 坐标；默认 0"),
        y: z.number().optional().describe("画布 y 坐标；默认 0")
      })
    },
    async ({ canvasId, nodeId, requestId, title, modelScript, modelScriptVersion, sourceNodeId, motionScript, duration, loop, x, y }) => {
      if (!options.service?.createFilmSetNode) return toolError("片场能力当前不可用");
      const outcome = await options.service.createFilmSetNode({
        canvasId,
        nodeId,
        requestId,
        position: { x: x ?? 0, y: y ?? 0 },
        model: { modelScript, modelScriptVersion },
        ...(title === undefined ? {} : { title }),
        ...(sourceNodeId === undefined ? {} : { sourceNodeId }),
        ...(motionScript === undefined ? {} : { motionScript }),
        ...(duration === undefined && loop === undefined ? {} : { timeline: { duration: duration ?? 0, loop: loop ?? false } })
      });
      return outcome.ok ? jsonResult(outcome) : toolError(outcome.message, outcome.code);
    }
  );

  registerToolWithGrant(
    "import_model_snapshot",
    {
      title: "导入模型快照到片场节点内的对象",
      description:
        "替换片场内**指定 model item** 的本地模型定义（源码/版本/摆放），并**保留**该对象的 binding 动作及其旧适配版本，只触发版本提示重新检查。片场为 items-only，必须指定 itemId；可用 expectedSourceHash 做并发 precondition，防止覆盖并发修改。",
      inputSchema: z.object({
        canvasId: z.string().min(1).describe("画布 ID"),
        nodeId: z.string().min(1).describe("目标片场节点 ID"),
        itemId: z.string().min(1).describe("目标 model item 稳定 ID"),
        requestId: z.string().min(1).describe("幂等请求身份"),
        modelScript: z.string().min(1).describe("要导入的完整模型脚本"),
        modelScriptVersion: z.string().min(1).describe("模型脚本版本"),
        expectedSourceHash: z.string().min(1).optional().describe("当前模型源码哈希；不一致时拒绝")
      })
    },
    async ({ canvasId, nodeId, itemId, requestId, modelScript, modelScriptVersion, expectedSourceHash }) => {
      if (!options.service?.importModelSnapshot) return toolError("片场能力当前不可用");
      const outcome = await options.service.importModelSnapshot({
        canvasId,
        nodeId,
        itemId,
        requestId,
        modelScript,
        modelScriptVersion,
        ...(expectedSourceHash === undefined ? {} : { expectedSourceHash })
      });
      return outcome.ok ? jsonResult(outcome) : toolError(outcome.message, outcome.code);
    }
  );
}
