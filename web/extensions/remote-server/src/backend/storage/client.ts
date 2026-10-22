/**
 * 服务端托管存储的远端传输层：带会话的一元调用 + 签名地址访问。
 *
 * **不做自己的登录**：会话由 remote-server 的 `RemoteSessionSource`（`../session.js`）统一持有，
 * 与连接状态、画布同步上游共用一份。这里只在「令牌被判无效」时通知它作废并重取一次，
 * 而不是再维护一个自己的登录缓存——两套缓存必然出现「界面已登录、存储 401」的分裂。
 *
 * 三条硬约束：
 * 1. 会话令牌只在**本机宿主进程内**存在：不进日志、不进错误信息、不进任何响应体。
 * 2. 服务端零 CORS，所以所有远端调用都从本机宿主发出；浏览器只拿 `presign` 回的地址。
 * 3. 错误对外只暴露稳定短语：远端正文可能含内部细节，不往上传。
 */
import { SESSION_UNCONFIGURED_CODE, type EnsureSessionResult } from "../session.js";
import type { ServerStorageConfig } from "./config.js";

/** 单次远端调用上限：存储操作是前台交互的一部分，挂住比失败更糟。 */
export const SERVER_STORAGE_REQUEST_TIMEOUT_MS = 8_000;

/** 签名地址传输超时缺省值：只防挂死，不限制大对象的正常传输时间。 */
export const SERVER_STORAGE_TRANSFER_TIMEOUT_MS = 5 * 60_000;

export const STORAGE_SERVICE = "woohaa.storage.v1.StorageService";

/**
 * 客户端需要的会话能力（只取用得到的两个方法）。
 *
 * 刻意收窄成这个形状：存储后端不该能写会话，否则它就能替用户「登录成别人」。
 */
export type ServerStorageSessionSource = {
  /** 取一个可用会话，或一个失败码（`unconfigured` / `unauthenticated` / `unreachable` …）。 */
  ensure(): Promise<EnsureSessionResult>;
  invalidate(token: string): Promise<void>;
};

/**
 * 本机宿主进程的回环 origin：仅在 `serverUrl` 配成站内路径时用于出站解析。
 *
 * 端口与 `web/backend/src/server.ts`、`host/core/model-mcp-url.ts` 是同一套约定（`PORT` /
 * `BACKEND_PORT`，缺省 5180）。插件契约里没有「宿主自己的对外地址」，而远端调用必须由宿主
 * 发出（服务端零 CORS），所以站内路径只能按本进程监听的回环地址出去。这不是新增配置面：
 * 反代部署把挂载前缀写进 `serverUrl`（例如 `/remote`），前缀与端口都随既有配置走。
 */
function defaultHostOrigin(): string {
  const port = String(process.env.PORT ?? process.env.BACKEND_PORT ?? "5180").trim() || "5180";
  return `http://127.0.0.1:${port}`;
}

/**
 * 把调用方的取消信号与单次超时合成一个信号。
 *
 * 两者都必须生效：只留超时会让 `openRead().cancel()` 停不下来（服务端继续传字节），
 * 只留取消信号则半开连接会一直挂着。`AbortSignal.any` 在 Node 20+ 可用（本仓库要求 Node 22）。
 */
function withDeadline(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export type ServerStorageClientOptions = {
  config: ServerStorageConfig;
  /** 共用的会话来源（由 remote-server 提供）。 */
  session: ServerStorageSessionSource;
  /** 出站 fetch（测试注入）。 */
  fetchImpl?: typeof globalThis.fetch;
  /** 单次一元调用超时（测试可缩短）。 */
  timeoutMs?: number;
  /**
   * 签名地址上的传输超时。
   *
   * 比一元调用宽松得多：一次 PUT/GET 可能搬 256 MiB（与服务端 `max_object_bytes` 同档），
   * 8 秒的口径会把正常的大对象传输判成失败；这里只防「连接挂死」，不限制吞吐。
   */
  transferTimeoutMs?: number;
  /**
   * 站内相对基址的出站 origin。
   *
   * 插件契约里没有「宿主自己的对外地址」，而远端调用必须由宿主发出（服务端零 CORS），
   * 因此配成 `/remote` 这类同源路径时按本机回环解析。部署带子路径时把前缀写进 `serverUrl`。
   */
  hostOrigin?: string;
};

/** 稳定的失败短语；**不含**远端正文与任何凭据。 */
export class ServerStorageCallError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ServerStorageCallError";
    this.code = code;
    this.status = status;
  }
}

export type ServerStorageClient = {
  /** 带会话的一元调用（未认证时交给会话来源重取一次）。 */
  call<T>(method: string, body: unknown): Promise<T>;
  /** 访问签名地址：站内路径按宿主的服务端 origin 补全，绝对地址原样使用。 */
  fetchSigned(url: string, init?: RequestInit): Promise<Response>;
};

type CallResult<T> = { ok: true; value: T; status: number } | { ok: false; status: number; code: string; message: string };

/** 稳定错误短语：不把远端正文透传给调用方。 */
export function storageErrorText(code: string): string {
  switch (code) {
    case "unauthenticated":
      return "服务端存储认证失败：设备凭证或会话已失效";
    case "permission_denied":
      return "服务端存储不允许该操作";
    case "not_found":
      return "服务端存储对象不存在";
    case "unavailable":
      return "服务端存储暂不可用";
    case "timeout":
      return "服务端存储响应超时";
    case "unreachable":
      return "无法连接服务端存储";
    default:
      return "服务端存储调用失败";
  }
}

