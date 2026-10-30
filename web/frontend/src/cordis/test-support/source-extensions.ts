/**
 * 源码型测试的显式 extension adapter（仅测试）
 * （change: 2026-10-12-build-and-load-extensions-independently，design D3 / 测试策略）
 *
 * 生产宿主构建**不再**扫描/编译 extension 业务源码，业务入口由发布目录在运行时加载。
 * extension 单元测试与 Showcase 仍可用**显式 source adapter** 消费同一公开宿主实现的业务 UI；
 * 该 adapter 只存在于 `test-support/`（生产构建不可达），不是独立产物验收证据。
 *
 * 这里直接 import 各 extension 的公开 `frontend` 入口 `descriptor`，与运行时 loader 得到的
 * `{ plugin }` 同构，因此测试路径与生产契约一致。
 */
import type { Plugin } from "@deepseek-ai/cordis";
import type {
  ApplicationExtensionFrontendAsyncEntry,
  ExtensionFrontendMetadata,
  ExtensionLoadDiagnostic
} from "@woohaa3/contracts";
import { canvasExtensionCatalogMetadata, createCanvasExtensionManifest, type ExtensionManifestOptions } from "../canvas-manifest.js";
import type { FrontendExtensionDefinition } from "../kernel.js";
import type { CanvasExtensionMetadata } from "../plugins/extension-manager/contract.js";
import type { ExtensionRuntimeEntry, ExtensionReleaseRuntime } from "../extension-runtime/runtime.js";
import type { ExtensionRuntimeService } from "../extension-runtime/service.js";
import { descriptor as taskActivityDescriptor, TASK_ACTIVITY_FRONTEND_METADATA } from "@woohaa3/extension-task-activity/frontend";

/** 源码型 adapter 覆盖的常驻与浏览器可选业务入口。 */
const SOURCE_BROWSER_LOCAL: ReadonlyArray<{
  metadata: ExtensionFrontendMetadata;
  plugin: () => Plugin;
}> = [
  {
    metadata: TASK_ACTIVITY_FRONTEND_METADATA,
    plugin: () => taskActivityDescriptor.plugin() as Plugin
  }
];

/** 发布目录纯 metadata 的测试投影（管理与装配派生用；保留历史 helper 名）。 */
export function sourceBrowserLocalMetadata(): CanvasExtensionMetadata[] {
  return SOURCE_BROWSER_LOCAL.map(({ metadata }) => ({
    id: metadata.extensionId,
    name: metadata.label,
    description: metadata.description,
    required: metadata.required,
    configurable: metadata.configScope === "browser-local" && !metadata.required,
    ...(metadata.defaultEnabled !== undefined ? { defaultEnabled: metadata.defaultEnabled } : {})
  }));
}

/** 运行时合并进 allowlist 的 browser-local optional ID。 */
export function sourceBrowserLocalConfigurableIds(): string[] {
  return SOURCE_BROWSER_LOCAL
    .filter(({ metadata }) => metadata.configScope === "browser-local" && !metadata.required)
    .map(({ metadata }) => metadata.extensionId);
}

/** 源码型业务 extension 定义（不做偏好过滤；调用方按需 filter）。 */
export function sourceExtensionDefinitions(): FrontendExtensionDefinition[] {
  return SOURCE_BROWSER_LOCAL.map(({ metadata, plugin }) => ({
    id: metadata.extensionId,
    required: metadata.required,
    configurable: metadata.configScope === "browser-local" && !metadata.required,
    name: metadata.label,
    description: metadata.description,
    plugin: plugin()
  }));
}

/** 源码型异步入口（供 registry/reconciler 测试；与发布目录 loader 同构）。 */
export function sourceExtensionEntries(): ApplicationExtensionFrontendAsyncEntry[] {
  return SOURCE_BROWSER_LOCAL.map(({ metadata, plugin }) => ({
    metadata: { ...metadata },
    async loadDescriptor() {
      return {
        extensionId: metadata.extensionId,
        configScope: metadata.configScope,
        activation: metadata.activation,
        plugin
      };
    }
  }));
}

