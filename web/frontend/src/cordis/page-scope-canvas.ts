/**
 * Canvas page scope 启动器（自 `page-scope.ts` 拆出）
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，
 *  规模门禁 ≤500 行；沿用 change: 2026-10-09-... 的分层方式）。
 *
 * 只负责**在创建 scope 之前**读取一次有效 optional 选择并装配 Canvas page scope：
 * - 获取并固定发布目录（App 级缓存；缺失视为无扩展能力，不禁用核心）；
 * - 读一次本地选择，派生启动选择（always + 已启用 browser-local optional）；
 * - required 资源加载失败即 page 失败；optional 失败隔离并进入诊断；
 * - server-active 只登记 metadata（由 reconciler 按服务端状态驱动加载）。
 *
 * 不拥有 App scope 生命周期或路由；调用方（page-scope）拥有返回 runtime 的 dispose。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  ApplicationExtensionFrontendAsyncEntry,
  ExtensionLoadDiagnostic
} from "@woohaa3/contracts";
import { startFrontendScope, type FrontendExtensionDefinition, type FrontendRuntime } from "./kernel.js";
import { installCanvasPageServices } from "./install-services.js";
import { createCanvasExtensionManifest, canvasExtensionCatalogMetadata, resolveConfigurableOptionalIds } from "./manifest.js";
import { isAssembledAtStartup } from "./services/extension-preferences/selector.js";
import { ExtensionPreferenceStore } from "./services/extension-preferences/store.js";
import type { FrontendExtensionPreferences, PreferenceStorage } from "./services/extension-preferences/codec.js";
import type { ExtensionRuntimeService } from "./extension-runtime/service.js";
import { extensionDefaultPreferences, resolveExtensionStartupSelection } from "./extension-runtime/selection.js";
import type { CanvasExtensionMetadata } from "./plugins/extension-manager/contract.js";
import { createCanvasSettingsAssembly } from "./plugins/settings/extension-settings-assembly.js";
import { settingsPlugin, SETTINGS_PLUGIN_ID } from "./plugins/settings/plugin.js";
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";

/** 业务 extension 的展示元数据投影（纯数据；不含实现）。 */
export function extensionCatalogMetadata(metadata: readonly ExtensionFrontendMetadata[]): CanvasExtensionMetadata[] {
  return metadata.map((entry) => ({
    id: entry.extensionId,
    name: entry.label,
    description: entry.description,
    directory: entry.directory,
    required: entry.required,
    configurable: entry.configScope === "browser-local" && !entry.required,
    ...(entry.defaultEnabled !== undefined ? { defaultEnabled: entry.defaultEnabled } : {})
  }));
}

