import { isAccessAction, type AccessAction } from "./access.js";

export type ApplicationSessionSnapshot =
  | { accessControl: false; dataScopeId: string }
  | { accessControl: true; dataScopeId: string; subject: string; identityProvider: string; displayName?: string; allowedActions: readonly AccessAction[]; policyVersion: string };

/** 只接受明确的成功读模型；缺字段与旧缓存不能被解释为开放实例。 */
export function decodeApplicationSession(value: unknown): ApplicationSessionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.dataScopeId !== "string" || !data.dataScopeId.trim()) return null;
  if (data.accessControl === false) return { accessControl: false, dataScopeId: data.dataScopeId };
  if (data.accessControl !== true || typeof data.subject !== "string" || !data.subject.trim()
    || typeof data.identityProvider !== "string" || !data.identityProvider.trim()
    || typeof data.policyVersion !== "string" || !Array.isArray(data.allowedActions)
    || !data.allowedActions.every(isAccessAction)) return null;
  return {
    accessControl: true, dataScopeId: data.dataScopeId, subject: data.subject, identityProvider: data.identityProvider,
    ...(typeof data.displayName === "string" ? { displayName: data.displayName } : {}),
    allowedActions: data.allowedActions, policyVersion: data.policyVersion
  };
}
