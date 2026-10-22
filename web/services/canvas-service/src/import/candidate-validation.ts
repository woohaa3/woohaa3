/**
 * 导入候选验证（当前格式 + 无损 + 媒体 + Yjs round-trip）
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.4、4.7 / design D8、D9）。
 *
 * Canvas 权威在提交前**独立**复核来源扩展给出的候选：
 * 1. 当前 `parseCanvasAggregate` / `normalizeCanvas` 通过，且相对候选无计划外丢失；
 * 2. revision 归一为 1（目标首版）、无旧 activeRunId、无旧 providerTaskId 轮询；
 * 3. 所有资产 metadata 完整且经 Media 真实核验（exists + stat 匹配）；
 * 4. `serverCanvasToYDoc` → `yDocToServerCanvas` round-trip 后受保护字段一致。
 */
import {
  isJsonObject,
  parseCanvasAggregate,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import { serverCanvasToYDoc, yDocToServerCanvas } from "@woohaa3/contracts/canvas-yjs";
import type { MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import type { CanvasImportErrorCode } from "./contracts.js";

export type CandidateValidationResult =
  | { ok: true; canvas: ServerCanvas }
  | { ok: false; code: CanvasImportErrorCode; retryable: boolean; message: string };

export async function validateImportCandidate(input: {
  candidate: ServerCanvas;
  mediaStorage: MediaStorage;
  now: string;
}): Promise<CandidateValidationResult> {
  const parsed = parseCanvasAggregate(input.candidate, { now: input.now });
  if (!parsed.ok) {
    return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: "候选未通过当前格式校验" };
  }
  const loss = compareNoUnplannedLoss(input.candidate, parsed.canvas);
  if (loss) return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: loss };

  // revision=1、无在途 run/provider 引用（不伪装旧 in-flight 状态）。
  const canvas: ServerCanvas = { ...parsed.canvas, revision: 1 };
  for (const node of canvas.document.nodes) {
    const data = canvas.nodeData[node.id];
    if (!data) continue;
    const record = data as Record<string, unknown>;
    if (record.activeRunId !== undefined) {
      return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: `节点 ${node.id} 携带 activeRunId` };
    }
    if (record.providerTaskId !== undefined) {
      return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: `节点 ${node.id} 携带 providerTaskId` };
    }
  }

  for (const asset of canvas.assets) {
    const invalid = validateAssetMetadata(asset);
    if (invalid) return { ok: false, code: "MEDIA_MISSING", retryable: true, message: invalid };
    // 候选画布的 id 就是导入目标的画布 id：存在性核验要带作用域（远端托管存储按画布路由）。
    const verified = await verifyMedia(asset, input.mediaStorage, { canvasId: input.candidate.id });
    if (!verified.ok) return verified;
  }

  const roundTrip = roundTripCheck(canvas);
  if (!roundTrip.ok) return roundTrip;

  return { ok: true, canvas };
}

function validateAssetMetadata(asset: StoredAsset): string | null {
  const metadata = asset.metadata;
  if (!isJsonObject(metadata)) return `资产 ${asset.id} 缺少 metadata`;
  const storageKey = metadata.storageKey;
  const checksum = metadata.checksum;
  const contentType = metadata.contentType;
  const size = metadata.size;
  if (typeof storageKey !== "string" || !storageKey) return `资产 ${asset.id} storageKey 缺失`;
  if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) return `资产 ${asset.id} checksum 非法`;
  if (typeof contentType !== "string" || !contentType) return `资产 ${asset.id} contentType 缺失`;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) return `资产 ${asset.id} size 非法`;
  const embedded = embeddedChecksum(storageKey);
  if (!embedded || embedded !== checksum) return `资产 ${asset.id} checksum 与 storageKey 不匹配`;
  return null;
}

