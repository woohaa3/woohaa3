/**
 * Provider 出网守卫：插件注入给 provider 的唯一 `fetch`。
 *
 * 它必须同时服务两类请求：
 * 1. **provider API 调用**（`baseUrl` 的 origin）——可信端点，原样放行（仍带超时）；
 * 2. **provider 返回的媒体输出下载**（任意 URL）——受控下载：只允许 https、拒绝回环/私网主机、
 *    限制重定向、只接受声明的响应类型、流式字节上限与超时。
 *
 * 第 2 类正是 SSRF 与"超大响应"风险的入口。浏览器提交的 URL 不会走到这里（网关只接受 storageKey）。
 *
 * 各 Provider 的差异收敛成三个选项：`allowedContentTypes`（图片 / 图片+音频）、
 * `prepareDownloadHeaders`（有的 CDN 需要附带凭据）、`maxRedirects`。
 */
export type GuardedFetchOptions = {
  /** provider API 的 base URL；其 origin 被视为可信。 */
  baseUrl: string;
  maxBytes: number;
  timeoutMs: number;
  fetchImpl?: typeof globalThis.fetch;
  /** Dedicated pinned transport for authenticated source API calls; media keeps its existing guard. */
  apiFetchImpl?: typeof globalThis.fetch;
  /** Check the frozen source before each authenticated upstream call. */
  validate?: () => Promise<void>;
  maxRedirects?: number;
  /** 受控下载允许的响应类型前缀；缺省只允许图片（`image/`）。 */
  allowedContentTypes?: readonly string[];
  /**
   * 受控下载的请求头钩子：由插件决定是否给自己的 CDN 附加凭据。
   *
   * 调用方已带的头会先放进 `headers`；钩子原地修改即可。不要在可信 origin 分支调用它——
   * 那条路径的请求头由 provider 自己构造。
   */
  prepareDownloadHeaders?: (url: URL, headers: Headers) => void;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = ["image/"];

export function createGuardedFetch(options: GuardedFetchOptions): typeof globalThis.fetch {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const trustedOrigin = safeOrigin(options.baseUrl);
  const allowedContentTypes = (options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES).map((type) =>
    type.toLowerCase()
  );

  const guarded = async (input: string | URL | { url: string }, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const parsed = safeUrl(url);
    if (!parsed) throw new Error("受控下载：URL 不合法");

    // 第 1 类：provider API 自身（含 multipart 参考图上传）。
    // 走可信 origin 也必须带超时：否则上游挂住会一直占用任务请求。
    if (trustedOrigin !== null && parsed.origin === trustedOrigin) {
      await options.validate?.();
      const response = await (options.apiFetchImpl ?? fetchImpl)(input as string, {
        ...init,
        redirect: "error",
        signal: init?.signal ?? AbortSignal.timeout(options.timeoutMs)
      });
      if (response.status >= 300 && response.status < 400) throw new Error("拒绝认证请求重定向");
      return response;
    }

    return downloadGuarded(parsed, init);
  };

  async function downloadGuarded(parsed: URL, init?: RequestInit): Promise<Response> {
    let current = parsed;
    for (let redirect = 0; redirect <= (options.maxRedirects ?? 2); redirect += 1) {
      assertAllowedHost(current);
      const headers = new Headers(init?.headers);
      for (const name of ["authorization", "proxy-authorization", "x-api-key", "x-goog-api-key", "cookie"]) headers.delete(name);
      options.prepareDownloadHeaders?.(current, headers);
      const response = await fetchImpl(current, {
        ...init,
        headers,
        redirect: "manual",
        signal: init?.signal ?? AbortSignal.timeout(options.timeoutMs)
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("受控下载：重定向缺少 Location");
        const next = safeUrl(new URL(location, current).toString());
        if (!next) throw new Error("受控下载：重定向目标不合法");
        current = next;
        continue;
      }

      if (!response.ok) throw new Error(`受控下载失败：HTTP ${response.status}`);

      const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!allowedContentTypes.some((prefix) => contentType.startsWith(prefix))) {
        throw new Error(`受控下载：拒绝该响应类型（${contentType || "未知类型"}）`);
      }

      const bytes = await readLimited(response, options.maxBytes);
      // 显式拷贝到独立 ArrayBuffer：`Response` 的 BodyInit 不接受共享缓冲视图。
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      return new Response(body, { status: 200, headers: { "content-type": contentType } });
    }
    throw new Error("受控下载：重定向次数过多");
  }

  return guarded as typeof globalThis.fetch;
}

/**
 * 校验一个外部 URL 是否可安全访问：只允许 https、拒绝回环/私网/`.local`。
 *
 * 上传流程等"不走 guarded fetch、但要自己发请求"的地方用它做同一套校验。
 */
export function assertPublicHttpsUrl(value: string): URL {
  const url = safeUrl(value);
  if (!url) throw new Error("受控上传：URL 不合法");
  assertAllowedHost(url);
  return url;
}

/** 拒绝 loopback / 私网 / 链路本地 / `.local`，只允许 https。 */
function assertAllowedHost(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error(`受控下载：只允许 https（收到 ${url.protocol}）`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("受控下载：拒绝本机主机名");
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    throw new Error("受控下载：拒绝私网地址");
  }
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(":")) return false;
  // ::1 回环、fc00::/7 唯一本地、fe80::/10 链路本地。
  return (
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  );
}

/** 流式读取并强制字节上限；超限即中止，而不是读完再判断。 */
async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error(`受控下载：响应超过上限 ${maxBytes} 字节`);
    return new Uint8Array(buffer);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`受控下载：响应超过上限 ${maxBytes} 字节`);
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

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
