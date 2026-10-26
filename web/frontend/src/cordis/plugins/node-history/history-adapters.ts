/** 节点历史的本地预览与远端 client 适配；不写 canonical 输出。 */
import type { Context } from "@deepseek-ai/cordis";
import { executeModelScriptVersioned, isSupportedModelScriptVersion, sceneIrVersionFor, type NodeGenerationHistoryDetail, type NodeHistoryPreview } from "@woohaa3/contracts";
import type { NodeHistoryClient } from "./controller.js";
import type { CanvasHistoryClient } from "./canvas-history-controller.js";
import { IMAGE_EDIT_SERVICE, RUN_STATE_SERVICE, type RunStateService, type ImageEditService } from "../service-keys.js";
import { appPublicUrl } from "../../services/app-base-path.js";

/**
 * 逻辑预览引用 → 浏览器公开地址
 * （change: 2026-10-15-support-configurable-app-base-path，design D5）。
 *
 * 历史列表返回的 `preview` 引用是**应用逻辑路径**（`/api/canvas-node-history/...`）。
 * 在非根挂载下直接放进 `<img>`/`<video>` 会按 origin 根解析并绕过挂载前缀，被入口 404。
 * 在 remote 解码到实际消费之间一次性映射；只处理站内根相对路径，`data:`/绝对地址原样透传。
 */
function publicPreview(preview: NodeHistoryPreview): NodeHistoryPreview {
  const resolve = (href: string): string => (href.startsWith("/") ? appPublicUrl(href) : href);
  const resolveNullable = (href: string | null): string | null => (href === null ? null : resolve(href));
  switch (preview.kind) {
    case "image":
      return { kind: "image", href: resolve(preview.href) };
    case "video":
      return { kind: "video", href: resolve(preview.href), posterHref: resolveNullable(preview.posterHref), durationSeconds: preview.durationSeconds };
    case "audio":
      return { kind: "audio", href: resolve(preview.href), durationSeconds: preview.durationSeconds };
    case "model":
      return { kind: "model", thumbnailHref: resolveNullable(preview.thumbnailHref), entry: preview.entry };
    default:
      return preview;
  }
}

/** 列表项只映射受控预览引用；其余安全 metadata 不变。 */
function withPublicPreview<T extends { preview: NodeHistoryPreview }>(item: T): T {
  return { ...item, preview: publicPreview(item.preview) };
}

/** 本地执行并校验 Scene IR，作为聚焦 ModelRoot 的 snapshot override（任务 4.3）。 */
export function applyModelOverride(input: {
  ctx: Context;
  nodeId: string;
  detail: NodeGenerationHistoryDetail;
}): boolean {
  if (input.detail.kind !== "model") return false;
  const adapter = input.ctx.compositeAssets.resolve(input.ctx.canvasState.getCanvas(), input.nodeId);
  if (adapter?.history?.(input.nodeId, input.detail)) {
    input.ctx.canvasRuntime.setModelSceneOverride({ nodeId: input.nodeId, override: null });
    return true;
  }
  if (adapter) return false;
  const version = input.detail.version;
  if (!isSupportedModelScriptVersion(version)) {
    input.ctx.canvasRuntime.setModelSceneOverride({ nodeId: input.nodeId, override: null });
    return false;
  }
  const execution = executeModelScriptVersioned(input.detail.modelScript, version);
  if (!execution.ok) {
    input.ctx.canvasRuntime.setModelSceneOverride({ nodeId: input.nodeId, override: null });
    return false;
  }
  input.ctx.canvasRuntime.setModelSceneOverride({
    nodeId: input.nodeId,
    override: { version: sceneIrVersionFor(version), ops: execution.scene.ops as readonly unknown[] }
  });
  return true;
}

/**
 * 节点当前是否有可用输出（用于固定首项的明确空态）。
 *
 * 媒体类（image/video/audio）要求自身 `outputAssetId` 指向 ready asset；文本要求正文；
 * 模型要求脚本。**不**使用 input mapping / 缓存 URL 冒充当前输出。
 */
export function currentNodeHasOutput(
  canvas: { nodeData?: Record<string, unknown>; assets?: Array<{ id: string; status?: string; text?: string; metadata?: { storageKey?: unknown } }> } | null | undefined,
  nodeId: string,
  kind: NodeGenerationHistoryDetail["kind"]
): boolean {
  const data = canvas?.nodeData?.[nodeId] as Record<string, unknown> | undefined;
  if (!data) return false;
  if (kind === "model") return typeof data.modelScript === "string" && data.modelScript.trim() !== "";
  if (kind === "text") {
    const result = data.result as { kind?: unknown; text?: unknown } | undefined;
    if (result?.kind === "text" && typeof result.text === "string" && result.text !== "") return true;
  }
  const outputId = typeof data.outputAssetId === "string" ? data.outputAssetId : "";
  if (!outputId) return false;
  const asset = canvas?.assets?.find((candidate) => candidate.id === outputId);
  if (!asset || asset.status !== "ready") return false;
  if (kind === "text") return typeof asset.text === "string" && asset.text !== "";
  return typeof asset.metadata?.storageKey === "string" && asset.metadata.storageKey !== "";
}

export function createRemoteClient(ctx: Context): NodeHistoryClient & CanvasHistoryClient {
  return {
    list: async (input) => {
      const result = await ctx.canvasRemote.listNodeHistory(input);
      return result.ok
        ? { ok: true, items: result.value.items.map(withPublicPreview), nextCursor: result.value.nextCursor }
        : { ok: false, code: result.code, error: result.error };
    },
    listCanvas: async (input) => {
      const result = await ctx.canvasRemote.listCanvasHistory(input);
      return result.ok
        ? {
            ok: true,
            items: result.value.items.map(withPublicPreview),
            nextCursor: result.value.nextCursor,
            total: result.value.total,
            kindCounts: result.value.kindCounts
          }
        : { ok: false, code: result.code, error: result.error };
    },
    detail: async (input) => {
      const result = await ctx.canvasRemote.getNodeHistoryDetail(input);
      return result.ok ? { ok: true, detail: result.value } : result;
    },
    apply: async (input) => {
      if (!ctx.canvasSession.isWritable()) return { ok: false, code: "read-only", error: "只读会话无法恢复版本" };
      const runs = ctx.get(RUN_STATE_SERVICE as never) as RunStateService | undefined;
      if (runs?.isBusy(input.canvasId, input.nodeId)) return { ok: false, code: "busy", error: "任务进行中，暂时无法恢复版本" };
      const editor = ctx.get(IMAGE_EDIT_SERVICE as never) as ImageEditService | undefined;
      if (editor?.isActive() && editor.nodeId() === input.nodeId && editor.draftState() !== "saved") {
        return { ok: false, code: "unsaved-draft", error: "请先保存当前草稿，再恢复历史版本" };
      }
      const result = await ctx.canvasRemote.applyNodeHistory(input);
      if (result.ok) {
        const editor = ctx.get(IMAGE_EDIT_SERVICE as never) as ImageEditService | undefined;
        if (editor?.isActive() && editor.nodeId() === input.nodeId) editor.refreshFromCanonical(result.value.revision);
      }
      return result.ok ? { ok: true } : { ok: false, code: result.code, error: result.error };
    },
    clear: async (input) => {
      const result = await ctx.canvasRemote.clearNodeHistory(input);
      return result.ok ? { ok: true, removed: result.value.removed } : { ok: false, code: result.code, error: result.error };
    },
    previewUrl: (input) => ctx.canvasRemote.nodeHistoryPreviewUrl(input)
  };
}
