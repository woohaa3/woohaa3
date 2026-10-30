/**
 * 片场内容 owner 的 MCP 工具目录（change: 2026-10-28-generic-extension-content-ownership，任务 6.2）。
 *
 * 工具定义、参数 schema、授权语义和 handler 全部留在扩展；宿主只提供认证后的画布上下文与
 * 通用权威端口（读节点、提交命令、解析房间）。这样新增内容扩展不再需要改 MCP 服务端。
 */
import { z } from "zod";
import {
  FILM_SET_CONTENT_VERSION,
  FILM_SET_EXPORT_PROFILES,
  filmSetBindingHash,
  filmSetClipHash,
  filmSetClipPatchCommand,
  filmSetClipPrecondition,
  filmSetItemAdapterHash,
  isFilmSetClipPatchOp,
  staticShotCameraMotion,
  type FilmSetItemPatchOp,
  type FilmSetNodeData,
  type SupportedModelScriptVersion
} from "@woohaa3/contracts";
import type { ContentMcpTool, ContentMcpToolContext } from "@woohaa3/contracts";
import { FilmSetExportService } from "../../authoring/backend/film-set-export.js";
import { FilmSetItemService } from "../../authoring/backend/film-set-item.js";
import { FilmSetMediaService } from "../../authoring/backend/film-set-media.js";
import { FilmSetNodeService } from "../../authoring/backend/service.js";

type ToolResult = { ok: true; structured?: unknown; text?: string } | { ok: false; text: string; structured: { code: string; message: string } };

const fail = (outcome: { code: string; message: string }): ToolResult => ({
  ok: false,
  text: outcome.message,
  structured: { code: outcome.code, message: outcome.message }
});

const serviceFor = (context: ContentMcpToolContext) =>
  new FilmSetNodeService({
    resolveRoom: context.resolveRoom,
    ...(context.actorId ? { actorId: context.actorId } : {})
  });

const itemServiceFor = (context: ContentMcpToolContext) =>
  new FilmSetItemService({
    resolveRoom: context.resolveRoom,
    ...(context.actorId ? { actorId: context.actorId } : {})
  });

const mediaServiceFor = (context: ContentMcpToolContext) =>
  new FilmSetMediaService({
    resolveRoom: context.resolveRoom,
    ...(context.actorId ? { actorId: context.actorId } : {})
  });

const localTransformSchema = z.object({
  offset: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  scale: z.number().positive(),
  yaw: z.number()
});

function itemOp(input: { kind: "transform" | "delete"; localTransform?: z.infer<typeof localTransformSchema> }): FilmSetItemPatchOp {
  if (input.kind === "delete") return { kind: "delete" };
  if (!input.localTransform) throw new Error("transform 操作需要 localTransform");
  return { kind: "transform", localTransform: input.localTransform };
}

