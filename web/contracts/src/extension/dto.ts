/**
 * 站点插件管理/状态协议 DTO 与 codec
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 1.1 / design D3）。
 *
 * 建议公开协议（语义固定，`basePath` 可在实现时调整）：
 * ```
 * GET  /api/extensions                          公开状态 snapshot（不含秘密）
 * GET  /api/extensions/changes?after=<revision> 有界增量（cursor 过旧时 resyncRequired）
 * PUT  /api/extensions/:extensionId/config         管理员配置写入（需要 expectedRevision）
 * ```
 *
 * 写接口在**副作用之前**要求可信管理员身份；公开请求经 ingress 从 loopback 到达不得自动授权。
 */
import {
  isJsonObject,
  isNonNegativeInteger
} from "../validation.js";
import { isApplicationExtensionConfigValue, isSecretReference } from "./config.js";
import { containsForbiddenExtensionKey } from "./manifest.js";
import type { ApplicationExtensionChangeBatch } from "./state.js";
import type { ApplicationExtensionSnapshot, ApplicationExtensionStatus } from "./state.js";

export const DEFAULT_APPLICATION_EXTENSION_BASE_PATH = "/api/extensions";

/** 管理面单插件配置写入响应（回显新权威状态与 revision）。 */
export type ApplicationExtensionConfigWriteResponse = {
  revision: number;
  status: ApplicationExtensionStatus;
};

type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

/**
 * 解码管理员配置写入请求。
 *
 * 要求完整字段：`expectedRevision`（并发控制）、`enabled`、`values`、`secretRefs`。
 * 拒绝任何代码位置字段（module/url/script/source/entry）——管理数据不得指定入口。
 */
export function decodeApplicationExtensionConfigWrite(
  body: unknown
): DecodeResult<{ expectedRevision: number; enabled: boolean; values: Record<string, unknown>; secretRefs: string[] }> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是 JSON 对象");
  if (containsForbiddenExtensionKey(body)) {
    return fail("malformed-request", "请求不得包含代码位置字段（module/url/script/source/entry）");
  }
  if (!isNonNegativeInteger(body.expectedRevision)) {
    return fail("malformed-request", "expectedRevision 必须是非负整数");
  }
  if (typeof body.enabled !== "boolean") return fail("malformed-request", "enabled 必须是布尔值");
  const values = body.values === undefined ? {} : body.values;
  if (!isApplicationExtensionConfigValue(values)) {
    return fail("config-invalid", "values 必须是受控的非秘密 JSON 对象");
  }
  const secretRefs = body.secretRefs === undefined ? [] : body.secretRefs;
  if (!Array.isArray(secretRefs) || !secretRefs.every((entry) => isSecretReference(entry))) {
    return fail("config-invalid", "secretRefs 必须是 opaque 引用数组");
  }
  return {
    ok: true,
    value: {
      expectedRevision: body.expectedRevision,
      enabled: body.enabled,
      values,
      secretRefs
    }
  };
}

/** `GET /api/extensions/changes?after=` 的游标解析与校验。 */
export function decodeApplicationExtensionChangesQuery(
  raw: Record<string, string | undefined>
): { ok: true; after: number } | { ok: false; code: string; message: string } {
  const value = raw.after;
  if (value === undefined || value === "") return { ok: true, after: 0 };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fail("malformed-request", "after 必须是非负整数");
  }
  return { ok: true, after: parsed };
}

/** snapshot 响应 wrapper（便于后续加入非语义字段而不破坏检测）。 */
export type ApplicationExtensionSnapshotResponse = ApplicationExtensionSnapshot;
export type ApplicationExtensionChangesResponse = ApplicationExtensionChangeBatch;

export type ApplicationExtensionStatusResponse = ApplicationExtensionStatus;
