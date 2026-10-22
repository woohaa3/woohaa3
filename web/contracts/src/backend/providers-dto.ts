/**
 * Provider 凭据协议 DTO
 * （change: 2026-10-06-add-runninghub-api-models-and-provider-credentials，任务 2.1 / design D3/D3b/D5；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 3.4：删除 dev-admin 探测常量）。
 *
 * 授权用户在管理面自助填写 Provider apiKey；凭据只存浏览器并推送到后端**进程内存**（不落盘）。
 * 读取方向 MUST NOT 回显明文：只返回「已配置/未配置」；写入忽略 baseURL/endpoint 等地址字段。
 * 路径：`/api/providers`、`/api/providers/:providerId/credentials`（同源 ingress）。
 * 授权由 site-access 具名 action `providers.credentials.write` 决定，无开发管理员 Token。
 */
import { isJsonObject } from "../validation.js";

export const DEFAULT_PROVIDERS_BASE_PATH = "/api/providers";

/** 一个 Provider 的公开凭据状态（不含明文）。 */
export type ProviderCredentialView = {
  providerId: string;
  label: string;
  description?: string;
  /** 只读展示的连接地址（由插件固定）。 */
  fields: Array<{ key: string; label: string; fixedBaseUrl?: string; placeholder?: string }>;
  /** 是否已在后端内存中有该 Provider 的凭据。 */
  configured: boolean;
};

export type ProviderCredentialsSnapshot = {
  providers: ProviderCredentialView[];
};

/** 凭据写入请求：只接受字段值；地址字段被服务端忽略。 */
export type ProviderCredentialsWriteRequest = {
  fields: Record<string, string>;
};

type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** 服务端固定拒绝的地址字段：由插件写死，不接受用户输入。 */
export const FORBIDDEN_CREDENTIAL_FIELDS = [
  "baseURL",
  "baseUrl",
  "apiBaseURL",
  "appBaseURL",
  "endpoint",
  "url"
] as const;

export function decodeProviderCredentialsWrite(body: unknown): DecodeResult<ProviderCredentialsWriteRequest> {
  if (!isJsonObject(body)) return { ok: false, code: "malformed-request", message: "请求体必须是 JSON 对象" };
  if (!isJsonObject(body.fields)) return { ok: false, code: "malformed-request", message: "fields 必须是对象" };
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.fields)) {
    if ((FORBIDDEN_CREDENTIAL_FIELDS as readonly string[]).includes(key)) continue; // 忽略地址字段
    if (typeof value !== "string") return { ok: false, code: "malformed-request", message: `fields.${key} 必须是字符串` };
    const trimmed = value.trim();
    if (trimmed !== "") fields[key] = trimmed;
  }
  return { ok: true, value: { fields } };
}
