import { createHash } from "node:crypto";
import {
  decodeModelCameras,
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
        "cameras",
        "expectedCamerasHash",
      ]) ||
      !id(item.nodeId) ||
      typeof item.source !== "string" ||
      !item.source.trim()
    )
      return failure("malformed-request", `items[${index}] 字段非法`);
    if (seen.has(item.nodeId))
      return failure("malformed-request", `重复节点 ${item.nodeId}`);
    seen.add(item.nodeId);
    for (const name of ["expectedModelContentHash", "expectedCamerasHash"])
      if (item[name] !== undefined && !id(item[name]))
        return failure("malformed-request", `items[${index}].${name} 非法`);
    if (item.cameras === undefined && item.expectedCamerasHash !== undefined)
      return failure("malformed-request", "expectedCamerasHash 需要 cameras");
    let cameras;
    if (item.cameras !== undefined) {
      if (!id(item.expectedCamerasHash))
        return failure(
          "malformed-request",
          "替换镜头必须提供 get_model_nodes 返回的 expectedCamerasHash",
        );
      const decoded = decodeModelCameras(item.cameras);
      if (!decoded.ok)
        return failure(
          "malformed-request",
          `items[${index}].cameras: ${decoded.reason}`,
        );
      if (
        !Array.isArray(item.cameras) ||
        item.cameras.some(
          (c) =>
            !object(c) ||
            !fields(c, [
              "id",
              "name",
              "order",
              "azimuth",
              "elevation",
              "distance",
              "aspect",
              "focusOffset",
            ]) ||
            (c.focusOffset !== undefined &&
              (!object(c.focusOffset) ||
                !fields(c.focusOffset, ["x", "y", "z"]))),
        )
      )
        return failure("malformed-request", "镜头包含未知字段");
      cameras = decoded.value;
    }
    const source = common ? `${common}\n${item.source}` : item.source;
    sources.push(source);
    items.push({
      nodeId: item.nodeId,
      source: item.source,
      ...(item.expectedModelContentHash !== undefined
        ? { expectedModelContentHash: item.expectedModelContentHash as string }
        : {}),
      ...(cameras !== undefined
        ? { cameras, expectedCamerasHash: item.expectedCamerasHash as string }
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
