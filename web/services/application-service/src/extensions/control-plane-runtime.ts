/**
 * 控制面的运行期登记（change: 2026-10-21-isolate-extension-host-process；首次安装的受管后端扩展）。
 *
 * 启动期清单（`options.metadata` / `options.definitions`）的**集合**固定不变；运行期可以叠加或覆盖：
 * - `addExtension`：登记元数据与可信定义、从审计恢复隔离记录，然后**只对它**协调一次
 *   （无配置且 defaultEnabled → 首次版本化提交并激活；已有配置 → 按 desiredEnabled；安全模式 / 隔离 → 不激活）。
 *   同 id 已登记（含启动期清单）→ `extension-exists`。
 * - `replaceExtension`：同 id **换版**（市场版本覆盖内置版本、受管扩展升级、回滚、开发者模式重装）。元数据覆盖原来那一行、
 *   定义换成新目录的工厂，先释放旧版本实例再按当前配置重新协调一次。
 * - `removeExtension`：释放全部版本实例、把这一行从目录里摘掉、推进 revision。已保存的站点配置与审计保留
 *   （重装后沿用）。
 *
 * **可移除性由来源归属（`origin`）决定，不由「什么时候登记的」决定。**
 * 受管扩展安装过一次并重启后，它也在启动期扫描清单里；若拿「是否在启动期清单」判断归属，
 * 它就会被误当成内置——卸载与换版都以 `extension-not-removable` 失败（这正是
 * `MARKETPLACE_SWAP_FAILED` / 「插件 photocraft 属于启动期清单」的成因）。
 * 真正不可移除的只有 `builtin`（随客户端发布的内置根）。`managed` / `dev` / `writable` 都是外部装入的，
 * 随时可以卸载或被更高版本替换。缺省未声明时按 `builtin` 处理（最保守的一侧）。
 *
 * 幂等与重试：add 失败（协调期间激活失败）不回滚登记，状态如实为 failed，可按配置变化重试；remove 成功后再调
 * 返回 `extension-not-found`；replace 可重复调用（每次都是「释放旧实例 + 按当前配置重新协调」）。
 */
import type { ApplicationExtensionMetadata, ApplicationExtensionOrigin } from "@woohaa3/contracts";
import type { ApplicationBackendExtensionDefinition } from "./contract.js";
import type { SqliteSiteExtensionConfigStore } from "./config-store.js";
import type { SiteExtensionMetadataSource, SiteExtensionRuntimeOutcome } from "./control-plane-types.js";
import type { ApplicationExtensionHost } from "./host.js";
import type { QuarantineRegistry } from "./quarantine.js";

/** 这一行是否属于内置根（未声明来源按内置处理）。 */
export function isBuiltinOrigin(metadata: ApplicationExtensionMetadata | undefined): boolean {
  const origin: ApplicationExtensionOrigin = metadata?.origin ?? "builtin";
  return origin === "builtin";
}

export type RuntimeCatalog = {
  source: SiteExtensionMetadataSource;
  /** 登记运行期新增的行（排在启动期清单之后）。 */
  add(metadata: ApplicationExtensionMetadata): void;
  /** 覆盖同 id 的那一行（启动期或运行期都行）；不改变它在清单里的位置。 */
  replace(metadata: ApplicationExtensionMetadata): void;
  /** 移除某一行（运行期行直接删，启动期行从本进程的可见集合里隐藏）。 */
  remove(extensionId: string): void;
};

/**
 * 启动期元数据之上叠加运行期条目；list 保持「启动期在前、运行期按登记顺序」。
 *
 * 两级覆盖：`runtime` 是运行期新增的行，`overrides` 是被换版覆盖的启动期行。读路径先看覆盖，
 * 否则启动期清单里那一行会让换版后的版本号与目录永远停在旧值。
 */
export function createRuntimeCatalog(base: SiteExtensionMetadataSource): RuntimeCatalog {
  const runtime = new Map<string, ApplicationExtensionMetadata>();
  const overrides = new Map<string, ApplicationExtensionMetadata>();
  const retired = new Set<string>();
  const hidden = (extensionId: string) => retired.has(extensionId) && !runtime.has(extensionId);
  return {
    source: {
      list: () => {
        const entries: ApplicationExtensionMetadata[] = [];
        for (const entry of base.list()) {
          if (hidden(entry.extensionId)) continue;
          entries.push(overrides.get(entry.extensionId) ?? entry);
        }
        for (const entry of runtime.values()) entries.push(entry);
        return entries;
      },
      get: (extensionId) => {
        const live = runtime.get(extensionId);
        if (live) return live;
        if (hidden(extensionId)) return undefined;
        return overrides.get(extensionId) ?? base.get(extensionId);
      }
    },
    add: (metadata) => {
      runtime.set(metadata.extensionId, metadata);
      overrides.delete(metadata.extensionId);
      retired.delete(metadata.extensionId);
    },
    replace: (metadata) => {
      // 换版只覆盖已有的那一行：运行期行就地更新，启动期行进覆盖表。
      if (runtime.has(metadata.extensionId)) runtime.set(metadata.extensionId, metadata);
      else overrides.set(metadata.extensionId, metadata);
      retired.delete(metadata.extensionId);
    },
    remove: (extensionId) => {
      const wasRuntime = runtime.delete(extensionId);
      overrides.delete(extensionId);
      // 启动期清单是扫描结果、不可变：只能在本次进程内隐藏它，下次启动按磁盘重新装配。
      if (!wasRuntime) retired.add(extensionId);
    }
  };
}

