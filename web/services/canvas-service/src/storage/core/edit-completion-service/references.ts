import { decodeImageEditDocument, isImageProjectDocument, type ImageProjectReferencesRequest, type ImageEditProjectObjectRef } from "@woohaa3/contracts";
import type { StoredAsset } from "@woohaa3/contracts";
import type { EditCompletionContext } from "./types.js";

/**
 * 引用核验失败的具体原因。粘贴是用户直接看得见的操作，笼统的「工程或来源素材已不可用」
 * 无法区分是来源画布读不到、工程记录不一致、素材缺失，还是媒体对象已经不在存储里，
 * 排查时只能靠猜；这里把四种情况分开上报。
 */
export type ProjectReferencesFailure =
  | "source-unavailable"
  | "project-mismatch"
  | "asset-missing"
  | "media-unavailable";

export type ProjectReferencesOutcome =
  | { ok: true; assets: StoredAsset[] }
  | { ok: false; reason: ProjectReferencesFailure };

/** 调用前必须完成来源 read 与目标 write 授权。对象缺失或来源不匹配时整体拒绝。 */
export async function verifyProjectReferences(ctx: EditCompletionContext, request: ImageProjectReferencesRequest): Promise<ProjectReferencesOutcome> {
  if (!ctx.mediaVerifier) return { ok: false, reason: "media-unavailable" };
  const room = await ctx.resolveRoom(request.sourceCanvasId);
  if (!room) return { ok: false, reason: "source-unavailable" };
  const exported = room.exportCanvas();
  if (!exported?.ok) return { ok: false, reason: "source-unavailable" };
  const source = exported.canvas;
  const known = new Map<string, ImageEditProjectObjectRef>();
  const add = (value: unknown) => {
    const decoded = decodeImageEditDocument(value);
    if (decoded.ok && isImageProjectDocument(decoded.value)) known.set(decoded.value.project.storageKey, decoded.value.project);
  };
  for (const data of Object.values(source.nodeData)) add(data.imageEdit);
  // 已保存版本仍可能是剪贴板的来源；只读固定历史，不读取调用方提供的工程定义。
  for (const nodeId of [...new Set(request.nodeIds)]) {
    if (request.projects.every((project) => known.has(project.storageKey))) break;
    for (const entry of await ctx.publisher.listEntriesForNode(request.sourceCanvasId, nodeId)) {
      if (entry.kind === "image" && "imageEdit" in entry.payload) add(entry.payload.imageEdit);
    }
  }
  for (const project of request.projects) {
    const actual = known.get(project.storageKey);
    if (!actual || actual.checksum !== project.checksum || actual.contentType !== project.contentType || actual.size !== project.size) {
      return { ok: false, reason: "project-mismatch" };
    }
  }
  const assets = [...new Set(request.assetIds)].map((id) => source.assets.find((asset) => asset.id === id));
  if (assets.some((asset) => !asset)) return { ok: false, reason: "asset-missing" };
  const keys = new Set(request.projects.map((project) => project.storageKey));
  for (const asset of assets) {
    const key = asset?.metadata?.storageKey;
    if (typeof key !== "string" || !key) return { ok: false, reason: "asset-missing" };
    keys.add(key);
  }
  // 有界串行探测，避免一次粘贴突发启动大量远端请求。
  for (const key of keys) {
    // 引用对象来自**来源画布**：按来源画布作用域探测，远端画布才查得到托管存储。
    try { if (!await ctx.mediaVerifier.exists(key, { canvasId: request.sourceCanvasId })) return { ok: false, reason: "media-unavailable" }; } catch { return { ok: false, reason: "media-unavailable" }; }
  }
  return { ok: true, assets: assets as StoredAsset[] };
}
