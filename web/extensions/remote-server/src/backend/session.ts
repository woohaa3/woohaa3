/**
 * remote-server 的**唯一**会话来源（状态 handler、画布同步上游、服务端存储后端共用一份）。
 *
 * 为什么单独成模块：接入服务端是一个能力，而这份会话有多个消费者——UI 的连接状态、画布同步
 * 上游的 Bearer、以及媒体字节的存储后端。如果每个消费者各自缓存一份登录，会出现「界面显示已连接
 * 但存储读不到」「一处 401 换会话、另一处还拿旧令牌」这类互相打架的状态。所以：
 *
 * - **只有这里**读写会话（持久化经注入的 `RemoteSessionStore`，缺省进程内存）；
 * - 到期（提前 30s）或换了远端地址，一律视为未登录——不拿死令牌去连远端；
 * - 部署配置里的地址是**权威的**，会话自带的地址是**兜底**的：人已经在那台服务端上登录过，
 *   它的地址就是这条会话的一部分。只看部署配置会让「登录过、但没写 config.local.json」
 *   变成一种说不清的状态（存储后端注册不上，媒体静默回落主存储）；
 * - `ensure()` 是唯一允许「自己换会话」的入口：有部署凭证（deviceToken）时用它换一份，
 *   并发调用共享同一次登录（冷启动时三个 RPC 不该换三份会话）；
 * - `renew()` 是续约的唯一入口：拿**当前这份**会话换下一段（远端轮换），不需要部署凭证，
 *   因此人用设备码/OAuth 登录进来的会话同样能自动续，不必在配置文件里留长期令牌。
 *   明确被拒绝才清会话，网络暂时不可用时保留到到期时刻。
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
   * 用**当前仍有效的会话**换一份新的（远端 `Refresh`：轮换，不是延长）。
   *
   * 与会话源同住的原因和登录一样：令牌只有这里能读写。返回值只带新令牌与到期时刻，
   * 主体沿用旧会话——续期不改变归属，远端也不会在续期时换人。
   *
   * 缺省（宿主没接这个端口）时续期整体缺席：调用方按「没有续期能力」处理，不是失败。
   */
  refreshSession?: (
    serverUrl: string,
    token: string
  ) => Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; code: string }>;
  /**
   * 会话落库后（登录成功 / 登出 / 401 作废 / `ensure()` 自动换会话 / 续期）通知宿主。
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

/**
 * 续期结果。
 *
 * 三态而不是二态：调用方必须能分辨「续上了」「这个人已经不能再用了（明确拒绝）」与
 * 「这次没问到（网络问题）」。后两者的处置完全相反——前者要清会话要求重新登录，后者
 * 必须保住会话到到期时刻，否则一次网络抖动就把人踢下线。
 *
 * `no-session` 是「没什么可续的」：既包括没有可用会话（未登录 / 已到期 / 换了部署），
 * 也包括这条会话源压根没接续期端口。两者的正确处置相同——**不排期、不清会话、不报错**。
 */
export type RenewSessionResult =
  | { ok: true; session: RemoteSession }
  | { ok: false; kind: "rejected"; code: string }
  | { ok: false; kind: "transient"; code: string }
  | { ok: false; kind: "no-session"; code: string };

/**
 * 远端明确表示「这份会话不再有效」的码：只有这些才该清会话。
 *
 * `unavailable` / `timeout` / `unreachable` 与 5xx 都不在内——那些说明**没问到**。
 */
const REJECTED_CODES: ReadonlySet<string> = new Set(["unauthenticated", "permission_denied"]);

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
  /**
   * 把当前会话续到下一段（远端 `Refresh`，轮换而非延长）。
   *
   * 自动续约的**唯一**入口。与 `ensure()` 的分工：
   *  - `ensure()` 是「我需要一份会话」：没有就（用部署凭证）换一份；
   *  - `renew()` 是「我手里这份快到期了」：只续不换人，**没有**凭证也能用，因为它靠的是
   *    会话本身。这样人类用设备码/OAuth 登录进来的会话同样能自动续，不需要配置文件里
   *    留一份长期令牌——那正是规格禁止的用法。
   *
   * 已经不可用的会话**不会**被拿去续：那个令牌在远端已经死了，续期只会得到一次必然的
   * 401，然后被误当成「被明确拒绝」。此时直接回 `no-session`，交回调用方决定是否重新登录。
   *
   * 并发共享同一次轮换——两个并发的 Refresh 会让先到的那个令牌作废，后到的拿着死令牌
   * 得到 401，把一次正常续期变成一次「被拒绝」。
   */
  renew: () => Promise<RenewSessionResult>;
};