type RuntimeDeps = {
  catalog: RuntimeCatalog;
  definitionById: Map<string, ApplicationBackendExtensionDefinition>;
  host: ApplicationExtensionHost;
  store: SqliteSiteExtensionConfigStore;
  quarantine: QuarantineRegistry;
  publicVersion: Map<string, number>;
  activeWorkCount: (extensionId: string) => number;
  disposeLease: (extensionId: string) => void;
  reconcileOne: (metadata: ApplicationExtensionMetadata) => Promise<void>;
  statusFor: SiteExtensionRuntimeOutcomeStatus;
  log: (event: Record<string, unknown>) => void;
};

type SiteExtensionRuntimeOutcomeStatus = (extensionId: string) => import("@woohaa3/contracts").ApplicationExtensionStatus | undefined;

export function createRuntimeRegistration(deps: RuntimeDeps) {
  /** 释放该扩展的全部运行实例（public 与 recovery），换版与卸载共用。 */
  const releaseInstances = async (extensionId: string) => {
    for (const version of [...deps.host.activeVersions(extensionId)]) {
      await deps.host.disposeVersion(extensionId, version);
    }
    deps.publicVersion.delete(extensionId);
    deps.disposeLease(extensionId);
  };

  const addExtension = async (input: {
    metadata: ApplicationExtensionMetadata;
    definition: ApplicationBackendExtensionDefinition;
  }): Promise<SiteExtensionRuntimeOutcome> => {
    const { metadata, definition } = input;
    if (definition.extensionId !== metadata.extensionId) {
      return { ok: false, code: "extension-invalid", message: "定义与元数据的 extensionId 不一致" };
    }
    if (deps.catalog.source.get(metadata.extensionId) || deps.definitionById.has(metadata.extensionId)) {
      return { ok: false, code: "extension-exists", message: `插件 ${metadata.extensionId} 已登记` };
    }
    deps.catalog.add(metadata);
    deps.definitionById.set(metadata.extensionId, definition);
    deps.quarantine.restore(metadata.extensionId);
    deps.log({ event: "site-extension-runtime-added", extensionId: metadata.extensionId });
    await deps.reconcileOne(metadata);
    const status = deps.statusFor(metadata.extensionId);
    return { ok: true, revision: deps.store.revision(), ...(status ? { status } : {}) };
  };

  /**
   * 同 id 换版（受管扩展升级 / 市场版本覆盖内置版本 / 回滚 / 开发者模式重装）。
   *
   * 与 add 的区别只在「行已经存在」：不新增行、不写 extension-removed，配置与审计原样保留，
   * 换完直接按当前 desiredEnabled 重新协调一次。
   */
  const replaceExtension = async (input: {
    metadata: ApplicationExtensionMetadata;
    definition: ApplicationBackendExtensionDefinition;
  }): Promise<SiteExtensionRuntimeOutcome> => {
    const { metadata, definition } = input;
    const extensionId = metadata.extensionId;
    if (definition.extensionId !== extensionId) {
      return { ok: false, code: "extension-invalid", message: "定义与元数据的 extensionId 不一致" };
    }
    if (!deps.catalog.source.get(extensionId)) {
      return { ok: false, code: "extension-not-found", message: `插件 ${extensionId} 未登记` };
    }
    const activeWorkCount = deps.activeWorkCount(extensionId);
    if (activeWorkCount > 0) {
      return { ok: false, code: "extension-busy", message: `插件 ${extensionId} 仍有 ${activeWorkCount} 项在途工作；请先停用并等待收尾`, activeWorkCount };
    }
    // 旧实例必须全部撤下：换版后旧目录的模块身份不再被引用，留着只会让旧代码继续应答。
    await releaseInstances(extensionId);
    deps.definitionById.set(extensionId, definition);
    deps.catalog.replace(metadata);
    deps.log({ event: "site-extension-runtime-replaced", extensionId, directory: metadata.directory });
    await deps.reconcileOne(metadata);
    const status = deps.statusFor(extensionId);
    return { ok: true, revision: deps.store.revision(), ...(status ? { status } : {}) };
  };

  const removeExtension = async (extensionId: string): Promise<SiteExtensionRuntimeOutcome> => {
    const metadata = deps.catalog.source.get(extensionId);
    if (!metadata) {
      return { ok: false, code: "extension-not-found", message: `插件 ${extensionId} 未登记` };
    }
    // 只有内置根不可移除；受管 / 开发者 / 可写根都是外部装入的，随时可卸。
    if (isBuiltinOrigin(metadata)) {
      return { ok: false, code: "extension-not-removable", message: `插件 ${extensionId} 是内置扩展，不能卸载` };
    }
    const activeWorkCount = deps.activeWorkCount(extensionId);
    if (activeWorkCount > 0) {
      return { ok: false, code: "extension-busy", message: `插件 ${extensionId} 仍有 ${activeWorkCount} 项在途工作；请先停用并等待收尾`, activeWorkCount };
    }
    await releaseInstances(extensionId);
    deps.quarantine.delete(extensionId);
    deps.definitionById.delete(extensionId);
    deps.catalog.remove(extensionId);
    // 推进 revision 并写 status log：前端增量据此刷新（snapshot 里不再有它）。
    deps.store.setActual(extensionId, "disabled", [{ code: "extension-removed", message: "扩展已卸载" }], new Date().toISOString());
    deps.log({ event: "site-extension-runtime-removed", extensionId, origin: metadata.origin ?? "builtin" });
    return { ok: true, revision: deps.store.revision() };
  };

  return { addExtension, replaceExtension, removeExtension };
}
