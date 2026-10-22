/**
 * 宿主可信请求认证适配器（通用、异步、无管理员概念）
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.3/3.5 / design D2/D4）。
 *
 * 本模块**只**保留宿主认证接缝本身：`ApplicationRequestAuthenticator` 把一个 `IncomingMessage`
 * 解析为可信 `PrincipalContext`（或 null）。真实身份由 Identity 提供者实现；
 * 宿主不内置任何特定网关算法、shared-secret HMAC、静态管理员 Token、`isAdmin` 或管理员角色判断。
 *
 * 旧实现（`createSharedSecretAuthAdapter`/头断言/roles 头）已按任务 3.5 删除。测试与部署只能注入
 * 显式 fake/真实 provider，绝不回退到“来路头即可信”。
 */
import type { IncomingMessage } from "node:http";
import type { PrincipalContext } from "@woohaa3/contracts";
import { AccessProviderUnavailableError } from "../extensions/provider-registry.js";
import { freezePrincipal } from "../extensions/access-enforcement.js";

/** 由 `IncomingMessage` 建立可信 identity provider 输入所需的原始字段。 */
export type AdapterRequestInput = {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  method?: string;
  url?: string;
  remoteAddress?: string;
};

/**
 * 宿主认证接缝：把一次 HTTP/WS 请求解析为可信 principal。
 *
 * 未认证 MUST 返回 null（不抛错，便于调用方分层）；实现 MUST 只依赖密码学/受控配置，
 * 不能仅凭 loopback、代理地址或转发头判定登录。
 */
export type ApplicationRequestAuthenticator = (req: IncomingMessage, transport?: "http" | "ws" | "mcp") => Promise<PrincipalContext | null>;

export function toAdapterRequestInput(req: IncomingMessage): AdapterRequestInput {
  return {
    headers: req.headers as Record<string, string | string[] | undefined>,
    ...(req.method !== undefined ? { method: req.method } : {}),
    ...(req.url !== undefined ? { url: req.url } : {}),
    ...(req.socket?.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {})
  };
}

/** 由注入的解析函数构造认证器（测试与部署装配共用）。 */
export function createRequestAuthenticatorFromResolver(
  resolve: ApplicationRequestAuthenticator
): ApplicationRequestAuthenticator {
  return resolve;
}

/**
 * 由必需 identity provider 的**惰性解析器**构造统一认证器。
 *
 * 提供者缺失/故障时抛出 `access-provider-unavailable` 稳定错误（由调用方映射 503），绝不下沉为
 * 匿名或放行（change: 2026-10-13-...，任务 1.2/1.5）。
 */
export function createProviderRequestAuthenticator(
  resolveProvider: () => import("@woohaa3/contracts").IdentityProvider
): ApplicationRequestAuthenticator {
  return async (req, transport = "http") => {
    try {
    const provider = resolveProvider();
    if (provider.ready && !provider.ready()) throw new AccessProviderUnavailableError("身份提供者未就绪");
    const input = toAdapterRequestInput(req);
    const result = await provider.authenticate({
      transport,
      headers: input.headers,
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.remoteAddress !== undefined ? { remoteAddress: input.remoteAddress } : {})
    });
    return result.ok ? freezePrincipal(result.principal) : null;
    } catch {
      throw new AccessProviderUnavailableError("身份提供者不可用");
    }
  };
}

/** 未配置认证：一律未认证（不抛错）。 */
export function createUnauthenticatedAuthenticator(): ApplicationRequestAuthenticator {
  return async () => null;
}

/**
 * 测试用 fake 认证器：由注入的解析函数决定身份（仅测试/显式 dev 注入）。
 *
 * 返回值会经 `freezePrincipal` 冻结；显式伪造的 attributes 不参与 owner/授权。
 */
export function createFakeRequestAuthenticator(
  resolve: (req: IncomingMessage, transport: "http" | "ws" | "mcp") => PrincipalContext | null | Promise<PrincipalContext | null>
): ApplicationRequestAuthenticator {
  return async (req, transport = "http") => {
    const result = await resolve(req, transport);
    return result ? freezePrincipal(result) : null;
  };
}

/** 构造一个用于测试/显式 dev 的冻结 principal。 */
export function testPrincipal(subject: string, overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return freezePrincipal({
    subject,
    identityProvider: overrides.identityProvider ?? "test",
    ...(overrides.displayName !== undefined ? { displayName: overrides.displayName } : {}),
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.validUntil !== undefined ? { validUntil: overrides.validUntil } : {}),
    ...(overrides.attributes !== undefined ? { attributes: overrides.attributes } : {})
  });
}
