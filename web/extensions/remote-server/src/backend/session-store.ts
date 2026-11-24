/**
 * 会话持久化：把远端会话存进宿主注入的 owner-scoped 文档存储。
 *
 * 为什么存这里而不是设置面：
 * - 设置面的 `secret` 值对扩展**不可读**（只有 `secretRefs()` 引用），无法当会话载体；
 * - `services.documents` 按可信 extensionId 隔离、支持原子写，正是「扩展自己的数据」该去的地方；
 * - 存储里只有密文之外的会话令牌——它由宿主进程持有，浏览器从一开始就拿不到。
 *
 * 令牌是 Bearer 凭据：任何日志、诊断、错误信息都不得包含它。
 */
import type { ExtensionDocumentStore, ExtensionDocumentValue } from "@woohaa3/contracts";
import type { RemoteSession, RemoteSessionStore } from "./session.js";

/** 文档键：单条记录即可——本扩展一期只支持一个远端、一个主体。 */
const SESSION_KEY = "session/current";

type PersistedSession = {
  serverUrl: string;
  token: string;
  subject: string;
  displayName: string | null;
  expiresAt: number;
  /**
   * 长期钥匙。两把钥匙的部署才有；旧记录（拆分之前写入的）没有这两项。
   *
   * 存在同一个文档里而不是单开一条：两把钥匙必须一起轮换、一起撤销，分开写会留下
   * "换了 access 但 refresh 还是旧的"这种半新半旧的状态，而那个状态的 refresh 在远端
   * 已经作废了。
   */
  refreshToken?: string;
  refreshExpiresAt?: number;
};

function isPersistedSession(value: unknown): value is PersistedSession {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const base =
    typeof record.serverUrl === "string" &&
    typeof record.token === "string" &&
    record.token !== "" &&
    typeof record.subject === "string" &&
    (record.displayName === null || typeof record.displayName === "string") &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt);
  if (!base) return false;
  // 两把钥匙的两项是**可选**的（旧记录没有），但给了就必须是合法值：一份 refresh 令牌
  // 配一个 NaN 到期时刻，会让"能不能自己救回来"这个判断永远出错。
  if (record.refreshToken !== undefined && typeof record.refreshToken !== "string") return false;
  if (
    record.refreshExpiresAt !== undefined &&
    (typeof record.refreshExpiresAt !== "number" || !Number.isFinite(record.refreshExpiresAt))
  ) {
    return false;
  }
  return true;
}

/**
 * 用宿主文档存储实现会话持久化。
 *
 * 读失败（存储不可用、数据形状不符）一律当作「没有会话」：这是安全方向——宁可让人重登，
 * 也不拿一份读不懂的记录去连远端。写失败必须抛出：那是真的没存下来，不能假装登录成功。
 */
export function createDocumentSessionStore(store: ExtensionDocumentStore): RemoteSessionStore {
  return {
    async load(): Promise<RemoteSession | null> {
      const record = await store.get(SESSION_KEY);
      if (!record.found) return null;
      const value = record.document.value;
      if (!isPersistedSession(value)) return null;
      return {
        serverUrl: value.serverUrl,
        token: value.token,
        subject: value.subject,
        displayName: value.displayName,
        expiresAt: value.expiresAt,
        ...(typeof value.refreshToken === "string" && value.refreshToken !== ""
          ? { refreshToken: value.refreshToken, refreshExpiresAt: value.refreshExpiresAt }
          : {})
      };
    },
    async save(session: RemoteSession | null): Promise<void> {
      const value: ExtensionDocumentValue = session === null
        ? null
        : {
            serverUrl: session.serverUrl,
            token: session.token,
            subject: session.subject,
            displayName: session.displayName,
            expiresAt: session.expiresAt,
            ...(typeof session.refreshToken === "string" && session.refreshToken !== ""
              ? { refreshToken: session.refreshToken, refreshExpiresAt: session.refreshExpiresAt }
              : {})
          };
      // `null` 表示删除：登出后不留下令牌，哪怕是一条空的。
      const result = await store.batch([session === null ? { op: "delete", key: SESSION_KEY } : { op: "set", key: SESSION_KEY, value }]);
      if (!result.ok) {
        throw new Error(result.code === "revision-conflict" ? "会话写入冲突" : result.message);
      }
    }
  };
}
