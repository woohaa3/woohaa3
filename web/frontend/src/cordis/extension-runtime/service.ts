/**
 * Extension App 级运行时服务
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 4.1–4.5/5.1 / design D6/D7/D8）。
 *
 * App scope 单例，负责：
 * - 首次需要时加载并**固定**发布目录（`<link rel="woohaa-extension-release">`）；同 document 内
 *   后续 page 复用同一 release，不在一次 transition 中混用两个 release；
 * - 提供 App 级 artifact loader（成功 module/CSS 缓存跨 page 复用，不缓存业务实例）；
 * - 暴露纯 metadata 目录与 `loadDescriptor(id)`，供 page startup / server-active reconciler 使用；
 * - 记录可公开加载诊断（不含资源 URL/凭据），支持受控重试。
 *
 * 目录缺失（HTML 无 link）返回“无扩展能力”，不禁用核心；Task History 冷启动不触发本服务。
 */
import type {
  ExtensionBrowserReleaseEntry,
  ExtensionFrontendMetadata,
  ExtensionLoadDiagnostic
} from "@woohaa3/contracts";
import { createExtensionReleaseCatalogLoader } from "./catalog.js";
import { createExtensionArtifactLoader, ExtensionLoadError, type ExtensionArtifactLoader } from "./loader.js";
import { createExtensionReleaseRuntime, type ExtensionReleaseRuntime, type ExtensionRuntimeEntry } from "./runtime.js";
import { createExtensionRuntimeProvider, type ExtensionRuntimeProvider } from "./runtime-provider.js";

export type ExtensionRuntimeServiceOptions = {
  /** 注入目录 loader（测试）；缺省读发布 HTML link。 */
  catalogLoader?: ReturnType<typeof createExtensionReleaseCatalogLoader>;
  /** 注入 artifact loader（测试）；缺省 native import + `<link>` 样式。 */
  artifactLoader?: ExtensionArtifactLoader;
  /** 注入 runtime provider（测试）；缺省宿主 React/JSX/SDK adapter。 */
  runtimeProvider?: ExtensionRuntimeProvider;
  logger?: (event: Record<string, unknown>) => void;
};

export type ExtensionRuntimeService = {
  /** 加载并固定发布目录；无目录返回 null（调用方视为无扩展能力）。 */
  ensureCatalog(): Promise<ExtensionReleaseRuntime | null>;
  /** 已固定的运行时目录（未加载为 null）。 */
  current(): ExtensionReleaseRuntime | null;
  /** 纯 metadata（未加载目录为空数组）。 */
  metadata(): readonly ExtensionFrontendMetadata[];
  /** 按 ID 取运行时入口。 */
  entry(extensionId: string): ExtensionRuntimeEntry | undefined;
  /** 加载某 ID 的实现并返回无副作用 descriptor；不创建 plugin/Fiber。 */
  loadDescriptor(extensionId: string): Promise<import("@woohaa3/contracts").ExtensionBrowserDescriptor>;
  /** 可公开加载诊断。 */
  diagnostics(): ExtensionLoadDiagnostic[];
  /** 记录一次诊断（page startup / reconciler 上报）。 */
  report(diagnostic: ExtensionLoadDiagnostic): void;
  /** 显式重试：清除该 ID 的失败诊断（不改变权威状态）。 */
  retry(extensionId: string): void;
  dispose(): void;
};

export function createExtensionRuntimeService(
  options: ExtensionRuntimeServiceOptions = {}
): ExtensionRuntimeService {
  const log = options.logger ?? (() => undefined);
  const catalogLoader = options.catalogLoader ?? createExtensionReleaseCatalogLoader({ logger: log });
  const runtimeProvider = options.runtimeProvider ?? createExtensionRuntimeProvider();
  const artifactLoader = options.artifactLoader ?? createExtensionArtifactLoader({ runtimeProvider, logger: log });
  const diagnostics = new Map<string, ExtensionLoadDiagnostic>();
  let runtime: ExtensionReleaseRuntime | null = null;
  let disposed = false;

  const ensureCatalog = async (): Promise<ExtensionReleaseRuntime | null> => {
    if (disposed) throw new ExtensionLoadError("evaluation", "extension runtime 已释放", false);
    if (runtime) return runtime;
    const catalog = await catalogLoader.load();
    if (!catalog) {
      log({ event: "extension-runtime-no-catalog" });
      return null;
    }
    runtime = createExtensionReleaseRuntime(catalog, artifactLoader);
    return runtime;
  };

  const requireEntry = (extensionId: string): ExtensionRuntimeEntry => {
    const entry = runtime?.byId(extensionId);
    if (!entry) throw new ExtensionLoadError("invalid-artifact", `发布目录不含扩展：${extensionId}`, false);
    return entry;
  };

  const record = (extensionId: string, diagnostic: ExtensionLoadDiagnostic) => {
    diagnostics.set(extensionId, diagnostic);
  };

  return {
    ensureCatalog,
    current: () => runtime,
    metadata: () => runtime?.entries.map((entry) => entry.metadata) ?? [],
    entry: (extensionId) => runtime?.byId(extensionId),
    async loadDescriptor(extensionId) {
      const entry = requireEntry(extensionId);
      record(extensionId, {
        extensionId,
        status: "loading",
        artifactId: entry.artifactId,
        releaseId: runtime?.releaseId ?? null,
        errorCode: null,
        message: null
      });
      try {
        const descriptor = await entry.loadDescriptor();
        record(extensionId, {
          extensionId,
          status: "registered",
          artifactId: entry.artifactId,
          releaseId: runtime?.releaseId ?? null,
          errorCode: null,
          message: null
        });
        return descriptor;
      } catch (error) {
        const code = error instanceof ExtensionLoadError ? error.code : "evaluation";
        record(extensionId, {
          extensionId,
          status: "load-failed",
          artifactId: entry.artifactId,
          releaseId: runtime?.releaseId ?? null,
          errorCode: code,
          message: error instanceof Error ? error.message : "功能加载失败，请重试"
        });
        throw error;
      }
    },
    diagnostics: () => [...diagnostics.values()].sort((a, b) => (a.extensionId < b.extensionId ? -1 : 1)),
    report: (diagnostic) => record(diagnostic.extensionId, diagnostic),
    retry: (extensionId) => {
      const existing = diagnostics.get(extensionId);
      if (existing && (existing.status === "load-failed" || existing.status === "failed")) {
        diagnostics.delete(extensionId);
      }
    },
    dispose() {
      disposed = true;
      artifactLoader.dispose();
      catalogLoader.dispose();
      runtime = null;
      diagnostics.clear();
    }
  };
}

/** 从发布目录 entry 取加载所需的运行时要求（诊断/测试）。 */
export function releaseEntryRequirements(entry: ExtensionBrowserReleaseEntry): {
  groups: readonly string[];
  exports: readonly string[];
} {
  return { groups: entry.requiredSdkGroups, exports: entry.requiredSdkExports };
}
