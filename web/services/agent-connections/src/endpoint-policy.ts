/**
 * 自定义 endpoint 允许策略与凭据安全重定向
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.5 / design D4）。
 *
 * 兼容 API 可填写 base URL，但必须受部署允许范围和协议检查约束。规则：
 * - 只有 `https`（或部署显式允许的 `http` 回环）才通过；
 * - 目标 host 必须命中部署允许列表（精确 host 或 `*.suffix` 通配）；
 * - 带凭据请求**不跨 origin 跟随重定向**：任何跳到别的 origin 的 3xx 都失败，
 *   因此 Key/grant 不会被转发到未允许地址（design D4）。
 *
 * 本模块不读凭据：调用方在通过策略后才附加凭据。
 */

export type EndpointPolicyOptions = {
  /** 允许的 host 列表；支持 `*.example.com` 通配与精确 host。未指定、为空或包含 "*" 时允许所有 host（允许任意中转站）。 */
  allowedHosts?: readonly string[];
  /** 是否允许 `http`（仅回环部署开启；默认 false）。 */
  allowHttp?: boolean;
  /** 最多跟随的重定向跳数（默认 3）。 */
  maxRedirects?: number;
};

export type EndpointCheck = { ok: true; url: URL } | { ok: false; code: "endpoint-not-allowed"; message: string };

function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (normalizedPattern === "") return false;
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1); // ".example.com"
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }
  return normalizedHost === normalizedPattern;
}

export function createEndpointPolicy(options: EndpointPolicyOptions) {
  const maxRedirects = options.maxRedirects ?? 3;
  const allowHttp = options.allowHttp ?? false;

  const check = (raw: string): EndpointCheck => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, code: "endpoint-not-allowed", message: "地址不是合法 URL" };
    }
    if (url.protocol === "https:") {
      // ok
    } else if (url.protocol === "http:") {
      if (!allowHttp) return { ok: false, code: "endpoint-not-allowed", message: "部署不允许明文 http endpoint" };
      const host = url.hostname.toLowerCase();
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
        return { ok: false, code: "endpoint-not-allowed", message: "明文 http 仅允许回环地址" };
      }
    } else {
      return { ok: false, code: "endpoint-not-allowed", message: "仅支持 https endpoint" };
    }
    if (options.allowedHosts && options.allowedHosts.length > 0 && !options.allowedHosts.includes("*")) {
      if (!options.allowedHosts.some((pattern) => hostMatches(url.hostname, pattern))) {
        return { ok: false, code: "endpoint-not-allowed", message: `目标主机不在部署允许列表：${url.hostname}` };
      }
    }
    if (url.username || url.password) {
      return { ok: false, code: "endpoint-not-allowed", message: "endpoint 不得内嵌凭据" };
    }
    return { ok: true, url };
  };

  return { check, maxRedirects, allowedHosts: options.allowedHosts ? [...options.allowedHosts] : undefined };
}

export type EndpointPolicy = ReturnType<typeof createEndpointPolicy>;

export type GuardedFetchResult =
  | { ok: true; response: Response }
  | { ok: false; code: "endpoint-not-allowed" | "transport-unavailable"; message: string };

/**
 * 带凭据的有界请求：先校验 origin，再以 `redirect: "manual"` 逐跳校验。
 *
 * 跨 origin 的 3xx 一律失败（不把 Authorization/x-api-key 交给未允许地址）；同 origin
 * 重定向最多 `maxRedirects` 跳。
 */
export async function guardedFetch(
  url: string,
  init: RequestInit,
  policy: EndpointPolicy,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<GuardedFetchResult> {
  const first = policy.check(url);
  if (!first.ok) return first;
  let current = first.url;
  const origin = current.origin;
  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), { ...init, redirect: "manual" });
    } catch (error) {
      return { ok: false, code: "transport-unavailable", message: error instanceof Error ? error.message : "请求失败" };
    }
    if (response.status < 300 || response.status >= 400) return { ok: true, response };
    const location = response.headers.get("location");
    if (!location) return { ok: true, response };
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return { ok: false, code: "transport-unavailable", message: "重定向地址非法" };
    }
    const allowed = policy.check(next.toString());
    if (!allowed.ok) return { ok: false, code: "endpoint-not-allowed", message: "重定向到未允许地址，已拒绝转发凭据" };
    if (next.origin !== origin) {
      return { ok: false, code: "endpoint-not-allowed", message: "拒绝跨 origin 重定向携带凭据" };
    }
    current = allowed.url;
    if (hop === policy.maxRedirects) return { ok: false, code: "transport-unavailable", message: "重定向次数超出上限" };
  }
  return { ok: false, code: "transport-unavailable", message: "重定向次数超出上限" };
}
