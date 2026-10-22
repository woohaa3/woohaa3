/**
 * 最小差异写入（任务 2.2 / design D3）。
 *
 * 一条命令只应更新它涉及的实体：例如 `node.add` 只写 `nodes` + 可选 `edges`/`nodeData`，
 * 不应触碰 `assets`/`jobs`。这既是性能要求，也让「单实体命令只更新预期 shared type」
 * 可被断言（否则每次提交都会因为整体重写而产生巨大 update）。
 *
 * 实现方式：对比两份规范聚合，只对**发生变化的实体**执行 Y.Map set/delete。
 * 复用与 `diffCanvasCommands` 相同的字段级判定思路，但这里作用对象是 Y.Doc。
 */
import * as Y from "yjs";
import type { ServerCanvas } from "../domain/index.js";
import { cloneJson, serverCanvasToYDoc, yjsSharedTypes } from "./mapping.js";

export type YDocDiffStats = {
  meta: boolean;
  nodes: { added: number; updated: number; removed: number };
  edges: { added: number; updated: number; removed: number };
  nodeData: { added: number; updated: number; removed: number };
  assets: { added: number; updated: number; removed: number };
  jobs: { added: number; updated: number; removed: number };
};

function emptyStats(): YDocDiffStats {
  return {
    meta: false,
    nodes: { added: 0, updated: 0, removed: 0 },
    edges: { added: 0, updated: 0, removed: 0 },
    nodeData: { added: 0, updated: 0, removed: 0 },
    assets: { added: 0, updated: 0, removed: 0 },
    jobs: { added: 0, updated: 0, removed: 0 }
  };
}

function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * 把 `next` 相对 `previous` 的差异写入 Y.Doc（**必须在调用方的 Yjs transaction 内**，
 * 以让整批差异产生单个 update）。
 *
 * 只比较持久化字段，忽略 revision/updatedAt（那由命令 transaction 单独写，见 D5）。
 */
export function applyCanvasDiffToYDoc(doc: Y.Doc, previous: ServerCanvas, next: ServerCanvas): YDocDiffStats {
  const shared = yjsSharedTypes(doc);
  const stats = emptyStats();

  // meta：只有 title / documentSchemaVersion 属于「内容」；revision/updatedAt 由调用方显式写。
  if ((previous.title ?? "") !== (next.title ?? "")) {
    shared.meta.set("title", next.title ?? "");
    stats.meta = true;
  }
  if (previous.document.schemaVersion !== next.document.schemaVersion) {
    shared.meta.set("documentSchemaVersion", next.document.schemaVersion);
    stats.meta = true;
  }

  diffMap(
    shared.nodes,
    new Map(previous.document.nodes.map((node) => [node.id, node])),
    new Map(next.document.nodes.map((node) => [node.id, node])),
    stats.nodes,
    (node) => {
      const result: Record<string, unknown> = {
        id: node.id,
        type: node.type,
        position: { x: node.position.x, y: node.position.y }
      };
      if (typeof node.width === "number") result.width = node.width;
      if (typeof node.height === "number") result.height = node.height;
      if (typeof node.parentId === "string") result.parentId = node.parentId;
      if (typeof node.zIndex === "number") result.zIndex = node.zIndex;
      return result;
    }
  );

  diffMap(
    shared.edges,
    new Map(previous.document.edges.map((edge) => [edge.id, edge])),
    new Map(next.document.edges.map((edge) => [edge.id, edge])),
    stats.edges,
    (edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
      data: cloneJson(edge.data)
    })
  );

  diffMap(
    shared.nodeData,
    new Map(Object.entries(previous.nodeData)),
    new Map(Object.entries(next.nodeData)),
    stats.nodeData,
    (data) => cloneJson(data)
  );

  diffMap(
    shared.assets,
    new Map(previous.assets.map((asset) => [asset.id, asset])),
    new Map(next.assets.map((asset) => [asset.id, asset])),
    stats.assets,
    (asset) => cloneJson(asset)
  );

  diffMap(
    shared.jobs,
    new Map(previous.jobs.map((job) => [job.id, job])),
    new Map(next.jobs.map((job) => [job.id, job])),
    stats.jobs,
    (job) => cloneJson(job)
  );

  return stats;
}

type DiffCounters = { added: number; updated: number; removed: number };

function diffMap<T>(
  map: Y.Map<unknown>,
  previous: Map<string, T>,
  next: Map<string, T>,
  counters: DiffCounters,
  serialize: (value: T) => unknown
): void {
  for (const key of previous.keys()) {
    if (!next.has(key)) {
      map.delete(key);
      counters.removed += 1;
    }
  }
  for (const [key, value] of next) {
    const before = previous.get(key);
    if (before === undefined) {
      map.set(key, serialize(value));
      counters.added += 1;
      continue;
    }
    if (stable(before) !== stable(value)) {
      map.set(key, serialize(value));
      counters.updated += 1;
    }
  }
}

/** 写 meta.revision / updatedAt（只有服务端命令 transaction 调用）。 */
export function writeRevisionMeta(doc: Y.Doc, revision: number, updatedAt: string): void {
  const shared = yjsSharedTypes(doc);
  shared.meta.set("revision", revision);
  shared.meta.set("updatedAt", updatedAt);
}

/** 写 meta.createdAt（初始 checkpoint 构造时调用一次）。 */
export function writeCreatedAtMeta(doc: Y.Doc, createdAt: string): void {
  yjsSharedTypes(doc).meta.set("createdAt", createdAt);
}

/**
 * 由规范聚合构造初始 checkpoint 字节。
 *
 * 供服务端/运维初始化 Yjs 文档使用，避免调用方为了 `Y.encodeStateAsUpdate` 而直接依赖 `yjs`
 * （依赖边界：只有本包应直接使用 yjs）。
 */
export function encodeInitialCheckpoint(canvas: ServerCanvas): Uint8Array {
  return Y.encodeStateAsUpdate(createInitialYDoc(canvas));
}

/**
 * 由规范聚合构造一个 Y.Doc（供需要继续增量写入的调用方使用，例如恢复演练）。
 *
 * 与 `encodeInitialCheckpoint` 的分工：后者只要字节，这里要可继续写的文档对象。
 */
export function createInitialYDoc(canvas: ServerCanvas): Y.Doc {
  return serverCanvasToYDoc(canvas);
}
