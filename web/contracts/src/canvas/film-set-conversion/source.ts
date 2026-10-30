/**
 * 从权威画布冻结转换来源（change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.2/2.2 /
 * design D2/D5）。
 *
 * 开始时冻结 canvas、source identity/hash、asset、范围；任务持有该引用，之后 selection 或
 * 来源内容变化都不重定位。纯函数 + JSON-only；不写画布。
 */
import type { ServerCanvas, StoredAsset } from "../domain/types.js";
import type { CanvasNodeData } from "../domain/index.js";
import { scriptModel3DNodeData } from "../canvas-node-model.js";
import { modelSourceHash } from "../model-definition.js";
import type {
  FilmSetConversionRange,
  FilmSetConversionSourceKind,
  FilmSetConversionSourceSnapshot
} from "./types.js";

/** 支持的来源节点类型集合（与转换来源种类一一对应）。 */
export function readFilmSetConversionSourceKind(nodeType: string): FilmSetConversionSourceKind | null {
  if (nodeType === "image" || nodeType === "video" || nodeType === "model3d") return nodeType;
  return null;
}

/** 从资产 metadata 读取固有宽高比；缺失/非法回退 `1`。 */
export function readConversionAssetAspectRatio(asset: StoredAsset): number {
  const metadata = asset.metadata as Record<string, unknown> | undefined;
  const width = metadata?.width;
  const height = metadata?.height;
  if (typeof width === "number" && Number.isFinite(width) && width > 0
    && typeof height === "number" && Number.isFinite(height) && height > 0) {
    return width / height;
  }
  if (typeof asset.durationSeconds === "number" && asset.durationSeconds > 0) return 16 / 9;
  return 1;
}

/** 视频本次处理范围：`null` 表示缺省（整个视频）。 */
function decodeRange(input: unknown, durationSeconds: number | undefined): FilmSetConversionRange | null | "invalid" {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return "invalid";
  const { startSeconds, endSeconds } = input as Record<string, unknown>;
  if (typeof startSeconds !== "number" || !Number.isFinite(startSeconds) || startSeconds < 0) return "invalid";
  if (typeof endSeconds !== "number" || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return "invalid";
  if (typeof durationSeconds === "number" && endSeconds > durationSeconds + 1e-6) return "invalid";
  return { startSeconds, endSeconds };
}

/**
 * 从权威画布冻结转换来源。
 *
 * 图片/视频必须是 ready 且与来源节点 `outputAssetId` 一致的稳定资产，checksum 必须存在；
 * 视频范围必须落在真实时长内。任一前置条件不满足返回稳定错误，不猜测来源。
 */
export function readFilmSetConversionSource(input: {
  canvas: ServerCanvas;
  sourceNodeId: string;
  range?: FilmSetConversionRange;
}): FilmSetConversionSourceSnapshot {
  const node = input.canvas.document.nodes.find((entry) => entry.id === input.sourceNodeId);
  if (!node) return { ok: false, code: "source-not-found", message: `来源节点 ${input.sourceNodeId} 不存在` };
  // 片场本身是 group，而规范文档不支持嵌套 group：已经在任意组内的节点无法再套片场组。
  if (node.parentId) return { ok: false, code: "unsupported-source", message: "已在组内的节点不能创建片场" };
  const kind = readFilmSetConversionSourceKind(node.type);
  if (!kind) return { ok: false, code: "unsupported-source", message: "仅图片、视频和普通 3D 模型可转为片场" };
  const data = input.canvas.nodeData[input.sourceNodeId] as CanvasNodeData | undefined;
  const title = typeof data?.title === "string" && data.title.trim() ? data.title.trim() : node.type;

  if (kind === "model3d") {
    const decoded = scriptModel3DNodeData(data);
    if (!decoded) return { ok: false, code: "unsupported-source", message: "文件模型无法转为片场，请使用脚本模型" };
    return {
      ok: true,
      title: decoded.title,
      source: { nodeId: input.sourceNodeId, kind, contentHash: modelSourceHash(decoded.model.modelScript) }
    };
  }

  const assetId = typeof data?.outputAssetId === "string" ? data.outputAssetId : "";
  const asset = assetId ? input.canvas.assets.find((entry) => entry.id === assetId) : undefined;
  if (!asset) return { ok: false, code: "source-not-ready", message: "来源素材不存在" };
  if (asset.status !== "ready") return { ok: false, code: "source-not-ready", message: "来源素材尚未就绪" };
  if (asset.mediaKind !== kind) return { ok: false, code: "unsupported-source", message: "来源素材类型不匹配" };
  const checksum = typeof asset.metadata?.checksum === "string" && asset.metadata.checksum.length > 0
    ? asset.metadata.checksum
    : "";
  if (checksum === "") return { ok: false, code: "source-not-ready", message: "来源素材缺少内容校验，无法锁定" };

  const durationSeconds = typeof asset.durationSeconds === "number" && asset.durationSeconds > 0
    ? asset.durationSeconds
    : undefined;
  const range = decodeRange(input.range, durationSeconds);
  if (range === "invalid") {
    return { ok: false, code: "range-required", message: "视频范围非法，请重新选择有效时间范围" };
  }
  const frozenRange = range === null ? undefined : range;
  if (kind === "video" && frozenRange && durationSeconds === undefined) {
    return { ok: false, code: "source-not-ready", message: "视频时长未知，无法校验所选范围" };
  }
  return {
    ok: true,
    title,
    source: {
      nodeId: input.sourceNodeId,
      kind,
      contentHash: checksum,
      assetId,
      aspectRatio: readConversionAssetAspectRatio(asset),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(frozenRange === undefined ? {} : { range: frozenRange })
    }
  };
}
