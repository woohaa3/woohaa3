/**
 * Agent Plan 编译器：稳定 hash 与 validation token
 * （自 `planner.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R28）。
 */
import type { AgentPlanOperation } from "@woohaa3/contracts";

/** 确定性实体 ID：同 canvas + command identity + ref + kind 永远得到同一 ID（design D3）。 */
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
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

/** 规范化 plan payload 的稳定哈希（requestId 重用保护；只绑定画布与操作内容）。 */
export async function hashPlanPayload(input: {
  canvasId: string;
  operations: readonly AgentPlanOperation[];
}): Promise<string> {
  const canonical = stableStringify({
    canvasId: input.canvasId,
    operations: input.operations
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// validation token（design D7：绑定 revision/capability version，无状态可校验）
// ---------------------------------------------------------------------------

export const AGENT_CAPABILITY_VERSION = 1 as const;

export type ValidationTokenPayload = {
  canvasId: string;
  basisRevision: number;
  capabilityVersion: number;
  planHash: string;
};

export function createValidationToken(payload: ValidationTokenPayload, expiresAtMs: number): string {
  const encoded = Buffer.from(JSON.stringify({ ...payload, expiresAtMs })).toString("base64url");
  return encoded;
}

export function readValidationToken(token: string): (ValidationTokenPayload & { expiresAtMs: number }) | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed.canvasId !== "string"
      || typeof parsed.basisRevision !== "number"
      || typeof parsed.capabilityVersion !== "number"
      || typeof parsed.planHash !== "string"
      || typeof parsed.expiresAtMs !== "number"
    ) {
      return null;
    }
    return {
      canvasId: parsed.canvasId,
      basisRevision: parsed.basisRevision,
      capabilityVersion: parsed.capabilityVersion,
      planHash: parsed.planHash,
      expiresAtMs: parsed.expiresAtMs
    };
  } catch {
    return null;
  }
}