const clipsTool: ContentMcpTool = {
  name: "get_film_set_clips",
  title: "读取片场拍摄镜头",
  description:
    "读取共享片场的全部独立拍摄镜头、默认镜头和并发校验身份。clips 为空表示还没有拍摄镜头（sceneCamera 只是无镜头时的回退构图）；需要镜头/机位时用 missingClipHash 调 mutate_film_set_clip(op.kind:'create') 创建。拍摄镜头引用共享 itemId，不复制人物几何。",
  permission: "read",
  inputSchema: z.object({ canvasId: z.string().min(1), nodeId: z.string().min(1) }),
  async handle(raw, context) {
    if (!context.readNode) return fail({ code: "unavailable", message: "读取能力不可用" });
    const input = raw as { canvasId: string; nodeId: string };
    const result = await context.readNode(input);
    if (!result.ok) return fail(result);
    const collection = result.animation?.filmSetAnimations;
    if (!collection) return fail({ code: "invalid-animation-node", message: "目标不是完整片场" });
    const clipCount = collection.clips.length;
    return {
      ok: true,
      structured: {
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        filmSetAnimations: collection,
        clipCount,
        ...(clipCount === 0
          ? {
              hint: "当前没有拍摄镜头；sceneCamera 只是无镜头时的回退构图。用户要求镜头/机位/拍摄时，用 clipTemplate 把 id/name/initialCamera 改成目标值，作为 mutate_film_set_clip(op.kind:'create') 的 clip，expectedHash 用 missingClipHash；静态构图也用 static，并确认 clips 非空后再报告完成。",
              clipTemplate: {
                id: "clip-1",
                name: "镜头 1",
                kind: "static" as const,
                timeline: { duration: 0, loop: false },
                initialCamera: result.animation?.initialCamera ?? {
                  azimuth: 0,
                  elevation: Math.PI / 4,
                  distance: 4,
                  aspect: "16:9",
                  focusOffset: { x: 0, y: 0, z: 0 }
                },
                cameraMotion: staticShotCameraMotion(),
                bindings: []
              }
            }
          : {}),
        missingClipHash: filmSetBindingHash(undefined),
        missingBindingHash: filmSetBindingHash(undefined),
        items: result.animation!.filmSetContent.items.map((item) => ({ itemId: item.id, adapterHash: filmSetItemAdapterHash(item) })),
        identities: collection.clips.map((clip) => ({
          clipId: clip.id,
          clipHash: filmSetClipHash(clip),
          shotKind: clip.kind,
          rename: filmSetClipPrecondition(collection, clip.id, { kind: "rename", name: clip.name }),
          timeline: filmSetClipPrecondition(collection, clip.id, { kind: "timeline", timeline: clip.timeline }),
          camera: filmSetClipPrecondition(collection, clip.id, { kind: "camera", initialCamera: clip.initialCamera }),
          motion: filmSetClipPrecondition(collection, clip.id, { kind: "camera-motion", cameraMotion: clip.cameraMotion }),
          kind: filmSetClipPrecondition(collection, clip.id, { kind: "set-kind", toKind: clip.kind }),
          default: filmSetClipPrecondition(collection, clip.id, { kind: "set-default" }),
          bindings: clip.bindings.map((binding) => ({
            itemId: binding.itemId,
            hash: filmSetClipPrecondition(collection, clip.id, {
              kind: "binding",
              itemId: binding.itemId,
              expectedAdapterHash: "",
              binding
            })
          }))
        }))
      }
    };
  }
};

const clipTool: ContentMcpTool = {
  name: "mutate_film_set_clip",
  title: "修改片场拍摄镜头",
  description:
    "原子修改指定 clipId：create/rename/duplicate/delete/set-default/timeline/camera/camera-motion/set-kind/binding/confirm-adaptation/replace。expectedHash 使用 get_film_set_clips 中对应字段身份；binding 还需共享对象 adapterHash。静态镜头（kind=static）零时长、无动作；要加动作必须先用 set-kind 显式转为 dynamic。",
  permission: "write",
  inputSchema: z.object({
    canvasId: z.string().min(1),
    nodeId: z.string().min(1),
    clipId: z.string().min(1),
    requestId: z.string().min(1),
    expectedHash: z.string().min(1),
    op: z.record(z.string(), z.unknown())
  }),
  grantArgs(raw) {
    const input = raw as { op?: unknown };
    return isFilmSetClipPatchOp(input.op) && input.op.kind === "duplicate"
      ? { clipId: input.op.newClipId }
      : null;
  },
  async handle(raw, context) {
    if (!context.applyCommands) return fail({ code: "unavailable", message: "片段写入能力不可用" });
    const input = raw as { canvasId: string; nodeId: string; clipId: string; requestId: string; expectedHash: string; op: unknown };
    if (!isFilmSetClipPatchOp(input.op)) return fail({ code: "malformed-request", message: "片段操作格式非法" });
    const result = await context.applyCommands({
      canvasId: input.canvasId,
      commandId: `film-set-clip:${input.canvasId}:${input.nodeId}:${input.clipId}:${input.requestId}`,
      baseRevision: 0,
      commands: [filmSetClipPatchCommand({ nodeId: input.nodeId, clipId: input.clipId, expectedHash: input.expectedHash, op: input.op })]
    });
    return result.ok ? { ok: true, structured: { ...result, nodeId: input.nodeId, clipId: input.clipId } } : fail(result);
  }
};

