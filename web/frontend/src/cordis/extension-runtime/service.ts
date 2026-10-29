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
import {
  createExtensionReleaseCatalogLoader,
  EXTENSION_RELEASE_LINK_REL,
  readExtensionReleaseHref
} from "./catalog.js";
import { createExtensionArtifactLoader, ExtensionLoadError, type ExtensionArtifactLoader } from "./loader.js";
import {
  createExtensionReleaseRuntime,
  extendReleaseRuntime,
  replaceReleaseEntry,
  type ExtensionReleaseDelta,
  type ExtensionReleaseRuntime,
  type ExtensionRuntimeEntry
} from "./runtime.js";
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
  /**
   * 改固定到另一个发布目录（change: 2026-10-21-harden-extension-fault-isolation，D6；P1 热登记在此扩展）。
   *
   * 新目录加载并校验成功后才替换运行时目录、清空加载诊断，并同步更新 HTML 上的发布 link
   * （后续读 link 的地方与之一致）；返回新 releaseId。已加载的 module/CSS 缓存按 artifact URL
   * 保留（artifact 不可变，可直接复用）。已装配的页面不受影响：新 release 只在下一次创建
   * page scope 时生效。失败时抛出且原 release 保持不变。
   */
  repin(releaseHref: string): Promise<string>;
  /**
   * 热登记（change: 2026-10-21-add-extension-marketplace-point，6.3 / design D8）：读取宿主新发布的目录，
   * **不**改变已固定的 release，只把新增条目追加进运行时目录；升级（artifact 变化）与卸载的条目
   * 不在已打开页面热换，只记录为待重开提示。
   *
   * 同一 releaseId 重复调用幂等（返回 null）；目录尚未固定时只更新 HTML link，首次加载即用新目录。
   * 读取或校验失败时抛出，运行时目录保持不变。
   */
  adoptRelease(pointer: { releaseId: string; href: string }): Promise<ExtensionReleaseDelta | null>;
  /**
   * 按 `extensionId` 把运行时目录中的这一条刷新到宿主当前发布目录里的新 artifact
   * （change: 2026-10-27-add-extension-dev-reload，D1）。
   *
   * 只影响该 id，其余条目与已固定 release 不变；artifactId 未变化时返回 `changed: false`。
   * 供实例级重装在重新解析代码来源前调用，使 `loadDescriptor` 看到新产物。
   * 目录尚未固定、或该 id 不在目录里时返回 `changed: false`（不抛错）。
   */
  refreshEntry(extensionId: string): Promise<{ changed: boolean; artifactId: string | null }>;
  /** 自页面打开以来已发布、但当前页面仍在用旧版本的扩展（升级/卸载）；重开画布后生效。 */
  staleExtensionIds(): readonly string[];
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
  /** 已采纳的最新 releaseId（热登记去重）。 */
  let adoptedReleaseId: string | null = null;
  /** 待重开才生效的扩展（升级/卸载）。 */
  const stale = new Set<string>();
  /**
   * 最近一次使用的发布目录地址（change: 2026-10-27-add-extension-dev-reload）。
   *
   * `refreshEntry` 要读宿主**当前**目录，但 `ExtensionReleaseCatalogLoader` 不对外暴露它的 href，
   * 因此在 load / adopt / repin 三处各记一次。
   */
  let currentHref: string | null = null;

  const ensureCatalog = async (): Promise<ExtensionReleaseRuntime | null> => {
    if (disposed) throw new ExtensionLoadError("evaluation", "extension runtime 已释放", false);
    if (runtime) return runtime;
    const catalog = await catalogLoader.load();
    if (catalog) currentHref ??= readExtensionReleaseHref();
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
    async adoptRelease(pointer) {
      if (disposed) throw new ExtensionLoadError("evaluation", "extension runtime 已释放", false);
      const pinned = runtime?.releaseId ?? catalogLoader.currentReleaseId();
      if (pointer.releaseId === adoptedReleaseId || (pointer.releaseId === pinned && adoptedReleaseId === null)) return null;
      if (!runtime) {
        // 目录尚未固定：让首次加载直接使用新目录。
        replaceReleaseLink(pointer.href);
        adoptedReleaseId = pointer.releaseId;
        return null;
      }
      currentHref = pointer.href;
      const next = await catalogLoader.peek(pointer.href);
      if (next.releaseId !== pointer.releaseId) {
        throw new ExtensionLoadError("invalid-catalog", "发布目录与指针不一致", false);
      }
      const result = extendReleaseRuntime(runtime, next, artifactLoader);
      runtime = result.runtime;
      adoptedReleaseId = pointer.releaseId;
      for (const id of [...result.delta.upgraded, ...result.delta.removed]) stale.add(id);
      // 升级后又回到原 artifact（回滚）：不再提示。
      for (const entry of next.entries) {
        const current = runtime.byId(entry.metadata.extensionId);
        if (current && current.artifactId === entry.artifactId) stale.delete(entry.metadata.extensionId);
      }
      log({ event: "extension-runtime-release-adopted", releaseId: pointer.releaseId, ...result.delta });
      return result.delta;
    },
    async refreshEntry(extensionId) {
      if (disposed) throw new ExtensionLoadError("evaluation", "extension runtime 已释放", false);
      const current = runtime?.byId(extensionId);
      if (!runtime || !current) return { changed: false, artifactId: null };
      // 读宿主**当前**发布目录，取这一个 id 的新条目；目录读不到就保持原条目，不抛错。
      let nextEntry: ExtensionBrowserReleaseEntry | null = null;
      try {
        const href = currentHref;
        if (!href) return { changed: false, artifactId: current.artifactId };
        const catalog = await catalogLoader.peek(href);
        nextEntry = catalog.entries.find((entry) => entry.metadata.extensionId === extensionId) ?? null;
      } catch (error) {
        log({ event: "extension-refresh-entry-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
        return { changed: false, artifactId: current.artifactId };
      }
      const result = replaceReleaseEntry(runtime, extensionId, nextEntry, artifactLoader);
      runtime = result.runtime;
      if (result.changed) {
        // 该 id 已切到新 artifact：它不再是「待重开」的升级条目。
        stale.delete(extensionId);
        log({ event: "extension-refresh-entry", extensionId, artifactId: nextEntry?.artifactId ?? null });
      }
      return { changed: result.changed, artifactId: nextEntry?.artifactId ?? null };
    },
    staleExtensionIds: () => [...stale].sort(),
    async repin(releaseHref) {
      if (disposed) throw new ExtensionLoadError("evaluation", "extension runtime 已释放", false);
      const catalog = await catalogLoader.repin(releaseHref);
      currentHref = releaseHref;
      runtime = createExtensionReleaseRuntime(catalog, artifactLoader);
      adoptedReleaseId = catalog.releaseId;
      stale.clear();
      diagnostics.clear();
      replaceReleaseLink(releaseHref);
      log({ event: "extension-runtime-repinned", releaseId: catalog.releaseId });
      return catalog.releaseId;
    },
    dispose() {
      disposed = true;
      artifactLoader.dispose();
      catalogLoader.dispose();
      runtime = null;
      diagnostics.clear();
      stale.clear();
    }
  };
}

/** 同步 HTML 上的发布 link（没有 document 的环境直接跳过）。 */
function replaceReleaseLink(href: string): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.head) return;
  let link = doc.querySelector(`link[rel="${EXTENSION_RELEASE_LINK_REL}"]`) as HTMLLinkElement | null;
  if (!link) {
    link = doc.createElement("link");
    link.rel = EXTENSION_RELEASE_LINK_REL;
    doc.head.append(link);
  }
  link.setAttribute("href", href);
}

/** 从发布目录 entry 取加载所需的运行时要求（诊断/测试）。 */
export function releaseEntryRequirements(entry: ExtensionBrowserReleaseEntry): {
  groups: readonly string[];
  exports: readonly string[];
} {
  return { groups: entry.requiredSdkGroups, exports: entry.requiredSdkExports };
}
