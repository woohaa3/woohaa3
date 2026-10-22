/**
 * 站点应用插件前端入口契约与 registry
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 1.2 / design D1/D5；
 *  change: 2026-10-05-extract-application-plugin-host，任务 1.2：纯类型移入 contracts；
 *  change: 2026-10-10-unify-extension-frontend-entry，任务 2.1：入口升级为完整 Cordis plugin；
 *  change: 2026-10-12-build-and-load-extensions-independently，任务 4.6：入口改为
 *  **metadata + 异步 loadDescriptor**，不再假设同步 `createPlugin`）。
 *
 * **浏览器侧可信入口**：生产入口来自发布方登记的发布目录（`/extension-releases/<id>.json`），
 * 由 loader 按同源版本化 ESM 地址动态加载。这里**没有**任何模块地址、URL、脚本或源码字段；
 * 管理数据只能按 extensionId 引用，不能加载任意代码。
 *
 * 纯类型契约由 `@woohaa3/contracts` 提供；本模块只保留 frontend 运行时的 registry 实现。
 * registry 存纯 metadata 与加载函数，不持有 Fiber；安装资格由 reconciler / page startup 复验。
 */
import type { ApplicationExtensionFrontendAsyncEntry, ExtensionFrontendMetadata } from "@woohaa3/contracts";

export type {
  ApplicationExtensionFrontendActivation,
  ApplicationExtensionFrontendConfigScope,
  ApplicationExtensionFrontendEntry,
  ApplicationExtensionFrontendEntrySummary,
  ApplicationExtensionFrontendAsyncEntry,
  ExtensionFrontendMetadata
} from "@woohaa3/contracts";

/**
 * registry 持有的入口：纯 metadata（目录身份）与**异步** `loadDescriptor()`。
 * 不保存 URL/脚本/源码；实现地址由 loader 从发布目录取得，不进入本结构。
 */
export type RegisteredApplicationExtensionEntry = ApplicationExtensionFrontendAsyncEntry;

const FORBIDDEN_ENTRY_KEYS = ["module", "url", "script", "source", "entry", "entrypoint", "import"];

function assertNoCodeLocation(entry: {
  metadata: ExtensionFrontendMetadata;
} & Record<string, unknown>): void {
  for (const key of FORBIDDEN_ENTRY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) {
      throw new Error(`前端入口不得包含代码位置字段：${key}`);
    }
  }
  const metadata = entry.metadata;
  if (metadata === null || typeof metadata !== "object") {
    throw new Error("前端入口必须提供 metadata 对象");
  }
  if (Object.prototype.hasOwnProperty.call(metadata, "moduleUrl")) {
    throw new Error("前端入口 metadata 不得包含代码位置字段");
  }
  if (typeof metadata.extensionId !== "string" || metadata.extensionId === "") {
    throw new Error("前端入口 metadata.extensionId 必须是非空字符串");
  }
  if (metadata.configScope !== "site" && metadata.configScope !== "browser-local") {
    throw new Error(`未知的前端入口 configScope：${String(metadata.configScope)}`);
  }
  if (
    metadata.activation !== "always" &&
    metadata.activation !== "server-active" &&
    metadata.activation !== "browser-local"
  ) {
    throw new Error(`未知的前端入口 activation：${String(metadata.activation)}`);
  }
  if (typeof entry.loadDescriptor !== "function") {
    throw new Error("前端入口必须提供 loadDescriptor()");
  }
}

/**
 * 站点插件前端入口 registry（owner-scoped；只在 Canvas page scope 内存在）。
 *
 * `register` 拒绝重复 extensionId（后注册稳定失败）并返回幂等 disposer；`dispose` 释放
 * 全部入口。registry 不创建任何 UI —— UI 由 composition root / reconciler 在装配时按策略
 * 调用 `loadDescriptor()` 取得无副作用工厂，再交给 Cordis fiber 生命周期。
 */
export class ApplicationExtensionFrontendEntryRegistry {
  private readonly entries = new Map<string, RegisteredApplicationExtensionEntry>();
  private disposed = false;

  register(entry: RegisteredApplicationExtensionEntry): () => void {
    if (this.disposed) throw new Error("前端插件入口 registry 已释放");
    assertNoCodeLocation(entry as RegisteredApplicationExtensionEntry & Record<string, unknown>);
    const extensionId = entry.metadata.extensionId;
    if (this.entries.has(extensionId)) {
      throw new Error(`重复的前端插件入口：${extensionId}`);
    }
    this.entries.set(extensionId, entry);
    return () => {
      this.entries.delete(extensionId);
    };
  }

  get(extensionId: string): RegisteredApplicationExtensionEntry | undefined {
    return this.entries.get(extensionId);
  }

  has(extensionId: string): boolean {
    return this.entries.has(extensionId);
  }

  list(): Array<{
    extensionId: string;
    configScope: ExtensionFrontendMetadata["configScope"];
    activation: ExtensionFrontendMetadata["activation"];
  }> {
    return [...this.entries.values()].map((entry) => ({
      extensionId: entry.metadata.extensionId,
      configScope: entry.metadata.configScope,
      activation: entry.metadata.activation
    }));
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }
}
