/**
 * remote-server 的**唯一**会话来源（状态 handler、画布同步上游、服务端存储后端共用一份）。
 *
 * 为什么单独成模块：接入服务端是一个能力，而这份会话有多个消费者——UI 的连接状态、画布同步
 * 上游的 Bearer、以及媒体字节的存储后端。如果每个消费者各自缓存一份登录，会出现「界面显示已连接
 * 但存储读不到」「一处 401 换会话、另一处还拿旧令牌」这类互相打架的状态。所以：
 *
 * - **只有这里**读写会话（持久化经注入的 `RemoteSessionStore`，缺省进程内存）；
 * - 到期（提前 30s）或换了远端地址，一律视为未登录——不拿死令牌去连远端；
 * - `ensure()` 是唯一允许「自己换会话」的入口：有部署凭证（deviceToken）时用它换一份，
 *   并发调用共享同一次登录（冷启动时三个 RPC 不该换三份会话）。
 *
 * 令牌是 Bearer 凭据：不进日志、不进错误信息、不进任何响应体。
 */

/** 已登录会话（只在本机宿主内存在；绝不进入任何响应体）。 */
export type RemoteSession = {
  serverUrl: string;
  token: string;
  subject: string;
  displayName: string | null;
  expiresAt: number;
};

/**
 * 会话持久化端口。
 *
 * 生产实现是 owner-scoped 的扩展文档存储（跨重启保留），缺省退化为进程内存——
 * 不伪造一个「看起来持久」的载体。
 */
export type RemoteSessionStore = {
  load(): Promise<RemoteSession | null>;
  save(session: RemoteSession | null): Promise<void>;
};

/** 会话提前失效余量：避免刚好在到期瞬间拿一个已死令牌发请求。 */
export const SESSION_EXPIRY_SKEW_MS = 30_000;

/** 响应没给可用到期时刻时的兜底（不把「未知」当成永不过期）。 */
const SESSION_FALLBACK_TTL_MS = 60 * 60 * 1000;

/** 内存实现：缺省与测试用；进程退出即失效。 */
export function createMemorySessionStore(): RemoteSessionStore {
  let current: RemoteSession | null = null;
  return {
    async load() {
      return current;
    },
    async save(session) {
      current = session;
    }
  };
}

