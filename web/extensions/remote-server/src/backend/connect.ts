/**
 * remote-server 与远端的 Connect 传输层（登录、探测、一元调用、错误短语）。
 *
 * 为什么自己写 Connect 线格式而不是引 `@connectrpc/connect`：宿主只发 HTTP/JSON，不值得为
 * 几个 RPC 拖一整套生成绑定；两端共享的是 `api/gen/es` 的字段语义与 Connect 的 JSON 形状，不是代码。
 *
 * 本模块只做**一次调用**（以及一次「拿凭证换会话」），不持有任何会话状态——会话的唯一归属是
 * `session.ts`，这样存储后端与画布同步上游不会各自缓存出两份登录。
 *
 * 端点约定（与公开的 Connect HTTP/JSON 协议一致）：
 *   POST <base>/woohaa.identity.v1alpha1.IdentityService/Login      body {token}  → {sessionToken, subjectId, expiresAt}
 *   POST <base>/woohaa.identity.v1alpha1.IdentityService/WhoAmI                    → {subjectId, subjectType, expiresAt}
 *   POST <base>/woohaa.identity.v1alpha1.IdentityService/GetAuthMethods            → {methods:[{kind,id,ambient}]}
 *   POST <base>/woohaa.identity.v1alpha1.IdentityService/Logout
 *   POST <base>/woohaa.ops.v1.OpsService/GetServerInfo                             → {version, commit, …}
 */
import { IDENTITY_SERVICE, connectProcedurePath, resolveRemoteEndpoints } from "../shared.js";
import { parseSessionExpiry, type RemoteSession } from "./session.js";

/** 单次远端调用上限：登录与探测都是交互式操作，挂住比失败更糟。 */
export const REQUEST_TIMEOUT_MS = 8_000;

export type RemoteCallResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

/**
 * 发一次 Connect 一元调用。
 *
 * 用 JSON 而不是 protobuf：远端同时接受两者（connect-go 默认），JSON 让本扩展不必为
 * 几个 RPC 生成并携带全套 proto 绑定。错误按 Connect 的 `{code, message}` 形状读，
 * 但对外只暴露稳定短语——远端正文可能含内部细节，不该进浏览器。
 */
export async function callConnect<T>(
  fetchImpl: typeof globalThis.fetch,
  serverUrl: string,
  procedure: string,
  body: unknown,
  options: { token?: string; timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<RemoteCallResult<T>> {
  const { rpcBase } = resolveRemoteEndpoints(serverUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await fetchImpl(`${rpcBase}${procedure}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      status: 0,
      code: timedOut ? "timeout" : "unreachable",
      message: timedOut ? "远端响应超时" : "无法连接远端服务端"
    };
  }

  const text = await response.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    // Connect 的错误体是 `{code, message}`；HTTP 401 即使没有 JSON 体也算未认证。
    const code = readString(parsed, "code") ?? (response.status === 401 ? "unauthenticated" : `http-${response.status}`);
    const normalized = response.status === 401 && code !== "unauthenticated" ? "unauthenticated" : code;
    return { ok: false, status: response.status, code: normalized, message: connectErrorText(normalized) };
  }
  return { ok: true, value: parsed as T };
}

/** 稳定错误短语：不把远端正文透传给浏览器。 */
export function connectErrorText(code: string): string {
  switch (code) {
    case "unauthenticated":
      return "凭证无效或会话已失效";
    case "permission_denied":
      return "该账号没有所需权限";
    case "unavailable":
      return "远端服务暂不可用";
    case "timeout":
      return "远端响应超时";
    case "unreachable":
      return "无法连接远端服务端";
    default:
      return "远端调用失败";
  }
}

/** 换会话失败的原因码：`not-configured` / `no-credential` 是本地状态，其余来自远端。 */
export type RemoteLoginFailureCode =
  | "not-configured"
  | "no-credential"
  | "unauthenticated"
  | "permission_denied"
  | "unavailable"
  | "timeout"
  | "unreachable"
  | string;

export type RemoteLoginResult =
  | { ok: true; session: RemoteSession }
  | { ok: false; code: RemoteLoginFailureCode; message: string };

/** 已登录主体在别名表折算后可能与渠道身份不同，因此拿到会话后立刻 `WhoAmI` 校准。 */
async function finishLogin(
  fetchImpl: typeof globalThis.fetch,
  now: () => number,
  serverUrl: string,
  payload: unknown
): Promise<RemoteLoginResult> {
  const token = readString(payload, "sessionToken");
  const subjectId = readString(payload, "subjectId");
  if (!token || !subjectId) return { ok: false, code: "unauthenticated", message: "远端没有返回会话（响应形状不符）" };

  const expiresAt = parseSessionExpiry(readString(payload, "expiresAt"), now());
  const who = await callConnect<unknown>(
    fetchImpl,
    serverUrl,
    connectProcedurePath(IDENTITY_SERVICE, "WhoAmI"),
    {},
    { token }
  );
  if (!who.ok) return { ok: false, code: who.code, message: who.message };

  return {
    ok: true,
    session: {
      serverUrl,
      token,
      subject: readString(who.value, "subjectId") ?? subjectId,
      displayName: null,
      expiresAt: parseSessionExpiry(readString(who.value, "expiresAt"), expiresAt)
    }
  };
}

export type ExchangeLoginInput = {
  serverUrl: string;
  /** 一次性/部署令牌。 */
  credential?: string;
  /** 网关注入的断言头；存在时优先用它（它代表「当前这个人」）。 */
  gatewayHeaders?: Record<string, string>;
};

/**
 * 用凭证换一份会话（`Login` + `WhoAmI`）。
 *
 * 三种凭证形态走同一条解析路径，我们只负责把**可信的那份**递过去：
 *   1. 网关断言头（用户已在企业网关后面）；
 *   2. 令牌（部署发放的设备凭证，或用户手填的一次性令牌）。
 *
 * 断言不成立时**不立刻失败**：调用方可以回落到令牌再试一次（与远端语义一致）。
 */
export async function exchangeLogin(
  fetchImpl: typeof globalThis.fetch,
  now: () => number,
  input: ExchangeLoginInput
): Promise<RemoteLoginResult> {
  const gatewayHeaders = input.gatewayHeaders ?? {};
  if (Object.keys(gatewayHeaders).length > 0) {
    const viaGateway = await callConnect<unknown>(
      fetchImpl,
      input.serverUrl,
      connectProcedurePath(IDENTITY_SERVICE, "Login"),
      {},
      { headers: gatewayHeaders }
    );
    if (viaGateway.ok) return finishLogin(fetchImpl, now, input.serverUrl, viaGateway.value);
  }

  const credential = typeof input.credential === "string" && input.credential.trim() !== "" ? input.credential.trim() : undefined;
  if (!credential) {
    return {
      ok: false,
      code: "no-credential",
      message: "没有可用身份：本机未经过企业身份网关，也没有配置设备令牌"
    };
  }
  const viaToken = await callConnect<unknown>(
    fetchImpl,
    input.serverUrl,
    connectProcedurePath(IDENTITY_SERVICE, "Login"),
    { token: credential }
  );
  if (!viaToken.ok) return { ok: false, code: viaToken.code, message: viaToken.message };
  return finishLogin(fetchImpl, now, input.serverUrl, viaToken.value);
}

export function readString(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw !== "" ? raw : null;
}
