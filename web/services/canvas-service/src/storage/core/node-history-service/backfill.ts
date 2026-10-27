/**
 * 节点生成历史：图片当前输出补登
 * （change: 2026-10-27-merge-same-type-node-history，修复导入/复制图片没有历史版本）。
 *
 * 历史条目原本只在生成/编辑结算/恢复留档时产生；导入、粘贴、画布脚本创建的图片节点只
 * 带当前资产引用，因而没有可合并的 `current` 版本。这里把**已经显示**的图片输出登记为
 * 一条 `image-baseline` 版本：
 * - 只读当前画布，不提交 command，不推进 canvas revision；
 * - 按 `(canvasId,nodeId,image-baseline:<storageKey>)` 幂等；
 * - 不伪造编辑定义；图片编辑版本仍走 `snapshotCurrentImageEdit`。
 */
import {
  NODE_GENERATION_HISTORY_VERSION,
  encodeNodeGenerationIdentity,
  nodeHistoryContentIdentity,
  nodeHistoryEntryId,
  type NodeGenerationHistoryEntry,
  type NodeHistoryMediaPayload,
  type ServerCanvas
} from "@woohaa3/contracts";
import { currentIdentityOf } from "./current-state.js";
import { mediaPayload } from "./registration.js";
import { snapshotCurrentImageEdit, type RestoreDependencies } from "./restore.js";
import { readAssetStorageKey } from "./assets.js";

export type CurrentImageHistoryOutcome =
  | { status: "inserted"; entryId: string }
  | { status: "duplicate"; entryId: string }
  | {
      status: "skipped";
      reason: "not-image" | "no-output" | "missing-asset" | "unresolvable";
    };

/**
 * 确保图片节点当前输出在历史中有一条可恢复版本。
 *
 * 已有匹配的成功条目（无论是生成、编辑还是之前的补登）直接返回 duplicate；当前没有
 * 输出资产时 skipped，不制造空版本。图片编辑节点交给既有 `snapshotCurrentImageEdit`，
 * 保持 base/project/尺寸/shapes 的同一身份算法。
 */
export async function ensureCurrentImageHistory(
  deps: RestoreDependencies,
  canvas: ServerCanvas,
  nodeId: string
): Promise<CurrentImageHistoryOutcome> {
  const node = canvas.document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.type !== "image") return { status: "skipped", reason: "not-image" };
  const data = canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
  if (!data) return { status: "skipped", reason: "no-output" };

  const identity = currentIdentityOf(canvas, nodeId, "image");
  if (identity === null) return { status: "skipped", reason: "no-output" };

  const entries = await deps.context.repository.listForNode(canvas.id, nodeId);
  const existing = entries.find((entry) =>
    entry.kind === "image"
    && entry.payload.kind !== "failure"
    && entry.currentIdentity === identity
  );
  if (existing) return { status: "duplicate", entryId: existing.entryId };

  // 图片编辑/工程版本：沿用编辑留档逻辑，不把它降级成纯媒体版本。
  if (data.imageEdit !== undefined && data.imageEdit !== null) {
    try {
      await snapshotCurrentImageEdit(deps, canvas.id, nodeId, canvas, data);
    } catch {
      return { status: "skipped", reason: "unresolvable" };
    }
    const after = await deps.context.repository.listForNode(canvas.id, nodeId);
    const inserted = after.find((entry) =>
      entry.kind === "image"
      && entry.payload.kind !== "failure"
      && entry.currentIdentity === identity
    );
    return inserted
      ? { status: "inserted", entryId: inserted.entryId }
      : { status: "skipped", reason: "unresolvable" };
  }

  return snapshotCurrentImageOutput(deps, canvas, nodeId, data);
}

/** 纯媒体图片：把当前 outputAssetId 指向的稳定资产登记为上传原始版本。 */
async function snapshotCurrentImageOutput(
  deps: RestoreDependencies,
  canvas: ServerCanvas,
  nodeId: string,
  data: Record<string, unknown>
): Promise<CurrentImageHistoryOutcome> {
  const outputId = typeof data.outputAssetId === "string" ? data.outputAssetId : "";
  if (!outputId) return { status: "skipped", reason: "no-output" };
  const asset = canvas.assets.find((candidate) => candidate.id === outputId);
  if (!asset) return { status: "skipped", reason: "missing-asset" };
  const storageKey = readAssetStorageKey(asset);
  if (!storageKey) return { status: "skipped", reason: "missing-asset" };

  // 只登记当前确实可解析的媒体；显示的节点正常都能通过，损坏引用不制造假版本。
  if (deps.context.mediaVerifier) {
    try {
      if (!(await deps.context.mediaVerifier.exists(storageKey, { canvasId: canvas.id }))) {
        return { status: "skipped", reason: "unresolvable" };
      }
    } catch {
      return { status: "skipped", reason: "unresolvable" };
    }
  }

  const payload: NodeHistoryMediaPayload = mediaPayload({ mediaKind: "image", asset });
  const identity = { kind: "image-baseline" as const, baseStorageKey: storageKey };
  const entry: NodeGenerationHistoryEntry = {
    version: NODE_GENERATION_HISTORY_VERSION,
    entryId: nodeHistoryEntryId({ canvasId: canvas.id, nodeId, identity }),
    canvasId: canvas.id,
    nodeId,
    kind: "image",
    createdAt: deps.context.now(),
    sourceIdentity: encodeNodeGenerationIdentity(identity),
    currentIdentity: nodeHistoryContentIdentity(payload),
    recoverable: true,
    previewable: true,
    source: { label: asset.source === "uploaded" ? "上传原图" : "已有图片" },
    payload
  };
  const result = await deps.context.repository.insert(entry);
  return { status: result.status, entryId: entry.entryId };
}