/** 会话是否仍然可用（到期即视为未登录，不拿死令牌去连中继）。 */
export function isSessionUsable(session: RemoteSession | null, now: number): session is RemoteSession {
  return session !== null && session.token !== "" && session.expiresAt - SESSION_EXPIRY_SKEW_MS > now;
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

/**
 * 会话到期时刻：身份服务给 RFC3339；解析失败时用兜底 TTL，而不是当成永不过期。
 *
 * 三种形态都要容错：RFC3339 字符串、Unix 秒（int64 的 ProtoJSON 字符串形态）、Unix 毫秒。
 * 小于 1e12 的整数一律按秒解释——毫秒时间戳在 2001 年就超过这个量级，不会误判。
 */
export function parseSessionExpiry(value: unknown, nowMs: number): number {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const asInt = parseProtoJsonInt(value);
  if (asInt !== null && asInt > 0) {
    return asInt < 1e12 ? asInt * 1000 : asInt;
  }
  return nowMs + SESSION_FALLBACK_TTL_MS;
}

export type RemoteSessionSourceOptions = {
  store: RemoteSessionStore;
  /** 当前配置的远端基址；未配置返回 null（= 纯本地，不是错误）。 */
  configuredServerUrl: () => string | null;
  now: () => number;
  /**
   * 用部署凭证换会话。
   *
   * 只有 `ensure()` 会用：交互式登录（网关断言 / 设备码 / 手填令牌）走各自的 handler，
   * 那条路明确代表「人做的决定」，不该被自动换会话悄悄替代。
   *
   * 返回**失败码**而不是 null：调用方（存储后端）要把「没凭证」与「网络不可达」区分开，
   * 两者的可行动建议完全不同；把原因压成 null 只能给出一个万能的「认证失败」。
   */
  loginWithDeviceToken?: (serverUrl: string) => Promise<EnsureSessionResult>;
  /**
   * 会话落库后（登录成功 / 登出 / 401 作废 / `ensure()` 自动换会话）通知宿主。
   *
   * 画布同步上游由宿主按 capability 解析，而宿主不轮询扩展会话；所以会话一变化必须推一次，
   * 否则画布会继续连旧上游（或停留在纯本地），界面却已经显示「已连接」。
   */
  onSessionChanged?: () => void;
};

/** `ensure()` 的结果：成功拿到会话，或一个稳定的失败码（见 `connectErrorText` / 存储侧短语）。 */
export type EnsureSessionResult =
  | { readonly ok: true; readonly session: RemoteSession }
  | { readonly ok: false; readonly code: string };

/** `unconfigured`：既没有会话，也没有可用于自动换会话的地址/凭证。 */
export const SESSION_UNCONFIGURED_CODE = "unconfigured";

export type RemoteSessionSource = {
  /** 只读当前会话：不触发任何登录，过期/换地址都收敛成「没有会话」。 */
  current: () => Promise<RemoteSession | null>;
  /**
   * 取一个可用会话；没有且配置了部署凭证时自动换一份。
   *
   * 并发共享同一次登录：存储后端冷启动时三个 RPC 会同时要求会话，换三份既浪费也会让
   * 服务端看到三倍登录。失败时给出码而不是 null——「没配置」和「连不上」要能分开说。
   */
  ensure: () => Promise<EnsureSessionResult>;
  /** 写入（或清除）会话；交互式登录成功后由 handler 调用。 */
  save: (session: RemoteSession | null) => Promise<void>;
  /**
   * 某个令牌被判无效（401）时作废它。
   *
   * 只在「当前存的就是这个令牌」时才清：并发里另一个请求可能已经换到了新会话，
   * 拿旧令牌去清会把新会话一起打掉。
   */
  invalidate: (token: string) => Promise<void>;
};

export function createRemoteSessionSource(options: RemoteSessionSourceOptions): RemoteSessionSource {
  const { store } = options;
  /** 并发请求共享同一次登录。 */
  let loginInFlight: Promise<EnsureSessionResult> | null = null;

  const current = async (): Promise<RemoteSession | null> => {
    const stored = await store.load();
    const serverUrl = options.configuredServerUrl();
    if (!isSessionUsable(stored, options.now())) return null;
    // 换了地址就当作未登录：旧令牌属于另一个部署的会话，拿它连新地址只会得到 401。
    if (serverUrl !== null && stored.serverUrl !== serverUrl) return null;
    return stored;
  };

  const save = async (session: RemoteSession | null): Promise<void> => {
    await store.save(session);
    options.onSessionChanged?.();
  };

  const ensure = async (): Promise<EnsureSessionResult> => {
    const existing = await current();
    if (existing) return { ok: true, session: existing };
    const serverUrl = options.configuredServerUrl();
    if (serverUrl === null || !options.loginWithDeviceToken) {
      return { ok: false, code: SESSION_UNCONFIGURED_CODE };
    }
    if (loginInFlight) return loginInFlight;
    loginInFlight = options
      .loginWithDeviceToken(serverUrl)
      .then(async (result) => {
        if (result.ok) {
          await store.save(result.session);
          options.onSessionChanged?.();
        }
        return result;
      })
      .catch((error: unknown) => ({
        // 换会话抛出的是意外错误（不是远端回的失败码）：按「连不上」处置，别声称凭证有问题。
        ok: false as const,
        code: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable"
      }))
      .finally(() => {
        loginInFlight = null;
      });
    return loginInFlight;
  };

  return {
    current,
    ensure,
    save,
    async invalidate(token) {
      const stored = await store.load();
      if (stored === null || stored.token !== token) return;
      await store.save(null);
      options.onSessionChanged?.();
    }
  };
}
