/**
 * Plugin Manager Plugin（required Canvas Plugin）
 * （change: add-frontend-plugin-manager，任务 4.1–4.4 / design D5/D6；
 *   change: 2026-10-16-consolidate-canvas-settings-entries：画布不再注册入口与弹窗）。
 *
 * 画布 scope 只保留管理**数据层**：把浏览器本地偏好、站点插件状态与生成模型状态投影为 facade，
 * 经 `ctx.provide("extensionManager")` 提供给本 scope 的消费者。插件管理的界面（插件树卡片 +
 * 配置弹窗）归设置页「插件配置」，由 settings page scope 用同一份数据层自建 facade；本插件
 * MUST NOT 再注册 Canvas 左下角入口或第二套管理弹窗。
 *
 * facade 只保存「目标状态」（browser-local 偏好）；本次启动的实际装配状态来自 composition root
 * 注入的 `assembled`。修改开关不 dispose/重装当前 Context 中的 Plugin——写入的目标状态由下一次
 * Canvas scope 启动读取，composition root 在创建 page scope 前过滤清单。
 *
 * required 身份保证 optional 功能全部关闭后仍有恢复入口；恢复入口现在是画布左下角的「设置」
 * （设置页「插件配置」），不再是画布内的管理弹窗。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { canvasExtensionCatalogMetadata, CONFIGURABLE_OPTIONAL_PLUGIN_IDS } from "../../canvas-manifest.js";
import type { ExtensionPreferenceStore } from "../../services/extension-preferences/store.js";
import { createExtensionManagerFacade } from "./facade.js";
import type { CanvasExtensionMetadata } from "./contract.js";
import type { PluginIcon } from "@woohaa3/contracts";
import type { ApplicationExtensionStatusService } from "../../services/application-extension-status.js";
import type { GenerationModelsStatusService } from "../../services/generation-models-status.js";

export const EXTENSION_MANAGER_ID = "extension-manager";

export type SiteExtensionManagerOptions = {
  /** 站点插件可信元数据（服务端清单投影；缺省为空）。 */
  metadata?: readonly { extensionId: string; name: string; description: string; directory?: string; icon?: PluginIcon }[];
  /** 站点插件状态 Service（服务端权威状态）。 */
  statusService?: ApplicationExtensionStatusService;
  /** 当前用户是否有站点管理权限（仅 UI 提示；服务端仍二次授权）。 */
  canManageSite?: boolean;
};

export type ExtensionManagerOptions = {
  /**
   * **当前**实际装配状态（composition root 注入；缺省按全启用）。
   *
   * 传函数时每次读都是最新值——热插拔后无需重建面板就能反映真相。
   */
  assembled?: Readonly<Record<string, boolean>> | (() => Readonly<Record<string, boolean>>);
  /** 本次启动加载失败的 browser-local optional ID（显示为「启动失败」而非「已启用」）。 */
  failed?: ReadonlySet<string>;
  /** 失败原因（extensionId → message）；设置面把它显示在状态提示与详情里。 */
  failures?: Readonly<Record<string, string>>;
  /** Canvas 权威目录（缺省读静态清单；测试可注入）。 */
  catalog?: readonly CanvasExtensionMetadata[];
  /** 可配置 optional allowlist（缺省静态 allowlist；测试可注入）。 */
  ids?: readonly string[];
  /** 写入宿主配置的实现（生产实现写 `extensions.frontend.<id>.enabled`）。 */
  persist?: (id: string, enabled: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Composition root 注入的偏好 store（与本次启动选择同一实例）。缺省时 Plugin Manager
   * 自建一个；注入时 store 所有权仍归 composition root（Plugin Manager 不 dispose）。
   */
  preferenceStore?: ExtensionPreferenceStore;
  /** 测试注入的刷新适配；缺省 `globalThis.location.reload()`。 */
  reload?: () => void;
  /** 站点插件管理注入（change: 2026-10-04-add-backend-plugin-extensions）。 */
  site?: SiteExtensionManagerOptions;
};

export function extensionManagerPlugin(options: ExtensionManagerOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const { facade, dispose } = createExtensionManagerFacade({
        catalog: options.catalog ?? canvasExtensionCatalogMetadata(),
        ids: options.ids ?? CONFIGURABLE_OPTIONAL_PLUGIN_IDS,
        assembled: options.assembled ?? {},
        ...(options.failed ? { failed: options.failed } : {}),
        ...(options.failures ? { failures: options.failures } : {}),
        ...(options.preferenceStore ? { preferenceStore: options.preferenceStore } : {}),
        ...(options.persist ? { persist: options.persist } : {}),
        refresh: options.reload ?? defaultReload,
        site: {
          ...(options.site?.metadata ? { metadata: options.site.metadata } : {}),
          statusService:
            options.site?.statusService ??
            (ctx.get("applicationExtensionStatus" as never) as ApplicationExtensionStatusService | undefined),
          canManageSite: options.site?.canManageSite ?? false
        },
        generationModels: ctx.get("generationModelsStatus" as never) as GenerationModelsStatusService | undefined
      });

      ctx.provide("extensionManager" as never, facade as never);

      return () => {
        dispose();
      };
    },
    { name: EXTENSION_MANAGER_ID, inject: [] }
  );
}

/** 生产刷新适配：刷新当前应用（保留已写入的 browser-local 目标配置）。 */
function defaultReload(): void {
  globalThis.location?.reload();
}
