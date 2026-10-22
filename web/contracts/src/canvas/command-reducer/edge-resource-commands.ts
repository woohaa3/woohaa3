/**
 * 命令 reducer 的边与资源类命令（edge.add/remove、asset/job upsert/remove）。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。
 */
import type { CanvasCommand } from "../commands.js";
import {
  createWoohaa3CanvasEdge,
  isValidWoohaa3CanvasConnection,
  type StoredAsset,
  type StoredJob,
  type Woohaa3CanvasJsonObject
} from "../domain/index.js";
import { readFilmSetContent, filmSetAssetReferences } from "../film-set-content.js";
import { isSupportedShotReferenceEdgeData } from "../domain/core/shot-reference.js";
import { OK, reject, type CommandApplyResult, type WorkingState } from "./types.js";
import { validateNoGroupEndpoint } from "./node-commands.js";
import { workingNodeDataReader } from "./working-state.js";

export function addEdge(
  work: WorkingState,
  edge: Extract<CanvasCommand, { type: "edge.add" }>["edge"]
): CommandApplyResult {
  if (!work.nodes.some((node) => node.id === edge.source)) {
    return reject("invalid-edge-endpoint", `边起点 ${edge.source} 不存在`);
  }
  if (!work.nodes.some((node) => node.id === edge.target)) {
    return reject("invalid-edge-endpoint", `边终点 ${edge.target} 不存在`);
  }
  // group 不得作为持久化边端点（change: add-canvas-node-grouping，design D5）：
  // 聚合连接必须由客户端展开为成员的真实边。
  const groupEndpoint = validateNoGroupEndpoint(work, edge.source, edge.target);
  if (groupEndpoint) return groupEndpoint;
  const candidate = {
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null
  };
  if (!isValidWoohaa3CanvasConnection(candidate, work.nodes, work.edges, workingNodeDataReader(work))) {
    return reject(
      "invalid-connection",
      `${edge.source} -> ${edge.target} 不是合法连线（端点相同、重复连线或不满足 handle 规则）`
    );
  }
  const generated = createWoohaa3CanvasEdge(candidate, work.nodes);
  if (!generated) return reject("invalid-connection", `无法为 ${edge.source} -> ${edge.target} 创建边`);
  // 稳定 edgeId 必须由客户端提供（design D7 / spec「创建命令缺少稳定实体 ID」）。
  if (!edge.id) {
    return reject("missing-edge-id", "edge.add 缺少必需的稳定 edgeId");
  }
  const id = edge.id;
  if (work.edges.some((entry) => entry.id === id)) {
    return reject("duplicate-edge", `边 ${id} 已存在`);
  }
  const data: Woohaa3CanvasJsonObject = edge.data
    ? { ...generated.data, ...edge.data }
    : generated.data;
  // 镜头参考边的结构版本门禁（任务 8.1）：拒绝本客户端不理解的更高版本，不猜测、不静默降级。
  if (data.kind === "shot-reference" && !isSupportedShotReferenceEdgeData(data as Record<string, unknown>)) {
    return reject(
      "unsupported-shot-reference",
      `镜头参考结构版本不受支持（${String((edge.data as { schemaVersion?: unknown } | undefined)?.schemaVersion)}）`
    );
  }
  work.edges.push({ ...generated, id, data });
  return OK;
}

export function removeEdge(work: WorkingState, edgeId: string): CommandApplyResult {
  if (!work.edges.some((edge) => edge.id === edgeId)) {
    return reject("unknown-edge", `边 ${edgeId} 不存在`);
  }
  work.edges = work.edges.filter((edge) => edge.id !== edgeId);
  return OK;
}

export function upsertAsset(work: WorkingState, asset: StoredAsset): CommandApplyResult {
  const index = work.assets.findIndex((entry) => entry.id === asset.id);
  if (index >= 0) {
    work.assets[index] = { ...asset };
  } else {
    work.assets.push({ ...asset });
  }
  return OK;
}

export function removeAsset(work: WorkingState, assetId: string): CommandApplyResult {
  if (!work.assets.some((asset) => asset.id === assetId)) {
    return reject("unknown-asset", `资产 ${assetId} 不存在`);
  }
  // 片场内部图片/视频引用参与删除保护（change: 2026-10-08-make-film-set-model-only，任务 1.4）。
  if (Object.values(work.nodeData).some(data => filmSetAssetReferences(readFilmSetContent(data)).includes(assetId))) {
    return reject("asset-in-use", `资产 ${assetId} 正被片场引用`);
  }
  work.assets = work.assets.filter((asset) => asset.id !== assetId);
  return OK;
}

export function upsertJob(work: WorkingState, job: StoredJob): CommandApplyResult {
  const index = work.jobs.findIndex((entry) => entry.id === job.id);
  if (index >= 0) {
    work.jobs[index] = { ...job };
  } else {
    work.jobs.push({ ...job });
  }
  return OK;
}

export function removeJob(work: WorkingState, jobId: string): CommandApplyResult {
  if (!work.jobs.some((job) => job.id === jobId)) {
    return reject("unknown-job", `任务 ${jobId} 不存在`);
  }
  work.jobs = work.jobs.filter((job) => job.id !== jobId);
  return OK;
}
