import type { ApplicationSessionSnapshot } from "@woohaa3/contracts";
/**
 * 当前可信身份主体读模型（App scope）
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 2.6/5.8 / design D3）。
 *
 * 由 Identity extension 在解析当前用户后写入；宿主用它给「最近画布 ID」与 IndexedDB
 * 发布缓存做 identity provider + subject 命名空间隔离，账号切换时不会读到上一主体的本地状态。
 *
 * 能力缺失（未装配身份扩展）时保持 `resolved:false`：命名空间返回 null，缓存退化到匿名命名空间，
 * 但**展示**仍受 WS 授权门禁保护（handler 只在服务端握手后发布缓存内容），不会据旧缓存放行。
 */
export type IdentitySubject = { providerId: string; subject: string };

export type IdentitySubjectSnapshot = {
  /** 是否已从身份提供者得到权威结果（未装配身份扩展时保持 false）。 */
  resolved: boolean;
  identity: IdentitySubject | null;
  dataScopeId?: string;
};

export function createIdentitySubjectService() {
  let snapshot: IdentitySubjectSnapshot = { resolved: false, identity: null };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: (): IdentitySubjectSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** 唯一权威 session 更新；无鉴权时只有实例空间，没有身份。 */
    setSession(session: ApplicationSessionSnapshot | null): void {
      const identity = session?.accessControl ? { providerId: session.identityProvider, subject: session.subject } : null;
      const dataScopeId = session?.dataScopeId;
      if (snapshot.resolved && snapshot.dataScopeId === dataScopeId && snapshot.identity?.providerId === identity?.providerId && snapshot.identity?.subject === identity?.subject) return;
      snapshot = { resolved: true, identity, ...(dataScopeId ? { dataScopeId } : {}) };
      notify();
    },
    /**
     * 记录一次身份刷新结果（`null` 表示匿名/未登录）。幂等：相同 identity 不重复广播。
     * 未登录也标记 `resolved:true`，调用方可区分「尚无结果」与「确定匿名」。
     */
    set(identity: IdentitySubject | null): void {
      const sameIdentity =
        snapshot.identity?.providerId === identity?.providerId && snapshot.identity?.subject === identity?.subject;
      if (snapshot.resolved && sameIdentity) return;
      snapshot = { resolved: true, identity };
      notify();
    },
    /**
     * 用户态缓存命名空间（`providerId:subject`）；未解析或匿名时返回 null。
     * 调用方自行决定 null 的处理：本仓库把它退化为匿名命名空间，并用授权门禁兜底展示。
     */
    namespace(): string | null {
      return snapshot.dataScopeId ?? (snapshot.identity ? `${snapshot.identity.providerId}:${snapshot.identity.subject}` : null);
    }
  };
}

export type IdentitySubjectService = ReturnType<typeof createIdentitySubjectService>;
