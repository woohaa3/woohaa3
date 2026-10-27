/**
 * 插件管理数据层：把浏览器本地偏好、站点插件状态与生成模型状态投影为 panel 快照。
 *
 * 设置页「插件配置」与画布 scope 的 extensionManager capability 共用（change:
 * 2026-10-16-consolidate-canvas-settings-entries：两者只在「本次装配状态」与「应用动作」上不同；
 * 画布不再有管理界面）。
 */
import type { PluginIcon } from "@woohaa3/contracts";
import { ExtensionPreferenceStore } from "../../services/extension-preferences/store.js";
import {
  hasPendingExtensionChanges,
  isSiteRowBusy,
  projectExtensionManagerRows,
  siteActualStateLabel
} from "./projection.js";
import type {
  CanvasExtensionMetadata,
  ExtensionManagerFacade,
  ExtensionManagerView,
  ExtensionModelRow,
  ExtensionSiteRow
} from "./contract.js";
import type { ApplicationExtensionStatusService, ApplicationExtensionCatalogSummary } from "../../services/application-extension-status.js";
import type { GenerationModelsStatusService } from "../../services/generation-models-status.js";

const EMPTY_PROVIDER_EXTENSIONS: ReadonlySet<string> = new Set();

export type ExtensionManagerFacadeOptions = {
  catalog: readonly CanvasExtensionMetadata[];
  ids: readonly string[];
  /**
   * 当前**实际装配**状态。
   *
   * 可以是静态快照（启动时），也可以是函数（热插拔后实时读取）——插件开关现在是
   * 立即生效的，用启动快照会算出过时的 `pending-*` 状态，让面板显示「重启后生效」。
   */
  assembled: Readonly<Record<string, boolean>> | (() => Readonly<Record<string, boolean>>);
  failed?: ReadonlySet<string>;
  /** 失败原因（extensionId → message）；只影响展示。 */
  failures?: Readonly<Record<string, string>>;
  /** 注入时所有权仍归调用方（不随 facade 释放）。 */
  preferenceStore?: ExtensionPreferenceStore;
  /** 写入宿主配置的实现；缺省时面板只读（保留最后成功值）。 */
  persist?: (id: string, enabled: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  refresh: () => void;
  site?: {
    metadata?: readonly { extensionId: string; name: string; description: string; directory?: string; icon?: PluginIcon }[];
    statusService?: ApplicationExtensionStatusService;
    canManageSite?: boolean | (() => boolean);
    /**
     * Provider 类站点插件 id（声明了 `providers.<providerId>` 配置段）。它们的启停跟着配置走，
     * 不出现在站点插件清单里；来源是设置快照里各配置段的 `ownerExtensionId`。
     */
    providerExtensions?: () => ReadonlySet<string>;
  };
  generationModels?: GenerationModelsStatusService;
};

export function createExtensionManagerFacade(options: ExtensionManagerFacadeOptions): { facade: ExtensionManagerFacade; notify: () => void; dispose: () => void } {
  const { catalog, ids } = options;
  /** 每次读取都是当前装配状态：热插拔后无需重建 facade 也能看到真相。 */
  const assembledOf = (): Readonly<Record<string, boolean>> =>
    typeof options.assembled === "function" ? options.assembled() : options.assembled;
  const failed = options.failed ?? new Set<string>();
  const ownedStore = options.preferenceStore === undefined;
  const store =
    options.preferenceStore ??
    new ExtensionPreferenceStore({
      ids,
      ...(options.persist ? { persist: options.persist } : {})
    });

  const listeners = new Set<() => void>();
  let error: string | null = null;
  let cached: ExtensionManagerView | null = null;

  const siteMetadata = options.site?.metadata ?? [];
  const statusService = options.site?.statusService;
  const manageOption = options.site?.canManageSite;
  const canManageSite = (): boolean => (typeof manageOption === "function" ? manageOption() : manageOption ?? false);
  const generationModelsService = options.generationModels;
  const providerExtensionIds = (): ReadonlySet<string> => options.site?.providerExtensions?.() ?? EMPTY_PROVIDER_EXTENSIONS;
  /** 发布目录 metadata 里声明的图标：站点行按 extensionId 取用。 */
  const catalogIcons = new Map<string, PluginIcon>(
    catalog.flatMap((entry) => (entry.icon ? [[entry.id, entry.icon] as const] : []))
  );

  const modelRows = (): ExtensionModelRow[] => {
    const snapshot = generationModelsService?.getSnapshot();
    return (snapshot?.models ?? []).map((model) => ({
      modelKey: model.modelKey,
      providerId: model.providerId,
      modelType: model.modelType,
      title: model.title ?? model.modelKey,
      enabled: model.enabled,
      isDefault: model.isDefault,
      executable: model.executable,
      tombstone: model.tombstone ?? false,
      // 可选字段原样透传：旧宿主没有它（缺省语义 = 只能按 providerId 归组）。
      ...(model.extensionId !== undefined ? { extensionId: model.extensionId } : {})
    }));
  };
  const siteRows = (): ExtensionSiteRow[] => {
    const snapshot = statusService?.getSnapshot();
    const byId = new Map((snapshot?.plugins ?? []).map((status) => [status.extensionId, status]));
    // 可信清单以服务端 snapshot 为准；测试/静态渲染可注入 metadata。
    const serverCatalog: ApplicationExtensionCatalogSummary[] = snapshot?.catalog ?? [];
    const entries: readonly { extensionId: string; name: string; description: string; directory?: string; icon?: PluginIcon }[] =
      siteMetadata.length > 0
        ? siteMetadata
        : serverCatalog.map((entry) => ({
            extensionId: entry.extensionId,
            name: entry.name,
            description: entry.description,
            ...(entry.directory ? { directory: entry.directory } : {})
          }));
    return entries.map((entry) => {
      const status = byId.get(entry.extensionId);
      // 站点服务端的公开摘要不含图标：用发布目录 metadata（同一 extensionId）里声明的图标补上。
      const icon = entry.icon ?? catalogIcons.get(entry.extensionId);
      return {
        extensionId: entry.extensionId,
        name: entry.name,
        description: entry.description,
        ...(entry.directory ? { directory: entry.directory } : {}),
        ...(icon ? { icon } : {}),
        desiredEnabled: status?.desiredEnabled ?? false,
        actualState: status?.actualState ?? "unconfigured",
        actualStateLabel: siteActualStateLabel(status?.actualState ?? "unconfigured"),
        diagnostics: (status?.diagnostics ?? []).map((diagnostic) => diagnostic.message),
        busy: isSiteRowBusy(status?.actualState ?? "unconfigured"),
        providerManaged: providerExtensionIds().has(entry.extensionId)
      };
    });
  };

  const compute = (): ExtensionManagerView => {
    const snapshot = store.getSnapshot();
    const desired = snapshot.preferences;
    return {
      rows: projectExtensionManagerRows(catalog, {
        assembled: assembledOf(),
        desired,
        failed,
        ...(options.failures ? { failures: options.failures } : {})
      }),
      siteRows: siteRows(),
      modelRows: modelRows(),
      siteManageable: canManageSite(),
      siteError: statusService?.getSnapshot().error ?? null,
      pending: hasPendingExtensionChanges(catalog, { assembled: assembledOf(), desired }),
      persistenceMessage: snapshot.persistenceAvailable
        ? null
        : (snapshot.diagnostic?.detail ?? "浏览器拒绝持久化，设置无法保存"),
      error
    };
  };
  const notify = () => {
    cached = null;
    for (const listener of listeners) listener();
  };

  const unsubscribeStatus = statusService?.subscribe(notify);
  const unsubscribeModels = generationModelsService?.subscribe(notify);
  // 目标状态变化（面板开关、宿主配置热更新）也要重建快照：否则行状态与 pending 停在旧值。
  const unsubscribePreferences = store.subscribe(notify);

  const facade: ExtensionManagerFacade = {
    getSnapshot: () => (cached ??= compute()),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEnabled: (id, enabled) => {
      // browser-local：只改浏览器本地偏好，下次启动按新选择装配（不提交站点配置）。
      const result = store.setEnabled(id, enabled);
      error = result.ok ? null : result.error;
      notify();
    },
    refresh: () => options.refresh(),
    setSiteEnabled: (id, enabled) => {
      // 站点插件：写服务端权威状态，控制面按版本激活/停用，运行中生效。
      if (!statusService || !canManageSite()) return;
      void statusService
        .writeConfig({ extensionId: id, enabled, values: {}, secretRefs: [] })
        .then((outcome) => {
          error = outcome.ok ? null : (outcome.error ?? "插件启停操作失败");
          notify();
          return undefined;
        })
        .catch(() => {
          error = "插件启停操作失败";
          notify();
        });
    },
    siteRows,
    canManageSite,
    modelRows,
    refreshModels: async () => {
      await generationModelsService?.refresh();
      notify();
    },
    setModelEnabled: (modelKey, enabled) => {
      if (!generationModelsService || !canManageSite()) return;
      void generationModelsService.setEnabled(modelKey, enabled).then((outcome) => {
        error = outcome.ok ? null : (outcome.error ?? "生成模型操作失败");
        notify();
      });
    },
    setModelsEnabled: (modelKeys, enabled) => {
      if (!generationModelsService || !canManageSite()) return;
      void generationModelsService.setEnabledMany(modelKeys, enabled).then((outcome) => {
        error = outcome.ok ? null : (outcome.error ?? "生成模型操作失败");
        notify();
      });
    },
    setModelDefault: (modelKey, modelType) => {
      if (!generationModelsService || !canManageSite()) return;
      void generationModelsService.setDefault(modelKey, modelType).then((outcome) => {
        error = outcome.ok ? null : (outcome.error ?? "生成模型操作失败");
        notify();
      });
    }
  };

  return {
    facade,
    notify,
    dispose() {
      unsubscribePreferences();
      if (ownedStore) store.dispose();
      unsubscribeStatus?.();
      unsubscribeModels?.();
      listeners.clear();
    }
  };
}
