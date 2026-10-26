/**
 * 生成 Provider 插件的宿主侧公共能力。
 *
 * 抽出来的东西都是**与具体厂商无关**的那部分：注入给 provider 的出网守卫（含对外部 URL 的
 * SSRF 校验）、设置页「可用模型」刷新路由（含站点管理员鉴权）。插件只保留自己的协议差异
 * （模型目录发现、请求/响应映射、配置字段），不再各自复制一份守卫与鉴权。
 *
 * 这些能力原先在 5 个 provider 扩展里各有一份拷贝（`guarded-fetch.ts` 145–183 行 ×5、
 * `authorizeRefresh` 逐字节相同的 5 份），是"插件看似独立、实际靠复制维持"的典型。
 */
export {
  assertPublicHttpsUrl,
  createGuardedFetch,
  type GuardedFetchOptions
} from "./guarded-fetch.js";
export {
  NetworkDeniedError,
  effectivePort,
  isHostAllowed,
  isLocalHostname,
  isPrivateAddress,
  isPrivateHost,
  isPrivateIpv4,
  isPrivateIpv6,
  isUrlAllowed,
  parseHostRule,
  parseHostRules,
  type HostRule
} from "./network-policy.js";
export {
  DEFAULT_MODEL_REFRESH_ROUTE_ORDER,
  registerModelRefreshRoute,
  type ModelRefreshResult
} from "./model-refresh.js";
export { createProviderLifecycleFetch } from "./lifecycle-fetch.js";