/** 「没有会话可换」的短语：这是配置问题，指引应该是「配置服务端」而不是「换令牌」。 */
export function storageUnconfiguredText(): string {
  return "服务端存储未接入：未配置服务端地址或设备凭证";
}

/** 基址规范化：绝对地址取 origin + pathname；站内路径保持路径形态。 */
export function resolveRpcBase(serverUrl: string): string {
  if (serverUrl.startsWith("/")) return serverUrl;
  const url = new URL(serverUrl);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * 把「可能相对的」签名地址补成可出站访问的绝对地址。
 *
 * 服务端签出的字节地址是相对它自己的挂载根的（设计文档里的 `/storage/objects/<key>`），
 * 因此相对地址按 `serverUrl` 的基址补全——这正好与三个 RPC 走同一个挂载点；反代部署把
 * 前缀写在 `serverUrl` 里时，字节入口也落在同一前缀下。绝对地址（COS 直签）原样保留。
 */
export function resolveOutboundUrl(url: string, serverUrl: string, hostOrigin: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
  const rpcBase = resolveRpcBase(serverUrl);
  const base = serverUrl.startsWith("/") ? `${hostOrigin.replace(/\/+$/, "")}${rpcBase}` : rpcBase;
  const trimmedBase = base.replace(/\/+$/, "");
  return url.startsWith("/") ? `${trimmedBase}${url}` : `${trimmedBase}/${url}`;
}

/**
 * 解析 ProtoJSON 的 64 位整型：既接受字符串（ProtoJSON 规范形态），也接受数字（手写 fake/网关转码）。
 * 不可解析返回 null，由调用方决定兜底——绝不把 NaN 当真值往下传。
 */
export function parseProtoJsonInt(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createServerStorageClient(options: ServerStorageClientOptions): ServerStorageClient {
  const { config, session: sessionSource } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? SERVER_STORAGE_REQUEST_TIMEOUT_MS;
  const transferTimeoutMs = options.transferTimeoutMs ?? SERVER_STORAGE_TRANSFER_TIMEOUT_MS;
  const hostOrigin = options.hostOrigin ?? defaultHostOrigin();
  /**
   * 出站基址**每次现算**：`config` 是活引用，换部署（首次登录补上地址、或改配置）时只改字段，
   * 不重建后端——构造期就算成字符串，会让换地址变成一个静默无效的操作。
   */
  const outboundBaseOf = (): string => {
    const rpcBase = resolveRpcBase(config.serverUrl);
    return config.serverUrl.startsWith("/") ? `${hostOrigin.replace(/\/+$/, "")}${rpcBase}` : rpcBase;
  };

  /** 一次 Connect 调用；`token` 为空时就是「不带会话」（本模块不再自己登录，因此只作兜底）。 */
  const callRaw = async (procedure: string, body: unknown, token?: string): Promise<CallResult<unknown>> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetchImpl(`${outboundBaseOf()}${procedure}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return {
        ok: false,
        status: 0,
        code: timedOut ? "timeout" : "unreachable",
        message: storageErrorText(timedOut ? "timeout" : "unreachable")
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
      return { ok: false, status: response.status, code: normalized, message: storageErrorText(normalized) };
    }
    return { ok: true, value: parsed, status: response.status };
  };

  /**
   * 带会话的一元调用。
   *
   * 没有会话时**不在这里登录**：交给会话来源的 `ensure()`（它用部署凭证换会话，并共享并发登录）。
   * 收到 `unauthenticated` 时先让会话来源作废那个令牌再重试一次——其它错误重试没有意义，
   * 还会把一次故障放大成两次。
   */
  /** 没有会话时按失败码给稳定短语：`unconfigured` 不该被说成「认证失败」（那会引导人去换令牌）。 */
  const requireSession = async (): Promise<string> => {
    const result = await sessionSource.ensure();
    if (result.ok) return result.session.token;
    throw new ServerStorageCallError(
      result.code,
      0,
      result.code === SESSION_UNCONFIGURED_CODE ? storageUnconfiguredText() : storageErrorText(result.code)
    );
  };

  const callWithSession = async <T>(method: string, body: unknown): Promise<T> => {
    const firstToken = await requireSession();
    const firstResult = await callRaw(`/${STORAGE_SERVICE}/${method}`, body, firstToken);
    if (firstResult.ok) return firstResult.value as T;
    if (firstResult.code !== "unauthenticated") {
      throw new ServerStorageCallError(firstResult.code, firstResult.status, firstResult.message);
    }
    await sessionSource.invalidate(firstToken);
    const secondToken = await requireSession();
    const secondResult = await callRaw(`/${STORAGE_SERVICE}/${method}`, body, secondToken);
    if (!secondResult.ok) throw new ServerStorageCallError(secondResult.code, secondResult.status, secondResult.message);
    return secondResult.value as T;
  };

  return {
    call: callWithSession,
    async fetchSigned(url, init) {
      const absolute = resolveOutboundUrl(url, config.serverUrl, hostOrigin);
      return fetchImpl(absolute, {
        ...init,
        // 取消与超时必须同时生效，所以合成信号而不是覆盖调用方给的那个。
        signal: withDeadline(init?.signal, transferTimeoutMs)
      });
    }
  };
}

function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return null;
  return (value as Record<string, unknown>)[key] ?? null;
}

function readString(value: unknown, key: string): string | null {
  const raw = readField(value, key);
  return typeof raw === "string" && raw !== "" ? raw : null;
}
