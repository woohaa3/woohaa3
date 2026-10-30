/**
 * `extension.command` 的宿主侧隔离与影响闭包校验
 * （change: 2026-10-28-generic-extension-content-ownership，任务 2.1）。
 *
 * owner 只拿到冻结的 JSON 快照；返回结果先克隆再校验，避免把 owner 内部引用直接接进
 * WorkingState，也避免它借命令改写其它 owner 的 nodeData 或写出悬空结构引用。
 */
import type { ServerCanvas } from "./domain/index.js";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/** 深克隆并冻结，owner 不能修改命令载荷或宿主工作副本。 */
export function immutableContentSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function ownerOfData(data: unknown): string | null {
  const value = record(data);
  if (!value) return null;
  if (typeof value.extensionId === "string") return value.extensionId;
  const managed = record(value.managedBy);
  return typeof managed?.extensionId === "string" ? managed.extensionId : null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 返回稳定拒绝码；null 表示通过。
 *
 * - nodeData 变化必须属于当前 owner（显式 extensionId / managedBy / 已注册 locator）；
 * - 边、父节点、资产与任务引用不得悬空。
 */
export function contentCommandResultError(
  ownerId: string,
  before: ServerCanvas,
  after: ServerCanvas,
  isLocatedOwner: (type: string, data: unknown) => string | null,
  enforceLocators = true
): string | null {
  const beforeTypes = new Map(before.document.nodes.map((node) => [node.id, node.type]));
  const afterTypes = new Map(after.document.nodes.map((node) => [node.id, node.type]));
  for (const [nodeId, afterData] of Object.entries(after.nodeData)) {
    const beforeData = before.nodeData[nodeId];
    if (same(beforeData, afterData)) continue;
    const afterOwner = ownerOfData(afterData);
    if (afterOwner && afterOwner !== ownerId) return "content-command-cross-owner";
    const beforeOwner = ownerOfData(beforeData);
    if (beforeOwner && beforeOwner !== ownerId) return "content-command-cross-owner";
    const type = afterTypes.get(nodeId) ?? beforeTypes.get(nodeId) ?? "";
    const located = isLocatedOwner(type, afterData) ?? isLocatedOwner(type, beforeData);
    if (enforceLocators && !afterOwner && !beforeOwner && located !== ownerId) return "content-command-unowned-target";
    if (located && located !== ownerId) return "content-command-cross-owner";
  }
  for (const [nodeId, beforeData] of Object.entries(before.nodeData)) {
    if (nodeId in after.nodeData) continue;
    const beforeOwner = ownerOfData(beforeData);
    if (beforeOwner && beforeOwner !== ownerId) return "content-command-cross-owner";
    const type = beforeTypes.get(nodeId) ?? "";
    const located = isLocatedOwner(type, beforeData);
    if (enforceLocators && !beforeOwner && located !== ownerId) return "content-command-unowned-target";
  }
  const nodeIds = new Set(after.document.nodes.map((node) => node.id));
  for (const node of after.document.nodes) {
    if (node.parentId && !nodeIds.has(node.parentId)) return "content-command-dangling-reference";
  }
  for (const edge of after.document.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return "content-command-dangling-reference";
  }
  for (const asset of after.assets) {
    if (asset.nodeId && !nodeIds.has(asset.nodeId)) return "content-command-dangling-reference";
  }
  for (const job of after.jobs) {
    if (job.nodeId && !nodeIds.has(job.nodeId)) return "content-command-dangling-reference";
  }
  return null;
}