export type CanvasPageScopeStarterInput = {
  /** App scope 的 Cordis Context（page scope 的 parent）。 */
  appCtx: Context;
  runtimeService: ExtensionRuntimeService;
  /** 旧版浏览器偏好的读取介质：**只用于一次性迁移**到宿主配置文件；null 表示跳过迁移。 */
  preferenceStorage?: PreferenceStorage | null | undefined;
  /**
   * 当前生效的 browser-local 启停目标状态（来自宿主配置文件 `extensions.frontend.*`）。
   * 缺省表示宿主未提供：按各插件 metadata 的 `defaultEnabled`（再缺省启用），兼容旧宿主。
   */
  frontendExtensions?: FrontendExtensionPreferences | undefined;
  /**
   * 写入一个 browser-local 插件启停目标状态（生产实现写宿主配置文件）。
   * 缺省表示当前宿主不支持保存：面板只读。
   */
  persistFrontendExtension?: (id: string, enabled: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 测试注入的刷新适配；缺省页面 reload。 */
  extensionManagerReload?: () => void;
};
/**
 * 构造 `startCanvasPageScope(canvasId)`：装配并返回 Canvas page scope runtime。
 * 返回的 runtime 的 `dispose` 同时释放本页创建的偏好存储。
 */
export function createCanvasPageScopeStarter(
  input: CanvasPageScopeStarterInput
): (canvasId: string) => Promise<FrontendRuntime> {
  const { appCtx, runtimeService } = input;
  return async (canvasId: string): Promise<FrontendRuntime> => {
    // 1. 获取并固定发布目录（App 级缓存；缺失视为无扩展能力，不禁用核心）。
    const release = await runtimeService.ensureCatalog();
    const metadata = release?.entries.map((entry) => entry.metadata) ?? [];
    const runtimeCatalogIds = release?.browserLocalIds() ?? [];
    const configurableIds = resolveConfigurableOptionalIds(runtimeCatalogIds);
    const catalogMetadata = canvasExtensionCatalogMetadata(extensionCatalogMetadata(metadata));

    // 2. 目标状态来自宿主配置文件（`extensions.frontend.<id>.enabled`），不再自持 localStorage。
    //    旧版本遗留在浏览器里的显式选择只做一次性迁移：写回宿主配置后不再读取。
    const preferenceStore = new ExtensionPreferenceStore({
      ids: configurableIds,
      defaults: extensionDefaultPreferences(metadata),
      ...(input.frontendExtensions !== undefined ? { desired: input.frontendExtensions } : {}),
      ...(input.persistFrontendExtension !== undefined ? { persist: input.persistFrontendExtension } : {})
    });
    const desired = preferenceStore.getSnapshot().preferences;
    const selectionResult = resolveExtensionStartupSelection({ metadata, desired });
    // 内置 optional（node-history）沿用既有 selector 语义。
    const builtinAssembled: Record<string, boolean> = {};
    for (const entry of catalogMetadata) {
      if (!entry.configurable) continue;
      builtinAssembled[entry.id] = desired[entry.id] ?? entry.defaultEnabled ?? true;
    }

    // 3. 只加载 always + 已启用 browser-local optional；required 失败即 page 失败，optional 失败隔离。
    const loadedDefinitions: FrontendExtensionDefinition[] = [];
    const loadDiagnostics: ExtensionLoadDiagnostic[] = [];
    const loadResults = await Promise.all(
      selectionResult.load.map(async (entry) => {
        try {
          const descriptor = await runtimeService.loadDescriptor(entry.extensionId);
          return { entry, descriptor, error: null as Error | null };
        } catch (error) {
          return { entry, descriptor: null, error: error instanceof Error ? error : new Error(String(error)) };
        }
      })
    );
    for (const result of loadResults) {
      if (result.descriptor) {
        loadedDefinitions.push({
          id: result.entry.extensionId,
          required: result.entry.required,
          configurable: result.entry.configScope === "browser-local",
          name: result.entry.label,
          description: result.entry.description,
          plugin: result.descriptor.plugin(),
          extension: true
        });
      } else if (result.entry.required) {
        // required 资源加载失败：进入稳定 page error，不挂载半可用画布。
        throw new Error(`required extension "${result.entry.extensionId}" 资源加载失败：${result.error?.message ?? "未知错误"}`);
      } else {
        loadDiagnostics.push({
          extensionId: result.entry.extensionId,
          status: "load-failed",
          artifactId: null,
          releaseId: release?.releaseId ?? null,
          errorCode: "network",
          // 真实原因优先：设置面「启动失败」要靠它说明为什么，而不是再让人猜。
          message: result.error?.message ?? "功能加载失败，请重试"
        });
      }
    }

    // 4. server-active 只登记 metadata（由 reconciler 按服务端状态驱动加载）。
    const serverActiveEntries: ApplicationExtensionFrontendAsyncEntry[] = selectionResult.registered.map((entry) => ({
      metadata: entry,
      async loadDescriptor() {
        return runtimeService.loadDescriptor(entry.extensionId);
      }
    }));

    // 可选入口加载失败必须在管理面板显示「启动失败」，不能沿用目标启用显示为「已启用」。
    const failedOptionalIds = new Set(loadDiagnostics.map((diagnostic) => diagnostic.extensionId));
    const optionalFailures: Record<string, string> = {};
    for (const diagnostic of loadDiagnostics) optionalFailures[diagnostic.extensionId] = diagnostic.message ?? "加载失败";

    // 设置专项扩展装配：只允许未激活扩展按需装配 settings-only 贡献
    // （change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.2）。
    const staticallyAssembled = new Set([
      ...loadedDefinitions.map((definition) => definition.id),
      ...selectionResult.registered.map((entry) => entry.extensionId)
    ]);
    const settingsAssembly = createCanvasSettingsAssembly({
      runtime: runtimeService,
      staticallyAssembled
    });

    const manifest = createCanvasExtensionManifest({
      canvasId,
      catalogMetadata,
      configurableOptionalIds: configurableIds,
      extensions: loadedDefinitions,
      settingsAssembly: settingsAssembly.assembly,
      extensionManager: {
        assembled: { ...builtinAssembled, ...selectionResult.assembled },
        failed: failedOptionalIds,
        failures: optionalFailures,
        catalog: catalogMetadata,
        ids: configurableIds,
        preferenceStore,
        ...(input.extensionManagerReload ? { reload: input.extensionManagerReload } : {})
      }
    });
    const assembled = { ...builtinAssembled, ...selectionResult.assembled };
    const plugins = manifest.filter((definition) => isAssembledAtStartup(definition, assembled));
    const disabled = Object.entries(assembled)
      .filter(([, enabled]) => !enabled)
      .map(([id]) => ({ id, reason: "未启用该可选插件" }));

    const runtime = await startFrontendScope(appCtx, {
      install: async (ctx) => {
        await installCanvasPageServices(ctx, {
          canvasId,
          extensionRuntime: runtimeService,
          serverActiveEntries,
          loadDiagnostics
        });
        // 设置装配在 scope install 之后才可能真正加载（此时 ctx 已有 settingsRemote 等）。
        settingsAssembly.attach(ctx);
      },
      plugins,
      disabled,
      isolate: [
        "canvasRemote",
        "taskRemote",
        "applicationRemote",
        "mediaRemote",
        "canvasSession",
        "canvasScope",
        "canvasState",
        "imageLibrary",
        "inputScopes",
        "taskCatalog",
        "selection",
        "parameterPreview",
        "modelInteractions",
        "canvasNavigation"
      ]
    });
    // 配置热生效：宿主配置文件里的启停变化经订阅推到这里，装回或卸下对应 fiber，
    // 不重建页面 scope（区别于旧的「下次启动生效」）。
    const loadedIds = new Set(loadedDefinitions.map((definition) => definition.id));
    const swappableById = new Map<string, FrontendExtensionDefinition>();
    for (const definition of loadedDefinitions) {
      if (!definition.required) swappableById.set(definition.id, definition);
    }
    const unsubscribes: Array<() => void> = [];
    const applyPreferences = async (): Promise<void> => {
      const snapshot = preferenceStore.getSnapshot().preferences;
      for (const [id, definition] of swappableById) {
        const shouldRun = snapshot[id] ?? true;
        const running = runtime.plugins?.has(id) ?? false;
        if (shouldRun && !running) {
          // 此前未加载过实现（启动时被禁用）：现在才去取 artifact。
          if (!loadedIds.has(id)) {
            try {
              const descriptor = await runtimeService.loadDescriptor(id);
              definition.plugin = descriptor.plugin();
              loadedIds.add(id);
            } catch {
              // 加载失败保持未装配；下一次配置变化或重新打开页面会再试。
              continue;
            }
          }
          runtime.plugins?.enable(definition);
        } else if (!shouldRun && running) {
          await runtime.plugins?.disable(id);
        }
      }
    };
    unsubscribes.push(preferenceStore.subscribe(() => void applyPreferences()));

    const disposeRuntime = runtime.dispose;
    return {
      ...runtime,
      async dispose() {
        for (const off of unsubscribes) off();
        settingsAssembly.assembly.dispose();
        await disposeRuntime();
        preferenceStore.dispose();
      }
    };
  };
}

/**
 * 画布壳（空壳 / 准备中 / 恢复页）的设置能力
 * （change: 2026-10-17-move-settings-into-canvas-dialog，design D1）。
 *
 * 无法打开画布（目录失败、显式不存在或旧 ID 迁移中）时仍要能读配置：只装配设置插件与其所需
 * 的最小 remote，不创建作品、Canvas Session、sync socket 或 Bevy。
 */
export function createCanvasShellSettingsPlugin(): FrontendExtensionDefinition {
  return {
    id: SETTINGS_PLUGIN_ID,
    required: false,
    plugin: settingsPlugin({})
  };
}
