/**
 * 基础提供者注册表与 bootstrap 校验
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.1/1.2/1.5）。
 *
 * 宿主在这里维护**类型化** identity / site-access / resource-access / resource-lifecycle
 * 提供者槽位。提供者由可信扩展在 activation 中登记；宿主按可信部署 profile（只含 extensionId）
 * 校验「每个必需 slot 恰有一个 owner」。它是通用机制：不理解企业协议、管理员名单或四模式 ACL。
 *
 * 失败语义：必需提供者缺失/重复/故障时，保护面拒绝（503）且 readiness=false，绝不回退
 * loopback、旧 Token 或存在性放行。
 */
import {
  ACCESS_PROVIDER_UNAVAILABLE_CODE,
  REQUIRED_PROVIDER_SLOTS,
  type IdentityProvider,
  type ProviderSlot,
  type RequiredProviderProfiles,
  type RequiredProviderSlot,
  type ResourceAccessPolicy,
  type ResourceDirectory,
  type ResourceLifecyclePolicy,
  type SiteAccessPolicy
} from "@woohaa3/contracts";

export type ProviderRegistration = {
  slot: ProviderSlot;
  /** bootstrap 拥有的资源不随普通 activate/dispose 释放。 */
  bootstrap?: boolean;
  /** 可信 extensionId（owner）。 */
  extensionId: string;
  /** 提供者自身 identity（稳定字符串，便于诊断）。 */
  providerId: string;
  value: IdentityProvider | SiteAccessPolicy | ResourceAccessPolicy | ResourceLifecyclePolicy | ResourceDirectory;
};

export type ProviderRegistryError = { code: string; message: string };

export type ProviderRegistry = {
  /** 登记一个提供者；重复 slot/owner 抛错（不覆盖）。 */
  register(registration: ProviderRegistration): void;
  identityProvider(): IdentityProvider | null;
  siteAccessPolicy(): SiteAccessPolicy | null;
  resourceAccessPolicy(): ResourceAccessPolicy | null;
  resourceLifecyclePolicy(): ResourceLifecyclePolicy | null;
  /** 可选：资源发现目录；缺失返回 null（消费方 fail closed）。 */
  resourceDirectory(): ResourceDirectory | null;
  /** slot → owner extensionId（诊断/bootstrap 校验）。 */
  owners(): Readonly<Partial<Record<RequiredProviderSlot, string>>>;
  /** 释放某 extension 登记的全部提供者（rollback）。 */
  releaseExtension(extensionId: string): void;
  /** 清空（宿主 dispose）。 */
  clear(): void;
};

export function createProviderRegistry(): ProviderRegistry {
  const slots = new Map<ProviderSlot, ProviderRegistration>();
  return {
    register(registration) {
      if (slots.has(registration.slot)) {
        throw new Error(`提供者槽位已被占用：${registration.slot}（owner ${slots.get(registration.slot)!.extensionId}）`);
      }
      slots.set(registration.slot, registration);
    },
    identityProvider: () => (slots.get("identity")?.value as IdentityProvider | undefined) ?? null,
    siteAccessPolicy: () => (slots.get("site-access")?.value as SiteAccessPolicy | undefined) ?? null,
    resourceAccessPolicy: () => (slots.get("resource-access")?.value as ResourceAccessPolicy | undefined) ?? null,
    resourceLifecyclePolicy: () => (slots.get("resource-lifecycle")?.value as ResourceLifecyclePolicy | undefined) ?? null,
    resourceDirectory: () => (slots.get("resource-directory")?.value as ResourceDirectory | undefined) ?? null,
    owners() {
      const out: Partial<Record<RequiredProviderSlot, string>> = {};
      for (const slot of REQUIRED_PROVIDER_SLOTS) {
        const registration = slots.get(slot);
        if (registration) out[slot] = registration.extensionId;
      }
      return out;
    },
    releaseExtension(extensionId) {
      for (const [slot, registration] of [...slots]) {
        if (registration.extensionId === extensionId && !registration.bootstrap) slots.delete(slot);
      }
    },
    clear() {
      slots.clear();
    }
  };
}

