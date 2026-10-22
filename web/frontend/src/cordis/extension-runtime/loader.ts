/**
 * Extension browser artifact loader
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 4.2–4.5 / design D7）。
 *
 * 只做**代码加载**，不创建 plugin/Fiber；安装资格由 page startup / reconciler 在拿到 descriptor
 * 后复验（design D7）。职责：
 * - 兼容性/required export 先检查（在实现求值前拒绝不兼容）；
 * - 并行准备 CSS 与 native 动态 import 薄入口；
 * - 绑定宿主 runtime 后调用 `loadExtension(bindings)`，校验 descriptor 与 metadata identity；
 * - App 级按 canonical entry URL 缓存成功 module；CSS 按 canonical URL 共享完成 Promise；
 * - 统一有限超时（缺省 15s）：超时使本任务失效，但延迟到达的 native import 仍只更新纯代码缓存。
 *
 * native import 不可取消；loader 不声称 timeout 终止网络，也不承诺清 Map 能重执行 ESM。
 */
import {
  decodeExtensionBrowserArtifactManifest,
  type ExtensionBrowserDescriptor,
  type ExtensionBrowserModule,
  type ExtensionBrowserReleaseEntry,
  type ExtensionLoadErrorCode,
  type ExtensionRuntimeBindings
} from "@woohaa3/contracts";
import { ExtensionRuntimeCompatibilityError, type ExtensionRuntimeProvider } from "./runtime-provider.js";
import { appPublicUrl } from "../services/app-base-path.js";

/** 缺省资源等待上限（不等于 Fiber/service 激活时间；design D7）。 */
export const DEFAULT_EXTENSION_LOAD_TIMEOUT_MS = 15_000;

/** 可重试的加载错误（网络/CSS/timeout）：不缓存用户态 rejected Promise。 */
export class ExtensionLoadError extends Error {
  readonly code: ExtensionLoadErrorCode;
  readonly retryable: boolean;
  constructor(code: ExtensionLoadErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ExtensionLoadError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** 一个成功加载、可复用的 module + 无副作用 descriptor 工厂。 */
export type LoadedExtensionArtifact = {
  extensionId: string;
  artifactId: string;
  /** 无副作用构造真实 Cordis plugin（安装时才调用）。 */
  createDescriptor(): ExtensionBrowserDescriptor;
  /**
   * 无副作用构造**设置专用**plugin（可选；change: 2026-10-17-move-settings-into-canvas-dialog）。
   *
   * 只装配 `settings.plugin-config` 贡献，不启动生成入口/画布事件/业务轮询。旧 artifact 缺该
   * 入口时返回 undefined，调用方 MUST NOT 回退执行完整 plugin。
   */
  createSettingsPlugin(): Plugin | undefined;
};

export type ExtensionArtifactLoaderOptions = {
  runtimeProvider: ExtensionRuntimeProvider;
  /** native importer（测试注入；缺省 `import(url)`，带 @vite-ignore）。 */
  importer?: (url: string) => Promise<unknown>;
  /** 样式准备（测试注入；缺省插入 <link> 并等待 load/error）。 */
  prepareStyles?: (urls: readonly string[]) => Promise<void>;
  /** clock（测试注入；缺省 Date.now）。 */
  now?: () => number;
  timeoutMs?: number;
  logger?: (event: Record<string, unknown>) => void;
};

export type ExtensionArtifactLoader = {
  /** 加载并校验一个发布 entry；返回无副作用的 descriptor 工厂。 */
  load(entry: ExtensionBrowserReleaseEntry): Promise<LoadedExtensionArtifact>;
  /** 已缓存的成功 module URL（诊断/测试）。 */
  cachedEntryURLs(): string[];
  dispose(): void;
};

/** 判定导入模块是否提供薄入口形状；错误信息含 extensionId（design implementation-guide）。 */
function readThinEntry(moduleValue: unknown, extensionId: string): ExtensionBrowserModule {
  const candidates = [moduleValue as Record<string, unknown>, (moduleValue as { default?: unknown })?.default as Record<string, unknown>];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && typeof candidate.loadExtension === "function") {
      return candidate as unknown as ExtensionBrowserModule;
    }
  }
  throw new ExtensionLoadError("evaluation", `extension "${extensionId}" 薄入口缺少 loadExtension()`, false);
}

