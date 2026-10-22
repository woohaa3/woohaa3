import type { PrincipalContext } from "./principal.js";

/** 数据归属只用于存储寻址，不能用于认证或授权。 */
type DataScopeFields = Readonly<{
  id: string;
  /** 会话仓库中的兼容定位键。 */
  ownerId: string;
  /** 加密凭据的兼容定位键，不改变加密 AAD。 */
  credentialOwnerId: string;
}>;
export type InstanceDataScope = DataScopeFields & Readonly<{ kind: "instance" }>;
export type UserDataScope = DataScopeFields & Readonly<{ kind: "user" }>;
export type DataScope = InstanceDataScope | UserDataScope;

/** 启动扫描固定的装配结果，不能由运行期 provider 缺失推断。 */
export type AccessRuntime =
  | Readonly<{ enabled: false; instance: InstanceDataScope }>
  | Readonly<{ enabled: true }>;

export type RequestDataContext =
  | Readonly<{ dataScope: InstanceDataScope; principal?: never }>
  | Readonly<{ dataScope: UserDataScope; principal: PrincipalContext }>;

/** 输入仅接受宿主认证结果；不读取请求 body、header 或 cookie 中的 owner。 */
export function resolveRequestDataContext(runtime: AccessRuntime, principal?: PrincipalContext | null): RequestDataContext {
  if (!runtime.enabled) return Object.freeze({ dataScope: runtime.instance });
  if (!principal || !principal.subject.trim() || !principal.identityProvider.trim()) {
    throw Object.assign(new Error("需要已认证用户"), { code: "unauthenticated" });
  }
  const dataScope: UserDataScope = Object.freeze({
    kind: "user", id: `user:${encodeURIComponent(principal.identityProvider)}:${encodeURIComponent(principal.subject)}`,
    ownerId: principal.subject, credentialOwnerId: `principal:${principal.subject}`
  });
  const frozenPrincipal = Object.freeze({ ...principal, ...(principal.attributes ? { attributes: Object.freeze({ ...principal.attributes }) } : {}) });
  return Object.freeze({ dataScope, principal: frozenPrincipal });
}
