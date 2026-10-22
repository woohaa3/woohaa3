/**
 * 基础层 · access：企业身份、站点授权与资源策略槽位
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.1–1.5）。
 *
 * 统一接缝：`bootstrapExtensions`（可信槽位实现：storage / identity / access）与 `seedProviders`
 * （测试/受控部署显式注入）装配基础提供者 registry；宿主据此建立**唯一**认证器与
 * action/资源执行边界（`AccessEnforcer`）。插件在 activation 中经 `host.providers` 登记的提供者
 * 也进同一 registry（见 `extensions/host.ts` 的 `registerProviderFor`）。
 *
 * 启动扫描决定访问控制是否启用（`AccessRuntime`）：
 * - 声明了可信身份（mounted identity provider、显式认证器或 seed identity）时启用受控身份与授权；
 * - 没有任何可信身份时视为**本地单实例开发姿态**，不启用访问控制、不要求 action、不探测
 *   `/api/dev-admin`，直接使用实例数据作用域。实例 owner 仍沿用历史本地主体（默认 `dev-admin`），
 *   使已存在的本机 Agent 连接、会话与凭据继续可见；它不是登录用户，也没有站点 action。
 *
 * 旧 `dev-admin` 令牌/身份 provider 已移除，符合 `site-access-policy` 的「旧管理员身份路径完整移除」。
 */
import type {
  AccessRuntime,
  BootstrapExtension,
  InstanceDataScope,
  PrincipalContext
} from "@woohaa3/contracts";
import {
  bootstrapProviders,
  createAccessEnforcer,
  createProviderRegistry,
  createProviderRequestAuthenticator,
  type ApplicationRequestAuthenticator
} from "@woohaa3/application-service";
import type { RuntimeStorageProvider } from "../../extensions/slot-contract.js";
import type { AccessService, ApplicationServiceSeedProviders, FoundationAssembly, HostPlugin } from "../context.js";

export type AccessPluginConfig = {
  env: Record<string, string | undefined>;
  /** 显式注入的可信认证器（测试/受控部署）；缺省由 registry 的 identity provider 支撑。 */
  authenticator?: ApplicationRequestAuthenticator;
  /** 显式注入的基础提供者（测试/受控部署）；不构成隐式放行。 */
  seedProviders?: ApplicationServiceSeedProviders;
  /** 启动期槽位实现（storage / identity / access）；缺省只按 seed 与本地姿态装配。 */
  bootstrapExtensions?: readonly BootstrapExtension<RuntimeStorageProvider>[];
};

