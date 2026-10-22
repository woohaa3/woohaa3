/**
 * 共享纯计划编译器：稳定 hash 与确定性实体 ID
 * （自 `mcp-service/src/agent-authoring/planner-hash.ts` 提取，
 *  change: 2026-10-13-add-canvas-script-authoring，任务 1.3 / 1.4 / design D3、D6）。
 *
 * 浏览器安全：只用 `globalThis.crypto.subtle` 与 `TextEncoder`，不依赖 Node Buffer。
 */
import type { AgentPlanOperation } from "../../agent-canvas-protocol.js";

/**
 * 确定性实体 ID：同身份 + ref + kind 永远得到同一 ID。
 *
 * 身份由调用方给定（既有 JSON 路径为 canvas + requestId；脚本路径为
 * principal + canvas + requestId），因此相同脚本在相同身份下重放得到同一实体。
 */
export function deriveEntityId(prefix: string, parts: readonly string[]): string {
  return `${prefix}-${hashText(parts.join("\u0000"))}`;
}

/** 稳定短哈希（无外部依赖），用于确定性实体/命令 identity。 */
export function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** 递归按键排序的 JSON 字符串化；数组顺序保留（顺序对计划语义重要）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

/** 十六进制 SHA-256。 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 规范化 plan payload 的稳定哈希（requestId 重用保护；只绑定画布与操作内容）。 */
export async function hashPlanPayload(input: {
  canvasId: string;
  operations: readonly AgentPlanOperation[];
}): Promise<string> {
  return sha256Hex(stableStringify({ canvasId: input.canvasId, operations: input.operations }));
}
