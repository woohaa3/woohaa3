import { z } from "zod";
import { filmSetClipHash, filmSetClipPatchCommand, filmSetClipPrecondition, filmSetBindingHash, filmSetItemAdapterHash, isFilmSetClipPatchOp, staticShotCameraMotion } from "@woohaa3/contracts";
import { createToolRegistrar } from "./guide.js";
import { jsonResult, toolError } from "./tool-results.js";
import type { ModelMcpHttpOptions, ToolRegistration } from "./http-types.js";

export function registerFilmSetClipTools(reg: ToolRegistration, options: ModelMcpHttpOptions): void {
  const register = createToolRegistrar(reg);
  register("get_film_set_clips", {
    title: "读取片场拍摄镜头",
    description: "读取共享片场的全部独立拍摄镜头、默认镜头和并发校验身份。clips 为空表示还没有拍摄镜头（sceneCamera 只是无镜头时的回退构图）；需要镜头/机位时用 missingClipHash 调 mutate_film_set_clip(op.kind:'create') 创建。拍摄镜头引用共享 itemId，不复制人物几何。",
    inputSchema: z.object({ canvasId: z.string().min(1), nodeId: z.string().min(1) })
  }, async ({ canvasId, nodeId }) => {
    if (!options.service) return toolError("片场能力不可用");
    const result = await options.service.getModelNode({ canvasId, nodeId });
    if (!result.ok) return toolError(result.message, result.code);
    const collection = result.animation?.filmSetAnimations;
    if (!collection) return toolError("目标不是完整片场", "invalid-animation-node");
    const clipCount = collection.clips.length;
    return jsonResult({ canvasId, nodeId, filmSetAnimations: collection, clipCount,
      ...(clipCount === 0 ? {
        hint: "当前没有拍摄镜头；sceneCamera 只是无镜头时的回退构图。用户要求镜头/机位/拍摄时，用 clipTemplate 把 id/name/initialCamera 改成目标值，作为 mutate_film_set_clip(op.kind:'create') 的 clip，expectedHash 用 missingClipHash；静态构图也用 static，并确认 clips 非空后再报告完成。",
        clipTemplate: {
          id: "clip-1",
          name: "镜头 1",
          kind: "static" as const,
          timeline: { duration: 0, loop: false },
          initialCamera: result.animation?.initialCamera ?? {
            azimuth: 0, elevation: Math.PI / 4, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 }
          },
          cameraMotion: staticShotCameraMotion(),
          bindings: []
        }
      } : {}),
      missingClipHash: filmSetBindingHash(undefined), missingBindingHash: filmSetBindingHash(undefined),
      items: result.animation!.filmSetContent.items.map(item => ({ itemId: item.id, adapterHash: filmSetItemAdapterHash(item) })),
      identities: collection.clips.map(clip => ({
      clipId: clip.id, clipHash: filmSetClipHash(clip), shotKind: clip.kind,
      rename: filmSetClipPrecondition(collection, clip.id, { kind: "rename", name: clip.name }),
      timeline: filmSetClipPrecondition(collection, clip.id, { kind: "timeline", timeline: clip.timeline }),
      camera: filmSetClipPrecondition(collection, clip.id, { kind: "camera", initialCamera: clip.initialCamera }),
      motion: filmSetClipPrecondition(collection, clip.id, { kind: "camera-motion", cameraMotion: clip.cameraMotion }),
      kind: filmSetClipPrecondition(collection, clip.id, { kind: "set-kind", toKind: clip.kind }),
      default: filmSetClipPrecondition(collection, clip.id, { kind: "set-default" }),
      bindings: clip.bindings.map(binding => ({ itemId: binding.itemId, hash: filmSetClipPrecondition(collection, clip.id, { kind: "binding", itemId: binding.itemId, expectedAdapterHash: "", binding }) }))
    })) });
  });
  register("mutate_film_set_clip", {
    title: "修改片场拍摄镜头",
    description: "原子修改指定 clipId：create/rename/duplicate/delete/set-default/timeline/camera/camera-motion/set-kind/binding/confirm-adaptation/replace。expectedHash 使用 get_film_set_clips 中对应字段身份；binding 还需共享对象 adapterHash。静态镜头（kind=static）零时长、无动作；要加动作必须先用 set-kind 显式转为 dynamic。复用原人物 itemId，通过 root 关键帧连续移动，禁止复制人物模拟动作。",
    inputSchema: z.object({ canvasId: z.string().min(1), nodeId: z.string().min(1), clipId: z.string().min(1), requestId: z.string().min(1), expectedHash: z.string().min(1), op: z.record(z.string(), z.unknown()) })
  }, async ({ canvasId, nodeId, clipId, requestId, expectedHash, op }) => {
    if (!options.service?.applyCommands) return toolError("片段写入能力不可用");
    if (!isFilmSetClipPatchOp(op)) return toolError("片段操作格式非法", "malformed-request");
    if (op.kind === "duplicate") {
      const denied = reg.grantDenied("mutate_film_set_clip", { canvasId, nodeId, clipId: op.newClipId });
      if (denied) return toolError(denied, "unauthorized");
    }
    const result = await options.service.applyCommands({ canvasId, commandId: `film-set-clip:${canvasId}:${nodeId}:${clipId}:${requestId}`, baseRevision: 0, commands: [filmSetClipPatchCommand({ nodeId, clipId, expectedHash, op })] });
    return result.ok ? jsonResult({ ...result, nodeId, clipId }) : toolError(result.message, result.code);
  });
}