/**
 * 解析这条客户端实际在用的远端地址。
 *
 * **部署配置优先**：有地址就以它为准（人改配置就是要换部署），会话在那种情况下不得越权。
 * 部署配置为空时回落到「已登录会话自带的地址」——那个地址是登录时由人认可、随后随会话一起
 * 持久化的，不是凭空来的。两者都空才是「未配置」（纯本地）。
 *
 * 为什么需要这个回落：地址是**连接哪台服务端**的指针，登录（交互式）与存储后端（无人值守地
 * 读写字节）是同一个指针的两种用法。只认配置文件会让「登录过、但没写 config.local.json」
 * 的部署在下次启动时注册不上服务端存储，媒体静默回落到主存储——同一个客户端，
 * 同步走远端、字节走本地。
 */
export function resolveServerUrl(
  deploymentUrl: string | null,
  session: RemoteSession | null
): string | null {
  return deploymentUrl !== null && deploymentUrl !== "" ? deploymentUrl : session?.serverUrl ?? null;
}

/**
 * 两个地址是否指向同一台服务端（比 origin，不比原文）。
 *
 * 地址在持久化前后可能只差尾斜杠或默认端口（`https://x` 与 `https://x/`）；按原文比较会把
 * 一份完全有效的会话判成「换了部署」而丢掉登录态。站内路径（`/remote`）没有 origin，按原文比。
 */
export function sameServerOrigin(a: string, b: string): boolean {
  if (a === b) return true;
  const originOf = (value: string): string | null => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const left = originOf(a);
  const right = originOf(b);
  return left !== null && left === right;
}

export function createRemoteSessionSource(options: RemoteSessionSourceOptions): RemoteSessionSource {
  const { store } = options;
  /** 并发请求共享同一次登录。 */
  let loginInFlight: Promise<EnsureSessionResult> | null = null;

  const current = async (): Promise<RemoteSession | null> => {
    const stored = await store.load();
    const serverUrl = options.configuredServerUrl();
    if (!isSessionUsable(stored, options.now())) return null;
    // 换了地址就当作未登录：旧令牌属于另一个部署的会话，拿它连新地址只会得到 401。
    // 部署配置优先（人改过配置就是要换部署）；没配地址时会话自带的地址就是它的地址。
    if (serverUrl !== null && !sameServerOrigin(stored.serverUrl, serverUrl)) return null;
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

  /** 并发共享同一次轮换：见 `renew` 的类型注释（并发的 Refresh 会互相作废令牌）。 */
  let renewInFlight: Promise<RenewSessionResult> | null = null;

  const renewOnce = async (): Promise<RenewSessionResult> => {
    // 只用**自己正在用的那条会话**续期：`current()` 已经收敛了到期与换地址两种情况，
    // 拿一份在远端已经死掉或属于别的部署的令牌去续，只会得到一次必然的 401。
    const session = await current();
    if (session === null) return { ok: false, kind: "no-session", code: SESSION_UNCONFIGURED_CODE };
    // 没接续期端口 = 这条会话源没有续期能力，不是「这次没问到」：按 no-session 交回调用方，
    // 免得排出一个永远重试、永远失败的定时器。
    if (!options.refreshSession) return { ok: false, kind: "no-session", code: "unsupported" };
    const result = await options
      .refreshSession(session.serverUrl, session.token)
      .catch((error: unknown) => ({
        // 续期抛出的是意外错误（不是远端回的失败码）：按「没问到」处置，别清人的会话。
        ok: false as const,
        code: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable"
      }));
    if (!result.ok) {
      if (!REJECTED_CODES.has(result.code)) return { ok: false, kind: "transient", code: result.code };
      // 明确被拒绝：这份会话已经不能再用了，继续留着只会让每条 RPC 各撞一次 401。
      await store.save(null);
      options.onSessionChanged?.();
      return { ok: false, kind: "rejected", code: result.code };
    }
    const next: RemoteSession = {
      // 地址与主体沿用旧会话：续期不改变「接哪台、以谁的身份」，远端也不会在续期时换人。
      serverUrl: session.serverUrl,
      token: result.token,
      subject: session.subject,
      displayName: session.displayName,
      expiresAt: result.expiresAt
    };
    // 落库前再确认一次「续的还是当前这份会话」：续期是一次网络往返，期间人可能已经登出
    // （`save(null)`）或换了个账号（另一个令牌）。无条件写回会把会话复活——用户点了登出，
    // 几百毫秒后又变成已连接，而且新令牌在远端是有效的。
    const latest = await store.load();
    if (latest === null || latest.token !== session.token) {
      return { ok: false, kind: "no-session", code: "session-changed" };
    }
    await store.save(next);
    options.onSessionChanged?.();
    return { ok: true, session: next };
  };

  const renew = async (): Promise<RenewSessionResult> => {
    if (renewInFlight) return renewInFlight;
    renewInFlight = renewOnce().finally(() => {
      renewInFlight = null;
    });
    return renewInFlight;
  };

  return {
    current,
    ensure,
    save,
    renew,
    async invalidate(token) {
      const stored = await store.load();
      if (stored === null || stored.token !== token) return;
      await store.save(null);
      options.onSessionChanged?.();
    }
  };
}