const submitTool: ContentMcpTool = {
  name: "submit_film_set",
  title: "保存片场内容",
  description:
    "在已有片场中生成或编辑对象，原子保存完整 items-only 片场。所有动画字段（title/sceneCamera/scenePlacement/filmSetContent/filmSetAnimations）都必须放在 animation 对象内。先 get_model_node 获取 animation 与 snapshotHash；复制未修改的对象、片段、运动、镜头和摆放。禁止顶层 modelScript。sceneCamera 只是无拍摄镜头时的回退构图，不是镜头。",
  permission: "write",
  inputSchema: z.object({
    canvasId: z.string().min(1),
    nodeId: z.string().min(1),
    requestId: z.string().min(1),
    expectedSnapshotHash: z.string().min(1),
    animation: z.object({
      title: z.string().optional(),
      scenePlacement: z.record(z.string(), z.unknown()).optional(),
      sceneCamera: z.record(z.string(), z.unknown()).optional(),
      origin: z.record(z.string(), z.unknown()).optional(),
      filmSetContent: z.object({
        schemaVersion: z.literal(FILM_SET_CONTENT_VERSION),
        items: z.array(z.record(z.string(), z.unknown()))
      }),
      filmSetAnimations: z.record(z.string(), z.unknown())
    })
  }),
  async handle(raw, context) {
    const input = raw as {
      canvasId: string;
      nodeId: string;
      requestId: string;
      expectedSnapshotHash: string;
      animation: unknown;
    };
    const outcome = await serviceFor(context).commitFilmSet({ ...input, animation: input.animation as FilmSetNodeData });
    if (!outcome.ok) return fail(outcome);
    const clips = outcome.animation.filmSetAnimations?.clips;
    return {
      ok: true,
      structured:
        clips?.length === 0
          ? {
              ...outcome,
              clipCount: 0,
              hint: "当前片场还没有拍摄镜头；sceneCamera 只是回退构图。若用户要求镜头/机位/拍摄，请用 get_film_set_clips 的 missingClipHash 调 mutate_film_set_clip(op.kind:'create') 创建至少一个镜头（静态构图也用 static）。"
            }
          : outcome
    };
  }
};

const createNodeTool: ContentMcpTool = {
  name: "create_film_set_node",
  title: "创建片场节点",
  description:
    "创建一个自包含的片场节点：复制完整模型源码/语言/版本/摆放，并保存初始镜头、运动脚本与时间线。可传 sourceNodeId 记录来源说明（复制快照，不建立运行依赖）；省略时直接创建。",
  permission: "write",
  inputSchema: z.object({
    canvasId: z.string().min(1),
    nodeId: z.string().min(1),
    requestId: z.string().min(1),
    title: z.string().optional(),
    modelScript: z.string().min(1),
    modelScriptVersion: z.string().min(1),
    sourceNodeId: z.string().min(1).optional(),
    motionScript: z.string().optional(),
    duration: z.number().min(0).max(3600).optional(),
    loop: z.boolean().optional(),
    x: z.number().optional(),
    y: z.number().optional()
  }),
  async handle(raw, context) {
    const input = raw as {
      canvasId: string;
      nodeId: string;
      requestId: string;
      title?: string;
      modelScript: string;
      modelScriptVersion: string;
      sourceNodeId?: string;
      motionScript?: string;
      duration?: number;
      loop?: boolean;
      x?: number;
      y?: number;
    };
    const service = serviceFor(context);
    const outcome = input.sourceNodeId
      ? await service.createFilmSetFromNode({
          canvasId: input.canvasId,
          requestId: input.requestId,
          nodeId: input.nodeId,
          position: { x: input.x ?? 0, y: input.y ?? 0 },
          sourceNodeId: input.sourceNodeId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.motionScript === undefined ? {} : { motionScript: input.motionScript }),
          ...(input.duration === undefined && input.loop === undefined
            ? {}
            : { timeline: { duration: input.duration ?? 0, loop: input.loop ?? false } })
        })
      : await service.createFilmSet({
          canvasId: input.canvasId,
          requestId: input.requestId,
          nodeId: input.nodeId,
          position: { x: input.x ?? 0, y: input.y ?? 0 },
          model: {
            modelScript: input.modelScript,
            modelScriptVersion: input.modelScriptVersion as SupportedModelScriptVersion
          },
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.motionScript === undefined ? {} : { motionScript: input.motionScript }),
          ...(input.duration === undefined && input.loop === undefined
            ? {}
            : { timeline: { duration: input.duration ?? 0, loop: input.loop ?? false } })
        });
    return outcome.ok ? { ok: true, structured: outcome } : fail(outcome);
  }
};