export const accessPlugin: HostPlugin<AccessPluginConfig> = {
  name: "access",
  inject: ["gateway"],
  async apply(ctx, { env, authenticator: injectedAuthenticator, seedProviders: injectedSeeds, bootstrapExtensions }) {
    const providers = createProviderRegistry();

    // 启动期槽位实现：storage / identity / access。装配结果同时交给 Application Service，
    // 使插件宿主与控制面消费同一批提供者实例。
    let foundation: FoundationAssembly | null = null;
    let closeFoundation: () => Promise<void> = async () => undefined;
    if (bootstrapExtensions && bootstrapExtensions.length > 0) {
      const runtime = await bootstrapProviders(bootstrapExtensions);
      foundation = { providers: runtime.providers, owners: runtime.owners };
      closeFoundation = runtime.close;
      const identity = runtime.providers.identity;
      if (identity) {
        providers.register({ slot: "identity", extensionId: runtime.owners.identity!, providerId: identity.providerId, value: identity, bootstrap: true });
      }
      const access = runtime.providers.access;
      if (access) {
        providers.register({ slot: "site-access", extensionId: runtime.owners.access!, providerId: access.site.policyId, value: access.site, bootstrap: true });
        providers.register({ slot: "resource-access", extensionId: runtime.owners.access!, providerId: access.resource.policyId, value: access.resource, bootstrap: true });
        providers.register({ slot: "resource-lifecycle", extensionId: runtime.owners.access!, providerId: access.lifecycle.policyId, value: access.lifecycle, bootstrap: true });
        if (access.directory) {
          providers.register({ slot: "resource-directory", extensionId: runtime.owners.access!, providerId: access.directory.directoryId, value: access.directory, bootstrap: true });
        }
      }
    }

    // 显式 seed：只在显式注入时登记，绝不隐式回退。
    if (injectedSeeds?.identity) providers.register({ slot: "identity", extensionId: "injected", providerId: injectedSeeds.identity.providerId, value: injectedSeeds.identity });
    if (injectedSeeds?.siteAccess) providers.register({ slot: "site-access", extensionId: "injected", providerId: injectedSeeds.siteAccess.policyId, value: injectedSeeds.siteAccess });
    if (injectedSeeds?.resourceAccess) providers.register({ slot: "resource-access", extensionId: "injected", providerId: injectedSeeds.resourceAccess.policyId, value: injectedSeeds.resourceAccess });
    if (injectedSeeds?.resourceLifecycle) providers.register({ slot: "resource-lifecycle", extensionId: "injected", providerId: injectedSeeds.resourceLifecycle.policyId, value: injectedSeeds.resourceLifecycle });
    if (injectedSeeds?.resourceDirectory) providers.register({ slot: "resource-directory", extensionId: "injected", providerId: injectedSeeds.resourceDirectory.directoryId, value: injectedSeeds.resourceDirectory });

    // 启动扫描固定访问姿态：可信身份不存在时是本地单实例，而不是匿名受控用户。
    const accessConfigured = injectedAuthenticator !== undefined || providers.identityProvider() !== null;
    const runtime: AccessRuntime = accessConfigured
      ? Object.freeze({ enabled: true as const })
      : Object.freeze({ enabled: false as const, instance: createLocalInstanceScope(env) });

    // 本地单实例仍返回固定的**实例 owner 主体**，供插件把个人数据写进实例 scope，并让仍以
    // 主体为前置条件的旧接缝（如 Provider 刷新路由）不因“无登录”误判为拒绝；它不是登录用户，
    // 也没有任何站点 action（执行边界 runtime 已 disabled）。
    const instancePrincipal: PrincipalContext | null = runtime.enabled
      ? null
      : Object.freeze({ subject: runtime.instance.ownerId, identityProvider: "instance" });
    const authenticator: ApplicationRequestAuthenticator = accessConfigured
      ? injectedAuthenticator ??
        createProviderRequestAuthenticator(() => {
          const provider = providers.identityProvider();
          if (!provider) {
            const error = new Error("身份提供者不可用") as Error & { code?: string };
            error.code = "access-provider-unavailable";
            throw error;
          }
          return provider;
        })
      : async () => instancePrincipal;

    const accessEnforcer = createAccessEnforcer({
      runtime,
      siteAccessPolicy: () => providers.siteAccessPolicy(),
      resourceAccessPolicy: () => providers.resourceAccessPolicy()
    });

    const requiredProviders = foundation
      ? (["identity", "site-access", "resource-access", "resource-lifecycle"] as const)
          .map((slot) => ({ slot, extensionId: foundation.owners[slot === "identity" ? "identity" : "access"] }))
          .filter((profile): profile is typeof profile & { extensionId: string } => profile.extensionId !== undefined)
      : [];

    const service: AccessService = {
      runtime,
      authenticator,
      accessEnforcer,
      providers,
      requiredProviders,
      foundation,
      foundationStorage: foundation?.providers.storage ?? null,
      seedProviders: { ...injectedSeeds },
      closeFoundation
    };
    ctx.provide("access", service);
    ctx.effect(() => () => void closeFoundation());
  }
};

/** 本地开发实例主体的 owner（兼容旧 dev-admin 数据；可被 `WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL` 覆盖）。 */
export function devPrincipalIdFromEnv(env: Record<string, string | undefined>): string {
  return env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL?.trim() || "dev-admin";
}

/**
 * 无受控身份时的实例数据作用域。
 *
 * `ownerId` / `credentialOwnerId` 保持历史 `dev-admin` 口径，避免升级后本机 Agent 连接、会话和
 * 已加密凭据因 owner 变化而“消失”。该 owner 只用于本地实例数据寻址，不产生认证主体、站点 action
 * 或管理权限；部署一旦声明可信身份，运行时即切换到真实 principal 的 user scope。
 */
export function createLocalInstanceScope(env: Record<string, string | undefined>): InstanceDataScope {
  const ownerId = devPrincipalIdFromEnv(env);
  return Object.freeze({
    kind: "instance",
    id: "instance:local",
    ownerId,
    credentialOwnerId: `principal:${ownerId}`
  });
}