async function verifyMedia(
  asset: StoredAsset,
  mediaStorage: MediaStorage,
  scope?: MediaStorageScope
): Promise<{ ok: true } | { ok: false; code: "MEDIA_MISSING"; retryable: boolean; message: string }> {
  const metadata = asset.metadata as Record<string, unknown>;
  const storageKey = String(metadata.storageKey);
  try {
    const exists = await mediaStorage.exists(storageKey, scope);
    if (!exists) return { ok: false, code: "MEDIA_MISSING", retryable: true, message: `资产 ${asset.id} 媒体对象不存在` };
    if (mediaStorage.stat) {
      const stat = await mediaStorage.stat(storageKey, scope);
      if (stat.size !== Number(metadata.size)) {
        return { ok: false, code: "MEDIA_MISSING", retryable: false, message: `资产 ${asset.id} size 与核验不一致` };
      }
      if (stat.contentType && stat.contentType !== String(metadata.contentType)) {
        return { ok: false, code: "MEDIA_MISSING", retryable: false, message: `资产 ${asset.id} contentType 与核验不一致` };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "MEDIA_MISSING", retryable: true, message: `资产 ${asset.id} 媒体核验不可用` };
  }
}

/** round-trip：Yjs 映射后受保护字段（节点/边/资产/当前输出）必须一致。 */
export function roundTripCheck(canvas: ServerCanvas): { ok: true } | { ok: false; code: "CANDIDATE_INVALID"; retryable: false; message: string } {
  let exported: ServerCanvas;
  try {
    const doc = serverCanvasToYDoc(canvas);
    const result = yDocToServerCanvas(doc);
    doc.destroy();
    if (!result.ok) {
      return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: "候选无法从 Yjs 文档导出" };
    }
    exported = result.canvas;
  } catch {
    return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: "候选无法写入 Yjs 文档" };
  }
  if (exported.document.nodes.length !== canvas.document.nodes.length) {
    return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: "Yjs round-trip 节点数变化" };
  }
  if (exported.document.edges.length !== canvas.document.edges.length) {
    return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: "Yjs round-trip 边数变化" };
  }
  if (exported.assets.length !== canvas.assets.length) {
    return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: "Yjs round-trip 资产数变化" };
  }
  for (const node of canvas.document.nodes) {
    if (!exported.document.nodes.some((entry) => entry.id === node.id && entry.type === node.type)) {
      return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: `Yjs round-trip 丢失节点 ${node.id}` };
    }
    const planned = canvas.nodeData[node.id];
    const actual = exported.nodeData[node.id];
    const plannedPrompt = planned?.panelPrompt ?? planned?.prompt;
    const actualPrompt = actual?.panelPrompt ?? actual?.prompt;
    if (JSON.stringify(plannedPrompt) !== JSON.stringify(actualPrompt)) {
      return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: `Yjs round-trip 丢失节点 ${node.id} 提示词` };
    }
    if (JSON.stringify(planned?.outputAssetId) !== JSON.stringify(actual?.outputAssetId)) {
      return { ok: false, code: "CANDIDATE_INVALID", retryable: false, message: `Yjs round-trip 丢失节点 ${node.id} 当前输出` };
    }
  }
  return { ok: true };
}

function compareNoUnplannedLoss(input: ServerCanvas, normalized: ServerCanvas): string | null {
  const inputNodeIds = input.document.nodes.map((node) => node.id).sort();
  const normalizedNodeIds = normalized.document.nodes.map((node) => node.id).sort();
  if (inputNodeIds.length !== normalizedNodeIds.length || inputNodeIds.some((id, index) => id !== normalizedNodeIds[index])) {
    return "规范化后节点集合发生变化";
  }
  for (const node of input.document.nodes) {
    const match = normalized.document.nodes.find((entry) => entry.id === node.id);
    if (!match || match.type !== node.type) return `节点 ${node.id} 类型被规范化改写`;
  }
  const inputEdgeIds = input.document.edges.map((edge) => edge.id).sort();
  const normalizedEdgeIds = normalized.document.edges.map((edge) => edge.id).sort();
  if (inputEdgeIds.length !== normalizedEdgeIds.length || inputEdgeIds.some((id, index) => id !== normalizedEdgeIds[index])) {
    return "规范化后边集合发生变化";
  }
  return null;
}

function embeddedChecksum(storageKey: string): string | null {
  const generated = /^generation-outputs\/([0-9a-f]{64})\.[a-z0-9]+$/.exec(storageKey);
  if (generated) return generated[1];
  const hashed = /^sha256-([0-9a-f]{64})$/.exec(storageKey);
  if (hashed) return hashed[1];
  return null;
}
