/**
 * Canvas Script 提交身份、提交哈希与冻结回执元数据
 * （change: 2026-10-13-add-canvas-script-authoring，任务 3.2 / 3.4 / 3.7 / design D6）。
 *
 * 两个概念分开，避免把「传输元数据」写进幂等身份：
 * - **submissionHash**：`version + 原始 source + expectedRevision` 的 SHA-256。修改源码空白
 *   也视为不同提交。源码只在此内存计算，不入库。
 * - **CanvasScriptSubmissionMeta**：与画布 update 同事务持久化的**源码无关**首次回执元数据。
 *   refs/节点边摘要/实际删除 identity 在首次提交时冻结，重试直接返回，绝不从当前画布重建。
 *
 * 浏览器安全：只用 `TextEncoder` 与 `globalThis.crypto.subtle`。
 */
import type { AgentApplyEdge, AgentApplyEntity } from "../agent-canvas-internal.js";
import type { CanvasScriptVersion } from "./limits.js";

/** 与画布 update 同事务持久化的脚本提交元数据（**不含源码**）。 */
export type CanvasScriptSubmissionMeta = {
  /** 不含源码的提交哈希；相同身份不同哈希必须拒绝。 */
  submissionHash: string;
  /** 脚本版本（`woohaa-canvas-js-v1`）。 */
  version: CanvasScriptVersion;
  /** 提交时能力版本：能力语义变化后旧回执仍可读，但同一身份不再重放为新语义。 */
  apiVersion: number;
  /** plan-local ref → canonical 实体 ID。 */
  refs: Record<string, string>;
  /** 首次受影响节点摘要（冻结；不随用户后续编辑变化）。 */
  nodes: AgentApplyEntity[];
  /** 首次受影响边摘要（冻结）。 */
  edges: AgentApplyEdge[];
  /** 级联删除实际影响的节点 ID（冻结）。 */
  deletedNodeIds: string[];
  /** 级联删除实际影响的边 ID（冻结）。 */
  deletedEdgeIds: string[];
  organization?: import("./organization.js").CanvasOrganization;
};

/**
 * 规范提交哈希。
 *
 * envelope 只含 version / 原始 source / expectedRevision（省略表示无全局条件）；刻意不含
 * requestId、principal（身份已由 command identity 承载）。
 */
export async function canvasScriptSubmissionHash(input: {
  version: CanvasScriptVersion;
  source: string;
  expectedRevision?: number;
}): Promise<string> {
  const envelope = {
    version: input.version,
    source: input.source,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
  };
  return sha256Hex(stableStringify(envelope));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 递归键排序 JSON（数组顺序保留），与既有 planner hash 同语义。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}
