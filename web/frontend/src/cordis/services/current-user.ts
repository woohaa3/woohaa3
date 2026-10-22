import { decodeApplicationSession, type ApplicationSessionSnapshot } from "@woohaa3/contracts";
import type { ApplicationRemote } from "./application-remote.js";
import type { IdentitySubjectService } from "./identity-subject.js";

export type CurrentUserSnapshot = ApplicationSessionSnapshot;
/** 管理资格只来自本次成功 session；数据空间独立于应用身份。 */
export function createCurrentUserService(remote: ApplicationRemote, identity: IdentitySubjectService) {
  let snapshot: CurrentUserSnapshot | null = null;
  let epoch = 0;
  let disposed = false;
  let initialRefresh: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: CurrentUserSnapshot | null) => {
    if (snapshot === next) return;
    snapshot = next;
    identity.setSession(next);
    for (const listener of listeners) listener();
  };
  const service = {
    initialize(): Promise<void> { return initialRefresh ??= service.refresh(); },
    getSnapshot: () => snapshot,
    hasAction: (action: string) => snapshot !== null && (snapshot.accessControl === false || snapshot.allowedActions.some(allowed => allowed === action)),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async refresh() {
      const requestEpoch = ++epoch;
      publish(null);
      let next: CurrentUserSnapshot | null = null;
      try {
        const result = await remote.transport.request({ path: "/api/application/session" });
        next = result.ok ? decodeApplicationSession(result.data) : null;
      } catch { /* 网络失败保持未知，不能推断为无鉴权。 */ }
      if (disposed || requestEpoch !== epoch) return;
      if (next) publish(next);
      else { identity.setSession(null); }
    },
    dispose() { disposed = true; epoch++; publish(null); listeners.clear(); }
  };
  return service;
}

export type CurrentUserService = ReturnType<typeof createCurrentUserService>;
