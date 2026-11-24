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
 *   POST <base>/woohaa.identity.v1alpha1.IdentityService/Refresh    body {sessionToken}（Bearer 同一个令牌）→ {sessionToken, expiresAt}
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
  options: { token?: string; timeoutMs?: number; headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<RemoteCallResult<T>> {
  const { rpcBase } = resolveRemoteEndpoints(serverUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  // 调用方的取消与固定超时同时生效：市场搜索会被 UI 取消，不该被 8s 超时钉住。
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(`${rpcBase}${procedure}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body ?? {}),
      signal
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

  const refreshToken = readString(payload, "refreshToken");
  const refreshExpiresAt = readString(payload, "refreshExpiresAt");
  return {
    ok: true,
    session: {
      serverUrl,
      token,
      subject: readString(who.value, "subjectId") ?? subjectId,
      displayName: null,
      expiresAt: parseSessionExpiry(readString(who.value, "expiresAt"), expiresAt),
      // 两把钥匙：远端给了长期 refresh 就一起存下来，续期从此不再受 access 寿命限制。
      // 没给（单令牌部署）时字段缺席，行为与拆分之前一致。
      ...(refreshToken !== null
        ? { refreshToken, refreshExpiresAt: parseSessionExpiry(refreshExpiresAt, now()) }
        : {})
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

export type RemoteRefreshResult =
  | {
      ok: true;
      token: string;
      expiresAt: number;
      /** 新的 refresh 令牌；单令牌部署没有这一项（也就没有长期续期能力）。 */
      refreshToken?: string;
      refreshExpiresAt?: number;
    }
  | { ok: false; code: string; message: string };

/**
 * 换一对新令牌（`Refresh`）。
 *
 * 两条路，由调用方给出的是哪个字段决定：
 *  - 有 `refreshToken`：用它换。**不要求 access 仍然有效**——这正是它的意义，
 *    宿主睡过了 access 的整个寿命之后仍然能自己回来；
 *  - 没有 `refreshToken`：用 access 换（单令牌部署 / 老会话），要求它仍未过期。
 *
 * 远端语义是**成对轮换**而不是延长：旧的一对在同一次事务里作废，新令牌按完整 TTL 重算。
 * 所以成功后必须把新的两把钥匙都落库，否则下一次调用就是 401。
 *
 * `Authorization` 只在单令牌那条路上带：refresh 这条路的前提是"access 可能已经死了"，
 * 把一个已过期的令牌塞进请求头只会让中间层（反向代理的鉴权规则、访问日志里的 401 计数）
 * 看起来像一次失败，而实际上这次调用是成功的。`Refresh` 是公开过程，不带 Bearer 是正常形态。
 *
 * 这里**不校准** `WhoAmI`：续期不改变主体（远端按旧凭证的主体签发新令牌），多发一次请求
 * 只增加失败面——登录路径调 `WhoAmI` 是因为别名表可能在首次登录时改写归属。
 */
export async function callSessionRefresh(
  fetchImpl: typeof globalThis.fetch,
  now: () => number,
  serverUrl: string,
  token: string,
  refreshToken?: string
): Promise<RemoteRefreshResult> {
  const result = await callConnect<unknown>(
    fetchImpl,
    serverUrl,
    connectProcedurePath(IDENTITY_SERVICE, "Refresh"),
    // proto 字段是 session_token / refresh_token；Connect 的 JSON 编解码用 lowerCamelCase。
    refreshToken !== undefined && refreshToken !== ""
      ? { refreshToken }
      : { sessionToken: token },
    refreshToken !== undefined && refreshToken !== "" ? {} : { token }
  );
  if (!result.ok) return { ok: false, code: result.code, message: result.message };
  const next = readString(result.value, "sessionToken");
  // 形状不符按未认证处理：续期说成功却没给令牌，等于会话已经不能用了，不能假装续上。
  if (!next) return { ok: false, code: "unauthenticated", message: "远端没有返回续期后的会话（响应形状不符）" };
  const nextRefresh = readString(result.value, "refreshToken");
  const refreshExpiresAt = readString(result.value, "refreshExpiresAt");
  return {
    ok: true,
    token: next,
    expiresAt: parseSessionExpiry(readString(result.value, "expiresAt"), now()),
    ...(nextRefresh !== null
      ? { refreshToken: nextRefresh, refreshExpiresAt: parseSessionExpiry(refreshExpiresAt, now()) }
      : {})
  };
}

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
