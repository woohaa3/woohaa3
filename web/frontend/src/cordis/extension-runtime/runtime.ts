/**
 * Extension release runtime：把已校验的发布目录投影为可加载的运行时 entry
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 4.6 / design D4/D6/D7）。
 *
 * 本模块只做**纯投影 + 代码加载委托**：
 * - 目录 entry → `ExtensionRuntimeEntry`（metadata + artifactId + `loadDescriptor()`）；
 * - `loadDescriptor()` 委托 artifact loader，返回无业务副作用的 descriptor；不创建 plugin/Fiber。
 *
 * 目录身份（metadata）与实现（descriptor）分离：host 在实现求值后另校验 descriptor identity。
 * 该投影是 App 级、不可变的；page transition 不重新请求目录，只在本 scope 构造新 plugin。
 */
import type {
  ExtensionBrowserDescriptor,
  ExtensionBrowserReleaseEntry,
  ExtensionFrontendMetadata,
  ExtensionReleaseCatalog
} from "@woohaa3/contracts";
import type { ExtensionArtifactLoader } from "./loader.js";

export type ExtensionRuntimeEntry = {
  metadata: ExtensionFrontendMetadata;
  artifactId: string;
  releaseEntry: ExtensionBrowserReleaseEntry;
  /** 加载实现并返回无副作用 descriptor 工厂；不创建 plugin/Fiber。 */
  loadDescriptor(): Promise<ExtensionBrowserDescriptor>;
};

export type ExtensionReleaseRuntime = {
  /** 当前固定的 releaseId（无目录为 null）。 */
  releaseId: string | null;
  entries: readonly ExtensionRuntimeEntry[];
  byId(extensionId: string): ExtensionRuntimeEntry | undefined;
  /** 目录中可配置的 browser-local optional ID（稳定排序）。 */
  browserLocalIds(): string[];
};

export function createExtensionReleaseRuntime(
  catalog: ExtensionReleaseCatalog,
  loader: ExtensionArtifactLoader
): ExtensionReleaseRuntime {
  return runtimeFromEntries(catalog.releaseId, catalog.entries, loader);
}

/**
 * 热登记的差异（change: 2026-10-21-add-extension-marketplace-point，6.3 / design D8）：
 * 新 release 相对当前运行时目录新增、artifact 变化（升级）与消失（卸载）的 extensionId。
 */
export type ExtensionReleaseDelta = { added: string[]; upgraded: string[]; removed: string[] };

export function diffReleaseEntries(
  current: readonly ExtensionBrowserReleaseEntry[],
  next: readonly ExtensionBrowserReleaseEntry[]
): ExtensionReleaseDelta {
  const before = new Map(current.map((entry) => [entry.metadata.extensionId, entry.artifactId]));
  const after = new Map(next.map((entry) => [entry.metadata.extensionId, entry.artifactId]));
  const added: string[] = [];
  const upgraded: string[] = [];
  for (const [id, artifactId] of after) {
    if (!before.has(id)) added.push(id);
    else if (before.get(id) !== artifactId) upgraded.push(id);
  }
  const removed = [...before.keys()].filter((id) => !after.has(id));
  return { added: added.sort(), upgraded: upgraded.sort(), removed: removed.sort() };
}

/**
 * 在已固定的运行时目录上**只追加**新 release 的新增条目：已有条目（含被升级的）保持原 artifact，
 * 已装配的页面与已加载的模块都不受影响；releaseId 仍是固定的那一个。
 */
export function extendReleaseRuntime(
  runtime: ExtensionReleaseRuntime,
  next: ExtensionReleaseCatalog,
  loader: ExtensionArtifactLoader
): { runtime: ExtensionReleaseRuntime; delta: ExtensionReleaseDelta } {
  const current = runtime.entries.map((entry) => entry.releaseEntry);
  const delta = diffReleaseEntries(current, next.entries);
  if (delta.added.length === 0) return { runtime, delta };
  const additions = next.entries.filter((entry) => delta.added.includes(entry.metadata.extensionId));
  return { runtime: runtimeFromEntries(runtime.releaseId, [...current, ...additions], loader), delta };
}

/**
 * 把目录中**某个条目**切到新版本（change: 2026-10-27-add-extension-dev-reload，D1/D5）。
 *
 * 与 `extendReleaseRuntime` 的区别：只替换一个 id，其余条目与已固定 release 不变。
 * 这是实例级重装所需的「按 id 换 artifact」原语——它不改变「已开页面固定旧 release」的既有语义，
 * 因为调用方只有开发者模式的热重载，而且是显式针对单个扩展的。
 *
 * `nextEntry` 为 null 表示该扩展已不在新目录里：条目被移除，调用方应按升级失败或卸载处理。
 */
export function replaceReleaseEntry(
  runtime: ExtensionReleaseRuntime,
  extensionId: string,
  nextEntry: ExtensionBrowserReleaseEntry | null,
  loader: ExtensionArtifactLoader
): { runtime: ExtensionReleaseRuntime; changed: boolean } {
  const index = runtime.entries.findIndex((entry) => entry.metadata.extensionId === extensionId);
  if (index < 0) return { runtime, changed: false };
  const current = runtime.entries[index]!;
  if (!nextEntry) {
    const remaining = runtime.entries.filter((entry) => entry.metadata.extensionId !== extensionId);
    return { runtime: runtimeFromEntries(runtime.releaseId, remaining.map((entry) => entry.releaseEntry), loader), changed: true };
  }
  if (current.artifactId === nextEntry.artifactId) return { runtime, changed: false };
  const releaseEntries = runtime.entries.map((entry) => entry.releaseEntry);
  releaseEntries[index] = nextEntry;
  return { runtime: runtimeFromEntries(runtime.releaseId, releaseEntries, loader), changed: true };
}

function runtimeFromEntries(
  releaseId: string | null,
  releaseEntries: readonly ExtensionBrowserReleaseEntry[],
  loader: ExtensionArtifactLoader
): ExtensionReleaseRuntime {
  const entries: ExtensionRuntimeEntry[] = releaseEntries.map((releaseEntry) => ({
    metadata: releaseEntry.metadata,
    artifactId: releaseEntry.artifactId,
    releaseEntry,
    async loadDescriptor() {
      const loaded = await loader.load(releaseEntry);
      return loaded.createDescriptor();
    }
  }));
  const byIdMap = new Map(entries.map((entry) => [entry.metadata.extensionId, entry]));
  const browserLocal = entries
    .filter((entry) => entry.metadata.configScope === "browser-local" && entry.metadata.activation === "browser-local")
    .map((entry) => entry.metadata.extensionId)
    .sort();
  return {
    releaseId,
    entries,
    byId: (extensionId) => byIdMap.get(extensionId),
    browserLocalIds: () => [...browserLocal]
  };
}
