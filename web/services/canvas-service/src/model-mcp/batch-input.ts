import { createHash } from "node:crypto";
import {
  type ModelBatchFailure,
  type ModelScriptBatchRequest,
} from "@woohaa3/contracts";

export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const failure = (code: string, message: string): ModelBatchFailure => ({
  ok: false,
  code,
  message,
});
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
const id = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 200;

export function decodeModelBatch(
  raw: unknown,
):
  | { ok: true; request: ModelScriptBatchRequest; sources: string[] }
  | ModelBatchFailure {
  if (
    !object(raw) ||
    !fields(raw, [
      "canvasId",
      "requestId",
      "version",
      "commonSource",
      "items",
    ]) ||
    !id(raw.canvasId) ||
    !id(raw.requestId)
  )
    return failure("malformed-request", "批次身份或字段非法");
  if (raw.version !== undefined && raw.version !== "woohaa-model-js-v2")
    return failure("unsupported-version", "仅支持 woohaa-model-js-v2");
  if (raw.commonSource !== undefined && typeof raw.commonSource !== "string")
    return failure("malformed-request", "commonSource 必须是字符串");
  const common = raw.commonSource as string | undefined;
  // change: 2026-10-22-remove-agent-execution-limits，任务 5.3：不再按单项源码长度、
  // 批次模型数量或展开字节总量拒绝；完整批次由实际资源调度并一次原子保存。
  if (!Array.isArray(raw.items) || raw.items.length < 1)
    return failure("malformed-request", "items 必须是非空数组");
  const items: ModelScriptBatchRequest["items"] = [],
    sources: string[] = [],
    seen = new Set<string>();
  for (const [index, item] of raw.items.entries()) {
    if (
      !object(item) ||
      !fields(item, [
        "nodeId",
        "source",
        "expectedModelContentHash",
      ]) ||
      !id(item.nodeId) ||
      typeof item.source !== "string" ||
      !item.source.trim()
    )
      return failure("malformed-request", `items[${index}] 字段非法`);
    if (seen.has(item.nodeId))
      return failure("malformed-request", `重复节点 ${item.nodeId}`);
    seen.add(item.nodeId);
    for (const name of ["expectedModelContentHash"])
      if (item[name] !== undefined && !id(item[name]))
        return failure("malformed-request", `items[${index}].${name} 非法`);
    const source = common ? `${common}\n${item.source}` : item.source;
    sources.push(source);
    items.push({
      nodeId: item.nodeId,
      source: item.source,
      ...(item.expectedModelContentHash !== undefined
        ? { expectedModelContentHash: item.expectedModelContentHash as string }
        : {}),
    });
  }
  return {
    ok: true,
    request: {
      canvasId: raw.canvasId,
      requestId: raw.requestId,
      version: "woohaa-model-js-v2",
      ...(common ? { commonSource: common } : {}),
      items,
    },
    sources,
  };
}
