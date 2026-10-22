import { createHash } from "node:crypto";
import {
  decodeModelCameras,
  MODEL_SCRIPT_BATCH_LIMITS as LIMITS,
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
  if ((common?.length ?? 0) > LIMITS.maxSourceChars)
    return failure("limit-exceeded", "commonSource 超过长度上限");
  if (
    !Array.isArray(raw.items) ||
    raw.items.length < 1 ||
    raw.items.length > LIMITS.maxNodes
  )
    return failure("limit-exceeded", `items 数量须在 1..${LIMITS.maxNodes}`);
  const items: ModelScriptBatchRequest["items"] = [],
    sources: string[] = [],
    seen = new Set<string>();
  let expandedBytes = 0;
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
    // Check lengths before concatenation so a tiny request cannot expand without a bound.
    if (
      item.source.length + (common ? common.length + 1 : 0) >
      LIMITS.maxSourceChars
    )
      return failure("limit-exceeded", `items[${index}] 完整脚本过长`);
    const source = common ? common + "\n" + item.source : item.source;
    expandedBytes += Buffer.byteLength(source, "utf8");
    if (expandedBytes > LIMITS.maxExpandedSourceBytes)
      return failure("limit-exceeded", "展开脚本总字节超过上限");
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
