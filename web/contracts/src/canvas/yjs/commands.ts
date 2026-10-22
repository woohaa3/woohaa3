/**
 * 版本化命令批次（任务 1.5 / design D2）。
 *
 * 与前置 change 的 `CanvasCommandBatch` 的**关键差异**：这里用 `baseRevision` 做**诊断与
 * 命令级前置条件**，而**不做全局 CAS**（design D2）。原因是服务端 room 会在最新 published
 * 状态上串行执行批次：两个客户端修改不同且仍存在的实体可以依次成功，而不是后者收到 409。
 *
 * `protocolVersion` 与 `commandId` 是本 change 新增的 wire 字段。
 */
import { decodeCanvasCommandBatch, type CanvasCommand } from "../commands.js";
import { YJS_SYNC_PROTOCOL_VERSION } from "./format.js";

export type CanvasCommandBatch = {
  /** 同步协议版本（design D4 握手的一部分）。 */
  protocolVersion: number;
  canvasId: string;
  /** 客户端生成的命令 id；用于幂等重放（spec「响应丢失后重试」）。 */
  commandId: string;
  /** 客户端生成时看到的业务 revision；用于诊断与命令前置条件，不做全局 CAS。 */
  baseRevision: number;
  actorId: string;
  commands: CanvasCommand[];
};

export type CanvasCommandBatchDecodeResult =
  | { ok: true; batch: CanvasCommandBatch }
  | { ok: false; reason: string };

/**
 * 解码不受信任的批次输入。
 *
 * 复用前置 change 的 `decodeCanvasCommandBatch` 校验 commands 结构，再补本 change 的
 * `protocolVersion` / `commandId` 字段。刻意不重新实现命令结构校验 —— 两侧必须对
 * 「命令长什么样」有**同一份**判定。
 */
export function decodeYjsCommandBatch(
  input: unknown,
  options: { expectedProtocolVersion?: number } = {}
): CanvasCommandBatchDecodeResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "批次必须是对象" };
  }
  const record = input as Record<string, unknown>;

  const expected = options.expectedProtocolVersion ?? YJS_SYNC_PROTOCOL_VERSION;
  if (record.protocolVersion !== expected) {
    return {
      ok: false,
      reason: `同步协议版本不兼容：客户端 ${String(record.protocolVersion)}，服务端 ${expected}`
    };
  }
  if (typeof record.commandId !== "string" || record.commandId.trim().length === 0) {
    return { ok: false, reason: "commandId 缺失或非法" };
  }

  // 命令结构复用前置 change 的解码器：它已覆盖 canvasId/expectedRevision/operationId/actorId/commands。
  const base = decodeCanvasCommandBatch({
    canvasId: record.canvasId,
    expectedRevision: record.baseRevision,
    operationId: record.commandId,
    actorId: record.actorId,
    commands: record.commands
  });
  if (!base.ok) return { ok: false, reason: base.reason };

  return {
    ok: true,
    batch: {
      protocolVersion: expected,
      canvasId: base.batch.canvasId,
      commandId: base.batch.operationId,
      baseRevision: base.batch.expectedRevision,
      actorId: base.batch.actorId,
      commands: base.batch.commands
    }
  };
}

/**
 * 命令载荷的稳定哈希，用于「相同 commandId + 不同 payload 必须拒绝」（spec）。
 *
 * 用 SHA-256 over 规范化 JSON（键排序），因此客户端字段顺序不同不会误判为不同 payload。
 * 异步实现（Web Crypto），Node 20+ 与浏览器都可用。
 */
export async function computeCommandPayloadHash(
  batch: Pick<CanvasCommandBatch, "canvasId" | "commands">
): Promise<string> {
  const canonical = stableStringify({
    canvasId: batch.canvasId,
    commands: batch.commands
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 递归按键排序的 JSON 字符串化；数组顺序保留（顺序对命令语义重要）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}
