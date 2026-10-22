/**
 * RunningHub 模板指纹守卫（change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 4.3 / design D5）。
 *
 * 在 App 模板响应交给 SDK 之前比对管理员确认过的指纹；不一致时返回 `template-changed`，
 * 禁止用新模板静默解释旧参数。API/App JSON 与媒体下载出口分开；凭据只在查询串中，日志脱敏。
 */
export type FingerprintGuardedFetchOptions = {
  fetchImpl?: typeof fetch;
  /** webappId -> 已确认指纹。 */
  fingerprints?: Readonly<Record<string, string>>;
  timeoutMs?: number;
};

export class TemplateChangedError extends Error {
  readonly code = "template-changed";
  readonly webappId: string;
  readonly actual: string;
  constructor(webappId: string, actual: string) {
    super(`RunningHub App 模板已变化（webappId=${webappId}）`);
    this.name = "TemplateChangedError";
    this.webappId = webappId;
    this.actual = actual;
  }
}

/** App 模板端点路径（`/api/webapp/apiCallDemo?webappId=...`）。 */
const APP_TEMPLATE_PATH = "/api/webapp/apiCallDemo";

/** 稳定指纹：对模板 JSON 做规范化 + 轻量 hash（无副作用、与字段顺序无关）。 */
export function fingerprintTemplate(value: unknown): string {
  const canonical = stableStringify(value);
  let h1 = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h1 = Math.imul(h1 ^ canonical.charCodeAt(i), 16777619) >>> 0;
  }
  return h1.toString(16).padStart(8, "0");
}

/**
 * 包装 fetch：拦截 App 模板响应并校验指纹。
 *
 * 只拦截模板端点；其余请求原样透传（媒体下载出口不受影响）。
 */
export function createFingerprintGuardedFetch(options: FingerprintGuardedFetchOptions = {}): typeof fetch {
  const base = options.fetchImpl ?? globalThis.fetch;
  const fingerprints = options.fingerprints ?? {};

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes(APP_TEMPLATE_PATH)) {
      return base(input as never, init);
    }
    const u = new URL(url);
    const webappId = u.searchParams.get("webappId") ?? "";
    const expected = fingerprints[webappId];
    // 未配置指纹：不可静默解释——要求先导入确认。
    if (!expected) {
      throw new TemplateChangedError(webappId, "<unconfirmed>");
    }
    const response = await base(input as never, init);
    const clone = response.clone();
    let body: unknown;
    try {
      body = await clone.json();
    } catch {
      return response;
    }
    const actual = fingerprintTemplate(body);
    if (actual !== expected) {
      throw new TemplateChangedError(webappId, actual);
    }
    return response;
  }) as typeof fetch;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}
