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
  const entries: ExtensionRuntimeEntry[] = catalog.entries.map((releaseEntry) => ({
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
    releaseId: catalog.releaseId,
    entries,
    byId: (extensionId) => byIdMap.get(extensionId),
    browserLocalIds: () => [...browserLocal]
  };
}