/** Canvas 权威展示元数据（内置 + 源码型扩展）。 */
export function sourceCanvasCatalogMetadata(): CanvasExtensionMetadata[] {
  return canvasExtensionCatalogMetadata(sourceBrowserLocalMetadata());
}

/**
 * 等价于旧 `createCanvasExtensionManifest()` 的源码型版本：内置目录 + 全部源码型扩展
 * （不过滤偏好）。测试可继续断言完整业务 UI 装配，生产路径由发布目录派生。
 */
export function createSourceCanvasExtensionManifest(options: ExtensionManifestOptions = {}): FrontendExtensionDefinition[] {
  return createCanvasExtensionManifest({
    ...options,
    extensions: options.extensions ?? sourceExtensionDefinitions()
  });
}

/**
 * 源码型 `ExtensionRuntimeService`：与发布目录运行时同构，但实现直接来自源码 adapter。
 * 供 page-startup / selector / plugin-manager 测试复用（生产注入点相同）。
 */
export function createSourceExtensionRuntimeService(
  overrides: Partial<ExtensionRuntimeService> = {}
): ExtensionRuntimeService {
  const diagnostics = new Map<string, ExtensionLoadDiagnostic>();
  const byId = new Map(
    SOURCE_BROWSER_LOCAL.map(({ metadata, plugin }) => {
      const entry: ExtensionRuntimeEntry = {
        metadata,
        artifactId: `source-${metadata.extensionId}`,
        releaseEntry: {
          metadata,
          artifactId: `source-${metadata.extensionId}`,
          entryURL: `https://example.invalid/extensions/${metadata.extensionId}/source/entry.js`,
          styleURLs: [],
          protocolVersion: 1,
          sdkAbi: metadata.sdkAbi,
          reactMajor: 18,
          requiredSdkGroups: [],
          requiredSdkExports: []
        },
        async loadDescriptor() {
          return {
            extensionId: metadata.extensionId,
            configScope: metadata.configScope,
            activation: metadata.activation,
            plugin
          };
        }
      };
      return [metadata.extensionId, entry] as const;
    })
  );
  const runtime: ExtensionReleaseRuntime = {
    releaseId: "source-test-release",
    entries: [...byId.values()],
    byId: (extensionId) => byId.get(extensionId),
    browserLocalIds: () => sourceBrowserLocalConfigurableIds().sort()
  };
  return {
    async ensureCatalog() {
      return runtime;
    },
    current: () => runtime,
    // 源码型测试 runtime 没有发布目录，刷新条目是空操作（change: 2026-10-27-add-extension-dev-reload）。
    async refreshEntry() {
      return { changed: false, artifactId: null };
    },
    metadata: () => [...byId.values()].map((entry) => entry.metadata),
    entry: (extensionId) => byId.get(extensionId),
    async loadDescriptor(extensionId) {
      const entry = byId.get(extensionId);
      if (!entry) throw new Error(`源码型 runtime 不含扩展：${extensionId}`);
      diagnostics.set(extensionId, {
        extensionId,
        status: "registered",
        artifactId: entry.artifactId,
        releaseId: runtime.releaseId,
        errorCode: null,
        message: null
      });
      return entry.loadDescriptor();
    },
    diagnostics: () => [...diagnostics.values()],
    // 源码型 runtime 没有发布目录：热登记无事可做（不抛错，状态轮询会调用它）。
    async adoptRelease() {
      return null;
    },
    staleExtensionIds: () => [],
    // 源码型 runtime 没有发布目录可换：repin 明确拒绝（测试不应走到这里）。
    async repin() {
      throw new Error("源码型 runtime 不支持 repin");
    },
    report: (diagnostic) => {
      diagnostics.set(diagnostic.extensionId, diagnostic);
    },
    retry: (extensionId) => {
      diagnostics.delete(extensionId);
    },
    dispose() {
      diagnostics.clear();
    },
    ...overrides
  };
}