export function createExtensionArtifactLoader(options: ExtensionArtifactLoaderOptions): ExtensionArtifactLoader {
  const importer = options.importer ?? ((url: string) => import(/* @vite-ignore */ url));
  const prepareStyles = options.prepareStyles ?? defaultPrepareStyles;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTENSION_LOAD_TIMEOUT_MS;
  const log = options.logger ?? (() => undefined);
  /** canonical entry URL → 成功 module Promise（App 级；key 含 runtime token）。 */
  const moduleCache = new Map<string, Promise<ExtensionBrowserModule>>();
  /** canonical style URL → 完成 Promise（App 级共享；失败从 cache 移除以便重试）。 */
  const styleCache = new Map<string, Promise<void>>();
  let disposed = false;

  const cacheKey = (entry: ExtensionBrowserReleaseEntry) =>
    `${String(options.runtimeProvider.token as object)}\u0000${entry.entryURL}`;

  const importModule = (entry: ExtensionBrowserReleaseEntry): Promise<ExtensionBrowserModule> => {
    const key = cacheKey(entry);
    const cached = moduleCache.get(key);
    if (cached) return cached;
    const pending = importer(appPublicUrl(entry.entryURL))
      .then((value) => readThinEntry(value, entry.metadata.extensionId))
      .catch((error: unknown) => {
        // 求值失败属于不可原地修复（native import 缓存可能固化）；移除以便显式重试时重新请求。
        moduleCache.delete(key);
        if (error instanceof ExtensionLoadError) throw error;
        throw new ExtensionLoadError(
          "evaluation",
          `extension "${entry.metadata.extensionId}" 模块求值失败`,
          false
        );
      });
    moduleCache.set(key, pending);
    return pending;
  };

  const prepareStyleURLs = (urls: readonly string[]): Promise<void> => {
    return Promise.all(
      urls.map((url) => {
        const cached = styleCache.get(url);
        if (cached) return cached;
        const pending = prepareStyles([appPublicUrl(url)]).catch((error: unknown) => {
          styleCache.delete(url);
          throw error instanceof ExtensionLoadError
            ? error
            : new ExtensionLoadError("css", `样式加载失败：${url}`, true);
        });
        styleCache.set(url, pending);
        return pending;
      })
    ).then(() => undefined);
  };

  const load = async (entry: ExtensionBrowserReleaseEntry): Promise<LoadedExtensionArtifact> => {
    if (disposed) throw new ExtensionLoadError("evaluation", "extension loader 已释放", false);
    const extensionId = entry.metadata.extensionId;
    // 1. 兼容性检查（不发请求）。
    if (entry.protocolVersion !== 1) {
      throw new ExtensionLoadError("abi", `extension "${extensionId}" 协议版本不兼容`, false);
    }
    if (entry.sdkAbi !== options.runtimeProvider.sdkAbi) {
      throw new ExtensionLoadError("abi", `extension "${extensionId}" SDK ABI 不匹配`, false);
    }
    if (entry.reactMajor !== options.runtimeProvider.reactMajor) {
      throw new ExtensionLoadError("abi", `extension "${extensionId}" React major 不匹配`, false);
    }

    const startedAt = now();
    const timeout = new Promise<never>((_, reject) => {
      const handle = setTimeoutRef(() => {
        reject(new ExtensionLoadError("timeout", `extension "${extensionId}" 资源等待超时`, true));
      }, timeoutMs);
      // 不阻止 Node 进程退出（vitest/node 环境）。
      (handle as { unref?: () => void }).unref?.();
    });

    const work = (async (): Promise<LoadedExtensionArtifact> => {
      // 2. 并行：native import 薄入口 + CSS 准备。
      const [moduleValue] = await Promise.all([importModule(entry), prepareStyleURLs(entry.styleURLs)]);
      // 3. 绑定宿主 runtime（实现求值前完成绑定）。
      let bindings: ExtensionRuntimeBindings;
      try {
        bindings = await options.runtimeProvider.prepareBindings({
          sdkAbi: entry.sdkAbi,
          reactMajor: entry.reactMajor,
          groups: entry.requiredSdkGroups,
          exports: entry.requiredSdkExports
        });
      } catch (error) {
        if (error instanceof ExtensionRuntimeCompatibilityError) {
          throw new ExtensionLoadError("abi", error.message, false);
        }
        throw error;
      }
      // 4. 加载实现并校验 descriptor identity。
      const loaded = await moduleValue.loadExtension(bindings);
      const descriptor = loaded?.descriptor;
      if (!descriptor || typeof descriptor !== "object" || typeof descriptor.plugin !== "function") {
        throw new ExtensionLoadError("descriptor", `extension "${extensionId}" descriptor 非法`, false);
      }
      if (descriptor.extensionId !== extensionId) {
        throw new ExtensionLoadError(
          "descriptor",
          `extension "${extensionId}" descriptor identity 不符`,
          false
        );
      }
      if (descriptor.configScope !== undefined && descriptor.configScope !== entry.metadata.configScope) {
        throw new ExtensionLoadError("descriptor", `extension "${extensionId}" configScope 不符`, false);
      }
      if (descriptor.activation !== undefined && descriptor.activation !== entry.metadata.activation) {
        throw new ExtensionLoadError("descriptor", `extension "${extensionId}" activation 不符`, false);
      }
      log({ event: "extension-artifact-loaded", extensionId, artifactId: entry.artifactId, ms: now() - startedAt });
      return {
        extensionId,
        artifactId: entry.artifactId,
        createDescriptor: () => descriptor,
        createSettingsPlugin: () => {
          if (typeof descriptor.settingsPlugin !== "function") return undefined;
          return descriptor.settingsPlugin() as unknown as Plugin;
        }
      };
    })();

    return Promise.race([work, timeout]);
  };

  return {
    load,
    cachedEntryURLs: () => [...moduleCache.keys()].map((key) => key.split("\u0000")[1] ?? key),
    dispose() {
      disposed = true;
      moduleCache.clear();
      styleCache.clear();
    }
  };
}

/** 缺省样式准备：插入 <link> 并等待 load；失败移除 link 后抛可重试 CSS 错误。 */
async function defaultPrepareStyles(urls: readonly string[]): Promise<void> {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return;
  for (const url of urls) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.dataset.woohaaExtensionStyle = url;
    await new Promise<void>((resolve, reject) => {
      link.addEventListener("load", () => resolve(), { once: true });
      link.addEventListener(
        "error",
        () => {
          link.remove();
          reject(new ExtensionLoadError("css", `样式加载失败：${url}`, true));
        },
        { once: true }
      );
      doc.head.appendChild(link);
    });
  }
}

/** setTimeout 引用；测试可用 vitest fake timers。 */
function setTimeoutRef(callback: () => void, ms: number): unknown {
  return (globalThis as { setTimeout: (cb: () => void, ms: number) => unknown }).setTimeout(callback, ms);
}

/** artifact manifest 严格解码转发（builder/assembly 与 loader 共用一份契约）。 */
export { decodeExtensionBrowserArtifactManifest };
