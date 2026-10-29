/**
 * 片场媒体条目受控导入（change: 2026-10-19-extend-film-set-for-motion-graphics，D5）。
 *
 * 画布**拖放**仍只接受普通模型；这里只给 agent 一条受控入口：把同一画布上 ready 的图片/视频
 * 节点复制导入为片场媒体平面。复用 `FilmSetImportService` 的复制导入语义（独立条目、保留固有
 * 宽高比、默认竖直双面平面、视频跟随片场时钟），来源节点保持不变。
 *
 * 只读 committed 权威数据；`expectedContentHash` 是片场内容 precondition，防止覆盖并发修改。
 */
import type { CanvasAuthority } from "@woohaa3/contracts";
import type {
  CanvasCommand,
  CanvasNodeData,
  FilmSetLocalTransform,
  McpAddFilmSetMediaOutcome,
  McpAddFilmSetMediaRequest,
  ServerCanvas,
  StoredAsset
} from "@woohaa3/contracts";
import {
  canonicalFilmSetFields,
  readFilmSetAnimationProjection,
  readFilmSetGroupMarker,
  filmSetContentHash,
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, type CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import { FilmSetImportService, type FilmSetImportRequestItem } from "./film-set-import.js";

export type FilmSetMediaServiceDependencies = {
  resolveRoom: (canvasId: string) => Promise<CanvasAuthority | null>;
  now?: () => string;
  actorId?: string;
};

export class FilmSetMediaService {
  private readonly deps: FilmSetMediaServiceDependencies;
  private readonly imports: FilmSetImportService;

  constructor(deps: FilmSetMediaServiceDependencies) {
    this.deps = deps;
    this.imports = new FilmSetImportService(deps);
  }

  /**
   * 复制导入一条 ready 图片/视频为片场媒体条目。
   *
   * 来源解析（节点类型、资产就绪、宽高比、视频时长）全部在权威画布上重新读取，调用方不能
   * 自报 assetId。
   */
  async addMedia(input: McpAddFilmSetMediaRequest): Promise<McpAddFilmSetMediaOutcome> {
    const canvasId = input.canvasId?.trim() ?? "";
    const nodeId = input.nodeId?.trim() ?? "";
    const requestId = input.requestId?.trim() ?? "";
    const sourceNodeId = input.sourceNodeId?.trim() ?? "";
    if (canvasId === "" || nodeId === "" || requestId === "" || sourceNodeId === "") {
      return { ok: false, code: "malformed-request", message: "canvasId / nodeId / requestId / sourceNodeId 不能为空" };
    }
    const room = await this.deps.resolveRoom(canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message };

    const commandId = `film-set-media:${canvasId}:${nodeId}:${requestId}`;
    const result = await room.submitDerived({
      commandId,
      derive: (canvas) => {
        const derived = this.deriveAddMedia(canvas, nodeId, sourceNodeId, requestId, input);
        if (!derived.ok) return derived;
        return {
          ok: true,
          batch: buildBatch(canvasId, commandId, this.deps.actorId ?? "canvas-model-mcp", canvas.revision, derived.commands)
        };
      }
    });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    const latest = room.exportCanvas();
    if (!latest.ok) return { ok: false, code: "canvas-unavailable", message: latest.message };
    const projection = readFilmSetAnimationProjection(latest.canvas, nodeId);
    if (!projection) return { ok: false, code: "invalid-animation-node", message: "片场群组无法解析" };
    const animation = { value: projection };
    const itemId = input.itemId?.trim() || derivedItemId(animation.value, requestId, sourceNodeId);
    const item = animation.value.filmSetContent.items.find(entry => entry.id === itemId);
    if (!item || (item.kind !== "image" && item.kind !== "video")) {
      return { ok: false, code: "invalid-import", message: "媒体条目未能写入" };
    }
    return {
      ok: true,
      canvasId,
      nodeId,
      itemId: item.id,
      itemKind: item.kind,
      commandId,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      contentHash: filmSetContentHash(animation.value.filmSetContent),
      itemCount: animation.value.filmSetContent.items.length
    };
  }

  private deriveAddMedia(
    canvas: ServerCanvas,
    nodeId: string,
    sourceNodeId: string,
    requestId: string,
    input: McpAddFilmSetMediaRequest
  ): { ok: true; commands: CanvasCommand[] } | { ok: false; code: string; message: string } {
    const node = canvas.document.nodes.find(entry => entry.id === nodeId);
    if (!node) return { ok: false, code: "unknown-node", message: `节点 ${nodeId} 不存在` };
    if (node.type !== "group" || !readFilmSetGroupMarker(canvas.nodeData[nodeId])) {
      return { ok: false, code: "invalid-node-type", message: `节点 ${nodeId} 不是片场` };
    }
    const projection = readFilmSetAnimationProjection(canvas, nodeId);
    if (!projection) return { ok: false, code: "invalid-animation-node", message: "片场群组无法解析" };
    const animation = { value: projection };
    const currentHash = filmSetContentHash(animation.value.filmSetContent);
    if (input.expectedContentHash && input.expectedContentHash !== currentHash) {
      return { ok: false, code: "stale-content", message: "片场内容已被并发修改，请重新读取后重试" };
    }
    const source = canvas.document.nodes.find(entry => entry.id === sourceNodeId);
    if (!source) return { ok: false, code: "unknown-source-node", message: `来源节点 ${sourceNodeId} 不存在` };
    if (source.type !== "image" && source.type !== "video") {
      return { ok: false, code: "unsupported-source", message: "仅 ready 的图片或视频节点可导入片场" };
    }
    const sourceData = canvas.nodeData[sourceNodeId] as CanvasNodeData | undefined;
    const assetId = sourceData?.outputAssetId;
    if (typeof assetId !== "string" || assetId === "") {
      return { ok: false, code: "invalid-source", message: "来源节点没有可导入的媒体资产" };
    }
    const asset = canvas.assets.find((entry: StoredAsset) => entry.id === assetId);
    if (!asset) return { ok: false, code: "unknown-asset", message: `资产 ${assetId} 不存在` };
    if (asset.status !== "ready") return { ok: false, code: "asset-not-ready", message: "资产尚未就绪" };
    if (asset.mediaKind !== source.type) {
      return { ok: false, code: "asset-kind-mismatch", message: "资产类型与来源节点不一致" };
    }
    const itemId = input.itemId?.trim() || derivedItemIdFor(requestId, sourceNodeId);
    if (animation.value.filmSetContent.items.some(item => item.id === itemId)) {
      return { ok: false, code: "invalid-import", message: `片场条目 ${itemId} 已存在` };
    }
    const aspectRatio = readAspectRatio(asset);
    if (aspectRatio === null) {
      return { ok: false, code: "invalid-source", message: "来源媒体缺少合法宽高比" };
    }
    const durationSeconds = readDuration(asset);
    const requestItem: FilmSetImportRequestItem = source.type === "video"
      ? {
          kind: "video",
          itemId,
          name: input.name ?? asset.title ?? "视频",
          sourceNodeId,
          assetId,
          aspectRatio,
          ...(durationSeconds === null ? {} : { durationSeconds })
        }
      : {
          kind: "image",
          itemId,
          name: input.name ?? asset.title ?? "图片",
          sourceNodeId,
          assetId,
          aspectRatio
        };
    // 复用复制导入：与拖放/批量导入同一套校验、布局与身份；来源节点不被修改。
    const planned = this.imports.planImport({
      canvas,
      nodeId,
      requestId,
      item: requestItem,
      ...(input.transform ? { transform: input.transform } : {})
    });
    if (!planned.ok) return planned;
    return { ok: true, commands: planned.commands };
  }
}

/** 媒体资产固有宽高比：优先 metadata 的宽高，否则 16:9。 */
function readAspectRatio(asset: StoredAsset): number | null {
  const width = asset.metadata?.width;
  const height = asset.metadata?.height;
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    const ratio = width / height;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  }
  return asset.mediaKind === "image" || asset.mediaKind === "video" ? 16 / 9 : null;
}

/** 视频时长（秒）；缺失或非法返回 null（不参与时间线扩展）。 */
function readDuration(asset: StoredAsset): number | null {
  const duration = asset.metadata?.duration;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null;
}

/** 新条目的稳定 id：由 requestId 与来源节点派生，重试得到同一 id。 */
export function derivedItemIdFor(requestId: string, sourceNodeId: string): string {
  const safe = `${requestId}-${sourceNodeId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96);
  return `media-${safe}`;
}

function derivedItemId(
  animation: { filmSetContent: { items: ReadonlyArray<{ id: string; kind: string; origin?: { sourceNodeId?: string } }> } },
  requestId: string,
  sourceNodeId: string
): string {
  // 优先按 requestId/来源派生；若派生 id 不存在（调用方给了 itemId），回退到来源匹配。
  const planned = derivedItemIdFor(requestId, sourceNodeId);
  if (animation.filmSetContent.items.some(item => item.id === planned)) return planned;
  const match = animation.filmSetContent.items.find(item => item.origin?.sourceNodeId === sourceNodeId
    && (item.kind === "image" || item.kind === "video"));
  return match?.id ?? planned;
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

void canonicalFilmSetFields;
void (null as unknown as FilmSetLocalTransform);
