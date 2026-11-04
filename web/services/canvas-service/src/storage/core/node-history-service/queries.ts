/**
 * 节点生成历史服务：列表与详情查询
 * （自 `node-history-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R02）。
 *
 * 只读；安全列表项派生与 current 判定复用契约层。不写任何状态。
 */
import {
  decodeNodeHistoryCursor,
  NODE_HISTORY_LIMITS,
  toCanvasHistoryListItem,
  toNodeHistoryDetail,
  toNodeHistoryListItem,
  type CanvasGenerationHistoryListPage,
  type NodeGenerationHistoryDetail,
  type NodeGenerationHistoryEntry,
  type NodeGenerationHistoryListPage,
  type NodeGenerationKind,
  type MediaStorageScope,
  type NodeHistoryMediaPayload,
  type ServerCanvas
} from "@woohaa3/contracts";
import { CanvasStorageError } from "../errors.js";
import {
  currentStatesFor,
  currentNodeStateOf, entryKindForNode,
  entryMatchesCurrent,
  fallbackNodeTitle,
  nodeTitleOf,
  type CurrentNodeState
} from "./current-state.js";
import type { NodeHistoryServiceContext } from "./types.js";

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) return NODE_HISTORY_LIMITS.defaultPageSize;
  return Math.min(limit, NODE_HISTORY_LIMITS.maxPageSize);
}

function encodeCursor(createdAt: string, entryId: string): string {
  const bytes = new TextEncoder().encode(`${createdAt}\u0001${entryId}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = globalThis.btoa ? globalThis.btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 画布级列表一次导出（room 缺失或失败时 null）。 */
export async function exportCanvas(context: NodeHistoryServiceContext, canvasId: string): Promise<ServerCanvas | null> {
  const room = await context.resolveRoom(canvasId);
  if (!room) return null;
  const exported = room.exportCanvas();
  return exported.ok ? exported.canvas : null;
}

/** 画布授权的节点级分页列表；调用方已校验画布读权限。 */
export async function listNodeHistory(
  context: NodeHistoryServiceContext,
  readCurrentNodeState: (canvasId: string, nodeId: string) => Promise<CurrentNodeState | null>,
  input: { canvasId: string; nodeId: string; limit?: number; cursor?: string }
): Promise<NodeGenerationHistoryListPage> {
  const limit = clampLimit(input.limit);
  const cursor = decodeNodeHistoryCursor(input.cursor);
  const page = await context.repository.list({
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    limit,
    ...(cursor ? { cursor } : {})
  });
  const current = await readCurrentNodeState(input.canvasId, input.nodeId);
  const previewHref = (entryId: string, suffix: string) =>
    `/api/canvas-node-history/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/${encodeURIComponent(entryId)}/${suffix}`;
  const items = page.items.map((entry) =>
    toNodeHistoryListItem(entry, {
      current: current !== null && entryMatchesCurrent(entry, current),
      previewHref: (suffix) => previewHref(entry.entryId, suffix)
    })
  );
  return {
    items,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor.createdAt, page.nextCursor.entryId) : null,
    total: page.total
  };
}

/** 归属校验后的完整详情。 */
export async function getNodeHistoryDetail(
  context: NodeHistoryServiceContext,
  refreshRecoverability: (entry: NodeGenerationHistoryEntry) => Promise<void>,
  input: { canvasId: string; nodeId: string; entryId: string }
): Promise<NodeGenerationHistoryDetail> {
  const entry = await context.repository.get(input.canvasId, input.nodeId, input.entryId);
  if (!entry) throw new CanvasStorageError("NODE_HISTORY_NOT_FOUND", "历史条目不存在");
  await refreshRecoverability(entry);
  return toNodeHistoryDetail(entry);
}

/** 读取条目（预览端点用），返回完整 payload。 */
export async function getNodeHistoryEntry(
  context: NodeHistoryServiceContext,
  input: { canvasId: string; nodeId: string; entryId: string }
): Promise<NodeGenerationHistoryEntry> {
  const entry = await context.repository.get(input.canvasId, input.nodeId, input.entryId);
  if (!entry) throw new CanvasStorageError("NODE_HISTORY_NOT_FOUND", "历史条目不存在");
  return entry;
}

/**
 * 画布级分页列表（change: add-canvas-generation-history-dialog）。
 */
export async function listCanvasHistory(
  context: NodeHistoryServiceContext,
  input: { canvasId: string; limit?: number; kind?: NodeGenerationKind; cursor?: string; summary?: boolean; summaryNodeId?: string }
): Promise<CanvasGenerationHistoryListPage> {
  const limit = clampLimit(input.limit);
  const cursor = decodeNodeHistoryCursor(input.cursor);
  const canvas = await exportCanvas(context, input.canvasId);
  const currentIdentities: Record<string, string> = {};
  if (input.summary && canvas) for (const node of canvas.document.nodes) {
    const kind = entryKindForNode(canvas, node.id);
    const identity = kind ? currentNodeStateOf(canvas, node.id, kind).identity : null;
    if (identity) currentIdentities[node.id] = identity;
  }
  const [page, kindCounts] = await Promise.all([
    context.repository.listCanvas({
      canvasId: input.canvasId,
      summary: input.summary,
      summaryNodeId: input.summaryNodeId,
      currentIdentities,
      limit,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(cursor ? { cursor } : {})
    }),
    context.repository.canvasKindCounts(input.canvasId)
  ]);
  const currentByNode = currentStatesFor(canvas, page.items);
  const previewHref = (nodeId: string, entryId: string, suffix: string) =>
    `/api/canvas-node-history/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(nodeId)}/${encodeURIComponent(entryId)}/${suffix}`;
  const items = page.items.map((entry) =>
    toCanvasHistoryListItem(entry, {
      current: entryMatchesCurrent(entry, currentByNode.get(entry.nodeId) ?? { identity: null, placement: null }),
      previewHref: (suffix) => previewHref(entry.nodeId, entry.entryId, suffix),
      nodeTitle: nodeTitleOf(canvas, entry.nodeId) ?? fallbackNodeTitle(entry.kind)
    })
  );
  return {
    items,
    nextCursor: page.nextCursor ? encodeCursor(page.nextCursor.createdAt, page.nextCursor.entryId) : null,
    total: page.total,
    kindCounts
  };
}

/** 媒体底层对象是否可解析。未配置 verifier 时视为可解析（结构校验已通过）。 */
export async function isMediaResolvable(
  context: NodeHistoryServiceContext,
  payload: NodeHistoryMediaPayload,
  scope?: MediaStorageScope
): Promise<boolean> {
  const verifier = context.mediaVerifier;
  if (!verifier) return true;
  try {
    if (!(await verifier.exists(payload.storageKey, scope))) return false;
    if (payload.poster && !(await verifier.exists(payload.poster.storageKey, scope))) return false;
    if (payload.base && !(await verifier.exists(payload.base.storageKey, scope))) return false;
    return true;
  } catch {
    return false;
  }
}

/** 单个媒体对象是否存在（无 verifier 时视为可解析）。 */
export async function mediaExists(
  context: NodeHistoryServiceContext,
  storageKey: string,
  scope?: MediaStorageScope
): Promise<boolean> {
  const verifier = context.mediaVerifier;
  if (!verifier) return true;
  try {
    return await verifier.exists(storageKey, scope);
  } catch {
    return false;
  }
}
