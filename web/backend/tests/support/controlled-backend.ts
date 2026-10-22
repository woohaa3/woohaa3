import { ACCESS_ACTIONS } from "@woohaa3/contracts";
import { createBackendService, type BackendServiceOptions } from "../../src/composition.js";

/**
 * 受控回归显式声明完整槽位，不依赖工作区是否启用 WOA。
 *
 * 适配（恢复自迁移前的 `tests/support/controlled-backend.ts`）：迁移后的宿主把槽位实现分两条路
 * 装进同一个 registry —— `bootstrapExtensions` 装 storage/identity/access 槽位实现，
 * `seedProviders` 装显式注入的 fake；同一 slot 被两条路引用时 registry fail-fast
 * （「提供者槽位已被占用」）。因此受控 identity / site / resource / lifecycle 改由
 * `seedProviders` 注入；storage 不再注入槽位实现（`@woohaa3/extension-sqlite-storage` 已不在
 * backend 的依赖里），改由 Canvas Service 按 `WOOHAA3_CANVAS_STORAGE_*` 环境变量自建 sqlite 存储。
 * 传空 `bootstrapExtensions` 同时跳过扩展目录扫描，保证测试不加载真实扩展。
 * 调用方传入的 `seedProviders` 覆盖同名 fake，例如测试注入带 `reconcileProvisioning` 的 lifecycle。
 */
export function createControlledBackendService(options: BackendServiceOptions) {
  const seeds: NonNullable<BackendServiceOptions["seedProviders"]> = {
    identity: {
      providerId: "test-identity",
      async authenticate() {
        return { ok: false as const, code: "unauthenticated" as const };
      }
    },
    siteAccess: {
      policyId: "test-site",
      policyVersion: () => "1",
      async allowedActions() {
        return ACCESS_ACTIONS;
      },
      async authorize() {
        return { allowed: true as const };
      }
    },
    resourceAccess: {
      policyId: "test-resource",
      async authorize() {
        return { allowed: false as const, code: "forbidden" as const };
      }
    },
    resourceLifecycle: {
      policyId: "test-lifecycle",
      async reserve() {
        return { ok: true as const, aclRevision: 1 };
      },
      async finalize() {
        return { ok: true as const, aclRevision: 2 };
      },
      async tombstone() {
        return { ok: true as const };
      }
    },
    ...options.seedProviders
  };
  return createBackendService({
    ...options,
    seedProviders: seeds,
    bootstrapExtensions: []
  });
}