const importTool: ContentMcpTool = {
  name: "import_model_snapshot",
  title: "导入模型快照到片场节点内的对象",
  description:
    "替换片场内指定 model item 的本地模型定义（源码/版本/摆放），并保留该对象的 binding 动作及其旧适配版本。片场为 items-only，必须指定 itemId；可用 expectedSourceHash 做并发 precondition。",
  permission: "write",
  inputSchema: z.object({
    canvasId: z.string().min(1),
    nodeId: z.string().min(1),
    itemId: z.string().min(1),
    requestId: z.string().min(1),
    modelScript: z.string().min(1),
    modelScriptVersion: z.string().min(1),
    expectedSourceHash: z.string().min(1).optional()
  }),
  async handle(raw, context) {
    const input = raw as {
      canvasId: string;
      nodeId: string;
      itemId: string;
      requestId: string;
      modelScript: string;
      modelScriptVersion: string;
      expectedSourceHash?: string;
    };
    const outcome = await serviceFor(context).importModel({
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      itemId: input.itemId,
      requestId: input.requestId,
      modelScript: input.modelScript,
      modelScriptVersion: input.modelScriptVersion as SupportedModelScriptVersion,
      ...(input.expectedSourceHash ? { expectedSourceHash: input.expectedSourceHash } : {})
    });
    return outcome.ok ? { ok: true, structured: outcome } : fail(outcome);
  }
};

const itemTool: ContentMcpTool = {
  name: "mutate_film_set_item",
  title: "修改片场内部对象",
  description:
    "按稳定 itemId 修改共享静态对象：transform（基础摆放 offset/等比 scale/yaw）或 delete。动作、播放配置和适配确认必须使用 mutate_film_set_clip 指定 clipId 与 binding。",
  permission: "write",
  inputSchema: z.object({
    canvasId: z.string().min(1),
    nodeId: z.string().min(1),
    itemId: z.string().min(1),
    requestId: z.string().min(1),
    kind: z.enum(["transform", "delete"]),
    localTransform: localTransformSchema.optional()
  }),
  async handle(raw, context) {
    const input = raw as {
      canvasId: string;
      nodeId: string;
      itemId: string;
      requestId: string;
      kind: "transform" | "delete";
      localTransform?: z.infer<typeof localTransformSchema>;
    };
    try {
      const outcome = await itemServiceFor(context).mutate({
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        itemId: input.itemId,
        requestId: input.requestId,
        op: itemOp(input)
      });
      return outcome.ok ? { ok: true, structured: outcome } : fail(outcome);
    } catch (error) {
      return fail({ code: "malformed-request", message: error instanceof Error ? error.message : "片场对象操作非法" });
    }
  }
};

