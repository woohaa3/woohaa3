import { readFilmSetGroupMarker, createFilmSetGroupMarker, contentKeyForFilmSetGroupSource, readFilmSetAnimationProjection, filmSetAnimationsOf, cloneFilmSetAnimations } from "@woohaa3/contracts";
import type { CanvasAuthority } from "@woohaa3/contracts";
import type { CanvasCommand, CanvasNodeData, ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { cloneFilmSetLocalTransform, type FilmSetLocalTransform, scriptModel3DNodeData, decodeFilmSetContent, emptyFilmSetContent, extendedTimelineDuration, filmSetContentHash, planFilmSetImportItems, type FilmSetImportItemDraft, type FilmSetImportSource } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, type CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import type { ImportFilmSetContentOutcome } from "@woohaa3/contracts";

/**
 * 片场复制导入的权威写入服务
 * （change: 2026-10-08-make-film-set-model-only，任务 2.3 / design D4）。
 *
 * 从**权威画布**读取来源 `model3d` 定义或 ready image/video asset，校验前端锁定的内容
 * 身份，以稳定 requestId 与对象 ID **原子追加**片场内部内容。批量来源存在不支持/非法项时
 * 整批拒绝；不修改来源节点、position、parent、edge 或 mapping；重复请求返回同一结果而不
 * 重复追加。
 *
 * 复用既有 `CanvasCommand`（`nodeData.patch`）与 `CanvasAuthority.submitDerived`；来源位置**不**
 * 进入导入命令（前端在 drop 成功后把源节点恢复到拖动前位置，服务端不提交源移动）。
 */

/** 单次导入请求的来源项（前端生成的稳定对象 ID + 来源描述）。 */
export type FilmSetImportRequestItem =
  | {
      kind: "model";
      itemId: string;
      name: string;
      sourceNodeId: string;
      /** 前端锁定的来源模型源码哈希；不一致时稳定冲突。 */
      expectedSourceHash?: string;
    }
  | {
      kind: "image" | "video";
      itemId: string;
      name: string;
      sourceNodeId: string;
      assetId: string;
      aspectRatio: number;
      /** 视频时长（秒）；用于扩展片场时间线（change: 2026-10-08-make-film-set-model-only）。 */
      durationSeconds?: number;
      /** 前端锁定的来源资产 checksum；不一致时稳定冲突。 */
      expectedChecksum?: string;
    };

export type ImportFilmSetContentInput = {
  canvasId: string;
  requestId: string;
  /** 目标片场节点 id。 */
  nodeId: string;
  items: FilmSetImportRequestItem[];
};

export type { ImportFilmSetContentOutcome };

export type FilmSetImportServiceDependencies = {
  resolveRoom: (canvasId: string) => Promise<CanvasAuthority | null>;
  now?: () => string;
  actorId?: string;
};

/** 单条导入计划输入（供媒体 MCP 工具复用同一套导入语义，D5）。 */
export type PlanFilmSetImportInput = {
  canvas: ServerCanvas;
  nodeId: string;
  requestId: string;
  item: FilmSetImportRequestItem;
  /** 可选基础局部变换；省略时按导入布局错开。 */
  transform?: FilmSetLocalTransform;
};

export class FilmSetImportService {
  private readonly deps: FilmSetImportServiceDependencies;
  private readonly actorId: string;

  constructor(deps: FilmSetImportServiceDependencies) {
    this.deps = deps;
    this.actorId = deps.actorId ?? "canvas-model-mcp";
  }

  /** 原子复制导入一批来源到目标片场。 */
  async import(input: ImportFilmSetContentInput): Promise<ImportFilmSetContentOutcome> {
    const canvasId = input.canvasId?.trim() ?? "";
    const nodeId = input.nodeId?.trim() ?? "";
    const requestId = input.requestId?.trim() ?? "";
    if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
    if (nodeId === "") return { ok: false, code: "malformed-request", message: "nodeId 不能为空" };
    if (requestId === "") return { ok: false, code: "malformed-request", message: "requestId 不能为空" };
    if (!Array.isArray(input.items) || input.items.length === 0) {
      return { ok: false, code: "malformed-request", message: "导入批次不能为空" };
    }
    const itemIds = new Set(input.items.map((item) => item.itemId));
    if (itemIds.size !== input.items.length) {
      return { ok: false, code: "malformed-request", message: "导入对象 id 重复" };
    }

    const room = await this.deps.resolveRoom(canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };

    const commandId = `film-set-import:${canvasId}:${nodeId}:${requestId}`;
    const result = await room.submitDerived({
      commandId,
      derive: (canvas) => {
        const derived = this.deriveImport(canvas, nodeId, input.items);
        if (!derived.ok) return derived;
        return {
          ok: true,
          batch: buildBatch(canvasId, commandId, this.actorId, canvas.revision, derived.commands)
        };
      }
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const latest = room.exportCanvas();
    if (!latest.ok) return { ok: false, code: "canvas-unavailable", message: latest.message };
    const projection = readFilmSetAnimationProjection(latest.canvas, nodeId);
    if (!projection) return { ok: false, code: "invalid-animation-node", message: "片场群组无法解析" };
    const animation = { value: projection };
    return {
      ok: true,
      canvasId,
      nodeId,
      commandId,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      contentHash: filmSetContentHash(animation.value.filmSetContent),
      itemCount: animation.value.filmSetContent.items.length
    };
  }

  /**
   * 规划一条导入命令（不提交）：供媒体 MCP 工具在同一权威画布上复用复制导入语义。
   *
   * 调用方必须先校验片场节点与 precondition；这里只做来源解析、布局与内容拼接。
   */
  planImport(input: PlanFilmSetImportInput):
    | { ok: true; commands: CanvasCommand[] }
    | { ok: false; code: string; message: string } {
    return this.deriveImport(input.canvas, input.nodeId, [input.item], input.transform);
  }

  /**
   * 在最新权威画布上解析来源并规划单条 `nodeData.patch`。
   *
   * 任一来源不支持/未就绪/身份不匹配 → 整批拒绝。来源 `model3d` 必须是普通模型节点；
   * image/video 必须是 ready 且与来源节点 outputAssetId 一致的稳定资产。
   */
  private deriveImport(
    canvas: ServerCanvas,
    nodeId: string,
    items: readonly FilmSetImportRequestItem[],
    transformOverride?: FilmSetLocalTransform
  ): { ok: true; commands: CanvasCommand[] } | { ok: false; code: string; message: string } {
    const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
    if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
    const marker = node.type === "group" ? readFilmSetGroupMarker(canvas.nodeData[nodeId]) : null;
    if (!marker) {
      return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是片场` };
    }
    const projection = readFilmSetAnimationProjection(canvas, nodeId);
    if (!projection) return { ok: false, code: "invalid-animation-node", message: "片场群组无法解析" };
    const animation = { value: projection };

    const drafts: FilmSetImportItemDraft[] = [];
    const importedAt = this.deps.now?.() ?? new Date().toISOString();
    for (const item of items) {
      const source = resolveImportSource(canvas, item);
      if (!source.ok) return source;
      drafts.push({ id: item.itemId, source: source.value, origin: { sourceNodeId: item.sourceNodeId } });
    }
    const planned = planFilmSetImportItems({
      existingItems: animation.value.filmSetContent.items,
      drafts,
      importedAt
    });
    if (!planned.ok) return { ok: false, code: "invalid-import", message: planned.reason };
    // 显式摆放：单条导入允许调用方给出基础局部变换（媒体 MCP 工具使用）。
    if (transformOverride && planned.items.length === 1) {
      planned.items[0] = { ...planned.items[0]!, localTransform: cloneFilmSetLocalTransform(transformOverride) };
    }

    // 视频导入超出当前时长时默认扩展**默认片段**时间线（不缩短已有时间线、不改 loop；
    // change: 2026-10-08-make-film-set-model-only design D6 / 2026-10-11 D10）。
    const currentCollection = filmSetAnimationsOf(animation.value);
    const duration = extendedTimelineDuration(currentCollection.clips.find(clip => clip.id === currentCollection.defaultClipId)?.timeline.duration ?? 0, drafts);
    const collection = cloneFilmSetAnimations(filmSetAnimationsOf(animation.value));
    const defaultClip = collection.clips.find(clip => clip.id === collection.defaultClipId);
    // schema3：只有动态拍摄镜头才可扩展时长；静态镜头必须保持零时长（导入视频不暗中延长静态镜头）。
    if (defaultClip && defaultClip.kind === "dynamic" && duration > defaultClip.timeline.duration) {
      defaultClip.timeline = { duration, loop: defaultClip.timeline.loop };
    }
    const next = createFilmSetGroupMarker(marker);
    const commands: CanvasCommand[] = [];
    for (const item of planned.items) {
      const source = items.find(source => source.itemId === item.id)!;
      const t = item.localTransform;
      const contentKey = contentKeyForFilmSetGroupSource(canvas, source.sourceNodeId);
      if (!contentKey) return { ok: false, code: "invalid-source", message: "来源内容身份不可用" };
      next.sceneBindings.push({ bindingId: item.id, name: item.name, sourceNodeId: source.sourceNodeId, kind: source.kind === "model" ? "model3d" : source.kind, transform: { x: t.offset.x, y: t.offset.y, z: t.offset.z, yaw: t.yaw, scale: t.scale }, visibility: true, contentKey });
      commands.push({ type: "node.update", nodeId: source.sourceNodeId, parentId: nodeId });
    }
    next.clips = next.clips?.map(clip => clip.id === defaultClip?.id ? { ...clip, duration: defaultClip.timeline.duration } : clip);
    commands.push({ type: "nodeData.patch", nodeId, value: { filmSetGroup: next } as CanvasNodeData });
    return { ok: true, commands };
  }
}

/** 解析单个导入来源为权威快照；不支持/未就绪/身份冲突时返回稳定错误。 */
export function resolveImportSource(
  canvas: ServerCanvas,
  item: FilmSetImportRequestItem
): { ok: true; value: FilmSetImportSource } | { ok: false; code: string; message: string } {
  const source = canvas.document.nodes.find((entry) => entry.id === item.sourceNodeId);
  if (!source) return { ok: false, code: "unknown-source-node", message: `来源节点 ${item.sourceNodeId} 不存在` };
  if (item.kind === "model") {
    if (source.type !== "model3d") {
      return { ok: false, code: "unsupported-source", message: "仅普通模型、图片和视频可导入片场" };
    }
    const decoded = scriptModel3DNodeData(canvas.nodeData[source.id] as CanvasNodeData | undefined);
    if (!decoded) return { ok: false, code: "unsupported-source", message: "文件模型无法导入片场" };
    if (item.expectedSourceHash && decoded.model.contentVersion.sourceHash !== item.expectedSourceHash) {
      return { ok: false, code: "stale-source", message: "来源模型已被并发修改" };
    }
    return {
      ok: true,
      value: { kind: "model", name: item.name, model: decoded.model }
    };
  }
  if (item.kind === "image" || item.kind === "video") {
    if (source.type !== "image" && source.type !== "video") {
      return { ok: false, code: "unsupported-source", message: "仅普通模型、图片和视频可导入片场" };
    }
    const asset = canvas.assets.find((entry) => entry.id === item.assetId);
    if (!asset) return { ok: false, code: "unknown-asset", message: `资产 ${item.assetId} 不存在` };
    const validated = validateReadyMediaAsset(asset, item.kind);
    if (!validated.ok) return validated;
    const data = canvas.nodeData[source.id] as CanvasNodeData | undefined;
    if (data?.outputAssetId !== item.assetId) {
      return { ok: false, code: "invalid-source", message: "来源节点与资产引用不一致" };
    }
    if (item.expectedChecksum) {
      const checksum = typeof asset.metadata?.checksum === "string" ? asset.metadata.checksum : "";
      if (checksum !== item.expectedChecksum) return { ok: false, code: "stale-source", message: "来源资产已被并发修改" };
    }
    if (!Number.isFinite(item.aspectRatio) || item.aspectRatio <= 0) {
      return { ok: false, code: "invalid-source", message: "媒体宽高比非法" };
    }
    return {
      ok: true,
      value: {
        kind: item.kind,
        name: item.name,
        assetId: item.assetId,
        aspectRatio: item.aspectRatio,
        ...(typeof item.durationSeconds === "number" && item.durationSeconds > 0
          ? { durationSeconds: item.durationSeconds }
          : {})
      }
    };
  }
  return { ok: false, code: "unsupported-source", message: "不支持的导入来源种类" };
}

/** 资产必须是 ready 且类型匹配的稳定媒体。 */
function validateReadyMediaAsset(
  asset: StoredAsset,
  kind: "image" | "video"
): { ok: true } | { ok: false; code: string; message: string } {
  if (asset.status !== "ready") return { ok: false, code: "asset-not-ready", message: "资产尚未就绪" };
  if (asset.mediaKind !== kind) return { ok: false, code: "asset-kind-mismatch", message: "资产类型与导入种类不一致" };
  return { ok: true };
}

function buildBatch(
  canvasId: string,
  commandId: string,
  actorId: string,
  baseRevision: number,
  commands: CanvasCommand[]
): CanvasCommandBatch {
  return { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId, commandId, baseRevision, actorId, commands };
}

/** 读取片场内容；缺失/非法时返回空集合（供调用方复用）。 */
export function readFilmSetContentOf(canvas: ServerCanvas, nodeId: string) {
  const decoded = decodeFilmSetContent(canvas.nodeData[nodeId]?.["filmSetContent"]);
  return decoded.ok ? decoded.value : emptyFilmSetContent();
}