export type ProviderBootstrapResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * 校验必需 profile：每个 profile 项引用已知 extension，且该 extension 恰是 slot 的 owner。
 *
 * 重复 owner / 未知入口（profile 引用未激活扩展）/ 循环依赖在开放受保护入口前拒绝。
 */
export function validateRequiredProviderBootstrap(
  registry: ProviderRegistry,
  profiles: RequiredProviderProfiles,
  knownExtensionIds: readonly string[]
): ProviderBootstrapResult {
  const known = new Set(knownExtensionIds);
  const seenSlots = new Set<RequiredProviderSlot>();
  for (const profile of profiles) {
    if (!(REQUIRED_PROVIDER_SLOTS as readonly string[]).includes(profile.slot)) {
      return { ok: false, code: "unknown-slot", message: `未知基础提供者槽位：${String(profile.slot)}` };
    }
    if (seenSlots.has(profile.slot)) {
      return { ok: false, code: "duplicate-slot", message: `基础提供者槽位重复：${profile.slot}` };
    }
    seenSlots.add(profile.slot);
    if (!known.has(profile.extensionId)) {
      return { ok: false, code: "unknown-entry", message: `基础提供者引用未知扩展：${profile.extensionId}` };
    }
    const owner = registry.owners()[profile.slot];
    if (owner !== profile.extensionId) {
      return {
        ok: false,
        code: "missing-provider",
        message: `基础提供者未就绪：slot=${profile.slot} 期望 ${profile.extensionId}，实际 ${owner ?? "（缺失）"}`
      };
    }
  }
  return { ok: true };
}

/** 受保护面访问基础提供者；缺失时抛稳定 503 错误（不下沉为匿名/放行）。 */
export class AccessProviderUnavailableError extends Error {
  readonly code = ACCESS_PROVIDER_UNAVAILABLE_CODE;
  constructor(message: string) {
    super(message);
    this.name = "AccessProviderUnavailableError";
  }
}

export function requireIdentityProvider(registry: ProviderRegistry): IdentityProvider {
  const provider = registry.identityProvider();
  if (!provider) throw new AccessProviderUnavailableError("身份提供者不可用");
  if (provider.ready && !provider.ready()) throw new AccessProviderUnavailableError("身份提供者未就绪");
  return provider;
}

export function requireSiteAccessPolicy(registry: ProviderRegistry): SiteAccessPolicy {
  const policy = registry.siteAccessPolicy();
  if (!policy) throw new AccessProviderUnavailableError("站点授权提供者不可用");
  if (policy.ready && !policy.ready()) throw new AccessProviderUnavailableError("站点授权提供者未就绪");
  return policy;
}

export function requireResourceAccessPolicy(registry: ProviderRegistry): ResourceAccessPolicy {
  const policy = registry.resourceAccessPolicy();
  if (!policy) throw new AccessProviderUnavailableError("资源访问提供者不可用");
  if (policy.ready && !policy.ready()) throw new AccessProviderUnavailableError("资源访问提供者未就绪");
  return policy;
}

export function requireResourceLifecyclePolicy(registry: ProviderRegistry): ResourceLifecyclePolicy {
  const policy = registry.resourceLifecyclePolicy();
  if (!policy) throw new AccessProviderUnavailableError("资源生命周期提供者不可用");
  if (policy.ready && !policy.ready()) throw new AccessProviderUnavailableError("资源生命周期提供者未就绪");
  return policy;
}

/**
 * 可选资源目录：缺失时返回 null（调用方 fail closed，不抛必需提供者错误）。
 */
export function optionalResourceDirectory(registry: ProviderRegistry): ResourceDirectory | null {
  const directory = registry.resourceDirectory();
  if (directory && directory.ready && !directory.ready()) return null;
  return directory;
}
