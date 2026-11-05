/**
 * 命令 reducer 的共享类型与稳定拒绝。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。这是无副作用的叶子模块：只声明拒绝码、结果类型与可变工作副本形状，供各命令族模块
 * 复用；不 import 任何命令实现，避免环。
 */
import type { CanvasNodeData, ServerCanvas, StoredAsset, StoredJob, Woohaa3CanvasEdge, Woohaa3CanvasNode } from "../domain/index.js";

export type CanvasCommandRejectionCode =
  | "asset-in-use"
  | "unknown-node"
  | "unknown-edge"
  | "unknown-asset"
  | "unknown-job"
  | "duplicate-node"
  | "duplicate-edge"
  | "duplicate-asset"
  | "duplicate-job"
  | "invalid-parent"
  | "invalid-edge-endpoint"
  | "node-data-orphan"
  | "invalid-connection"
  | "invalid-node-size"
  | "invalid-node-retype"
  | "operation-in-progress"
  /** 节点内容违反自包含 3D/复合资产写入约束。 */
  | "invalid-self-contained-node"
  | "invalid-video-edit-intent"
  | "invalid-model-cameras"
  | "invalid-image-edit"
  | "missing-edge-id"
  /** 已存在骨架的模型不允许通过命令移除骨架。 */
  | "rig-removed"
  | "invalid-command"
  /** `edit.apply` 前置条件不成立（可诊断冲突）；整批拒绝，无部分写入。 */
  | "edit-precondition-failed"
  /** `edit.apply` 内部操作失败或结构非法。 */
  | "edit-operation-invalid"
  /** 删除/恢复涉及排队或进行中任务，或恢复所需资产不可用。 */
  | "edit-active-run"
  | "edit-asset-missing"
  /** 内容命令的 extensionId 未注册，或 kind 不属于该 owner。 */
  | "content-owner-unavailable"
  /** owner 拒绝了命令内容。message 只放稳定码。 */
  | "content-command-rejected"
  /** owner codec 抛错。message 不包含异常文本。 */
  | "content-codec-failed";

export type CanvasCommandRejection = {
  code: CanvasCommandRejectionCode;
  message: string;
};

export type ApplyCanvasCommandsResult =
  | { ok: true; canvas: ServerCanvas; changed: boolean }
  | { ok: false; rejection: CanvasCommandRejection };

/** 可变工作副本；命令逐个作用于它，最后一次性写回规范聚合。 */
export type WorkingState = {
  content?: import("../content-contribution.js").ContentContributionResolver;
  title: string;
  nodes: Woohaa3CanvasNode[];
  edges: Woohaa3CanvasEdge[];
  nodeData: Record<string, CanvasNodeData>;
  assets: StoredAsset[];
  jobs: StoredJob[];
};

export type CommandApplyResult = { ok: true } | { ok: false; rejection: CanvasCommandRejection };

export const OK: CommandApplyResult = { ok: true };

export function reject(
  code: CanvasCommandRejectionCode,
  message: string
): { ok: false; rejection: CanvasCommandRejection } {
  return { ok: false, rejection: { code, message } };
}