const exportTool: ContentMcpTool = {
  name: "export_film_set_clip",
  title: "导出片场拍摄镜头（原生录制）",
  description:
    "按 profile 导出所选拍摄镜头的完整动画：standard（短边 720、30fps，缺省）、hd（1080p30）、hd60（1080p60）。经本机宿主原生录制任务渲染并落库，成功后片场右侧出现视频节点。同一 requestId 幂等；原生录制不可用时返回 recording-unavailable。",
  permission: "write",
  inputSchema: z.object({
    canvasId: z.string().min(1),
    nodeId: z.string().min(1),
    clipId: z.string().min(1),
    requestId: z.string().min(1),
    profile: z.enum(FILM_SET_EXPORT_PROFILES),
    expectedContentHash: z.string().min(1).optional()
  }),
  async handle(raw, context) {
    const input = raw as {
      canvasId: string;
      nodeId: string;
      clipId: string;
      requestId: string;
      profile: (typeof FILM_SET_EXPORT_PROFILES)[number];
      expectedContentHash?: string;
    };
    const service = new FilmSetExportService({
      resolveRoom: context.resolveRoom,
      ...(context.recording ? { recording: context.recording } : {}),
      ...(context.themeBackdrop ? { themeBackdrop: context.themeBackdrop } : {})
    });
    const outcome = await service.startExport(input);
    return outcome.ok ? { ok: true, structured: outcome } : fail(outcome);
  }
};

const getExportTool: ContentMcpTool = {
  name: "get_film_set_export",
  title: "查询片场导出任务",
  description: "按 jobId 返回导出阶段、进度与失败原因。成功只在视频节点原子提交后成立，响应里带新视频节点 id。",
  permission: "read",
  inputSchema: z.object({ canvasId: z.string().min(1), jobId: z.string().min(1) }),
  async handle(raw, context) {
    const input = raw as { canvasId: string; jobId: string };
    const service = new FilmSetExportService({
      resolveRoom: context.resolveRoom,
      ...(context.recording ? { recording: context.recording } : {}),
      ...(context.themeBackdrop ? { themeBackdrop: context.themeBackdrop } : {})
    });
    const outcome = await service.getExport(input);
    return outcome.ok ? { ok: true, structured: outcome } : fail(outcome);
  }
};

const addMediaTool: ContentMcpTool = {
  name: "add_film_set_media",
  title: "把图片或视频加入片场",
  description:
    "把同一画布上 ready 的图片或视频节点复制导入为片场媒体平面（保留固有宽高比、默认竖直双面；视频跟随片场时钟）。可用 expectedContentHash 做并发 precondition。",
  permission: "write",
  inputSchema: z.object({
    canvasId: z.string().min(1),
    nodeId: z.string().min(1),
    requestId: z.string().min(1),
    sourceNodeId: z.string().min(1),
    expectedContentHash: z.string().min(1).optional(),
    itemId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    transform: localTransformSchema.optional()
  }),
  async handle(raw, context) {
    const input = raw as {
      canvasId: string;
      nodeId: string;
      requestId: string;
      sourceNodeId: string;
      expectedContentHash?: string;
      itemId?: string;
      name?: string;
      transform?: z.infer<typeof localTransformSchema>;
    };
    const outcome = await mediaServiceFor(context).addMedia({
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      requestId: input.requestId,
      sourceNodeId: input.sourceNodeId,
      ...(input.expectedContentHash ? { expectedContentHash: input.expectedContentHash } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.transform ? { transform: input.transform } : {})
    });
    return outcome.ok ? { ok: true, structured: outcome } : fail(outcome);
  }
};

export const filmSetMcpTools: readonly ContentMcpTool[] = [
  clipsTool,
  clipTool,
  submitTool,
  createNodeTool,
  importTool,
  itemTool,
  addMediaTool,
  exportTool,
  getExportTool
];
