/**
 * 受控下载守卫（change: split-web-runtime-services，任务 3.3 / design D5）。
 *
 * Media Service 的 `import` 从任意 provider 输出 URL 取 bytes，是本服务**唯一**的任意出网
 * 入口，也是 SSRF 与超大响应的风险点。约束（比 provider 侧守卫更严：此处没有可信 origin）：
 * - 只允许 `https:`；
 * - 每次 DNS 解析/重定向后拒绝 loopback、link-local、私网、`.local` 与云元数据地址；
 * - 手动处理重定向，逐跳重新校验；
 * - 流式读取，同时限制 bytes 与 wall-clock。
 */
import { isPrivateAddress } from "./address.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type GuardedDownloadOptions = {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  allowedMediaTypes?: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  /** 注入 DNS 解析（测试 DNS 重绑定）；默认不做额外解析，只校验字面 host。 */
  resolveHost?: (hostname: string) => Promise<string[]>;
};

export type GuardedDownloadResult = {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
};

export class GuardedDownloadError extends Error {
  readonly code: "blocked-host" | "unsupported-protocol" | "too-large" | "timeout" | "not-media" | "http-error" | "redirect";

  constructor(code: GuardedDownloadError["code"], message: string) {
    super(message);
    this.name = "GuardedDownloadError";
    this.code = code;
  }
}

export async function guardedDownload(options: GuardedDownloadOptions): Promise<GuardedDownloadResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const allowed = options.allowedMediaTypes;
  const deadline = Date.now() + options.timeoutMs;
  let current = safeHttpsUrl(options.url);
  if (!current) throw new GuardedDownloadError("unsupported-protocol", "受控下载：只允许 https 地址");

  for (let redirect = 0; redirect <= (options.maxRedirects ?? 2); redirect += 1) {
    await assertAllowedHost(current.hostname, options.resolveHost);

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GuardedDownloadError("timeout", "受控下载：超时");

    const response = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(remaining)
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new GuardedDownloadError("redirect", "受控下载：重定向缺少 Location");
      const next = safeHttpsUrl(new URL(location, current).toString());
      if (!next) throw new GuardedDownloadError("unsupported-protocol", "受控下载：重定向目标不合法");
      current = next;
      continue;
    }

    if (!response.ok) {
      throw new GuardedDownloadError("http-error", `受控下载失败：HTTP ${response.status}`);
    }

    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (allowed && !allowed.includes(contentType)) {
      throw new GuardedDownloadError("not-media", `受控下载：拒绝媒体类型 ${contentType || "未知"}`);
    }

    const bytes = await readLimited(response, options.maxBytes, deadline);
    return { bytes, contentType, finalUrl: current.toString() };
  }
  throw new GuardedDownloadError("redirect", "受控下载：重定向次数过多");
}

/** 校验 host 本身，并用可选的 DNS 解析结果拦截解析到私网的情况（DNS 重绑定）。 */
export async function assertAllowedHost(
  hostname: string,
  resolveHost?: (hostname: string) => Promise<string[]>
): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new GuardedDownloadError("blocked-host", "受控下载：拒绝本机主机名");
  }
  if (isPrivateOrMetadata(host)) {
    throw new GuardedDownloadError("blocked-host", "受控下载：拒绝私网/元数据地址");
  }
  if (resolveHost) {
    const addresses = await resolveHost(host);
    for (const address of addresses) {
      if (isPrivateOrMetadata(address)) {
        throw new GuardedDownloadError("blocked-host", "受控下载：域名解析到私网/元数据地址");
      }
    }
  }
}

function isPrivateOrMetadata(host: string): boolean {
  return isPrivateAddress(host) || isCloudMetadataHost(host);
}

/** 常见云元数据端点。即便解析是公网也冗余拦截字面量。 */
function isCloudMetadataHost(host: string): boolean {
  return host === "169.254.169.254" || host === "metadata.google.internal" || host === "metadata";
}

/** 流式读取并强制 bytes 上限与 wall-clock 上限；超限即中止。 */
async function readLimited(response: Response, maxBytes: number, deadline: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new GuardedDownloadError("too-large", `受控下载：响应超过上限 ${maxBytes} 字节`);
    return new Uint8Array(buffer);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        await reader.cancel();
        throw new GuardedDownloadError("timeout", "受控下载：超时");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GuardedDownloadError("too-large", `受控下载：响应超过上限 ${maxBytes} 字节`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function safeHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
