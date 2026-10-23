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
// validation token（design D2：绑定内容/能力/范围身份，不按固定时钟失效）
// ---------------------------------------------------------------------------

export const AGENT_CAPABILITY_VERSION = 1 as const;

/**
 * 计划验证 token 绑定的身份。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 4.3 / design D2：删除纯时间到期
 * （原 120 秒）。token 是**预检证据**而不是权限，因此只绑定计划 hash、画布、basis revision、
 * 能力版本与签发主体；实际提交仍重查当前权限与内容条件。
 */
export type ValidationTokenPayload = {
  canvasId: string;
  basisRevision: number;
  capabilityVersion: number;
  planHash: string;
  /** 签发主体（同一 owner 之外的 token 不可复用）。 */
  subject?: string;
};

export function createValidationToken(payload: ValidationTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function readValidationToken(token: string): ValidationTokenPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      typeof parsed.canvasId !== "string"
      || typeof parsed.basisRevision !== "number"
      || typeof parsed.capabilityVersion !== "number"
      || typeof parsed.planHash !== "string"
      || (parsed.subject !== undefined && typeof parsed.subject !== "string")
    ) {
      return null;
    }
    return {
      canvasId: parsed.canvasId,
      basisRevision: parsed.basisRevision,
      capabilityVersion: parsed.capabilityVersion,
      planHash: parsed.planHash,
      ...(typeof parsed.subject === "string" ? { subject: parsed.subject } : {})
    };
  } catch {
    return null;
  }
}
