/**
 * Settings Plugin（required Canvas Plugin）
 * （change: 2026-10-17-move-settings-into-canvas-dialog，design D1/D2/D4）。
 *
 * 设置是**画布壳内**的唯一大型模态工作区，不再是独立 `/settings` 页面：
 * - 本插件注册 `settings` singleton Dialog 与轻量打开能力（`settingsOpen` capability）；标题栏入口、
 *   兼容地址与其它指路操作都调用同一能力，普通开关不改变地址或浏览器历史；
 * - 配置 store 由本插件持有，复用当前 scope 的 `settingsRemote`、应用插件状态与生成模型状态，
 *   不新建 poller/socket；
 * - 弹窗内容按首次打开加载（不在画布启动时预取设置 UI）；
 * - 打开设置不依赖 Bevy ready、Canvas 可写或任何可选业务扩展成功；
 * - 所有关闭来源（X / Escape / 遮罩 / 业务请求）经 Dialog Host 的 close guard：dirty 时先确认
 *   「继续编辑 / 放弃修改」，写请求进行中直接拒绝；内部导航复用同一门禁；
 * - 关闭只丢弃本地草稿与设置专用资源，不刷新页面、不重启宿主、不重装插件。
 */
import { lazy, Suspense } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";
import { createBackendSettingsStore, withRuntimeStateRefresh } from "./backend-settings-store.js";
import { providerExtensionIds } from "./plugin-groups.js";
import { createExtensionManagerFacade } from "../extension-manager/facade.js";
import type { CanvasExtensionMetadata } from "../extension-manager/contract.js";
import type { ExtensionPreferenceStore } from "../../services/extension-preferences/store.js";
import type { ApplicationExtensionStatusService } from "../../services/application-extension-status.js";
import type { GenerationModelsStatusService } from "../../services/generation-models-status.js";
import type { SettingsRemote } from "../../services/settings-remote.js";
import type { TaskNotificationService } from "../../contract/notification.js";
import { createSettingsEditSession, type SettingsEditSession } from "./edit-session.js";
import type { SettingsPanelSource } from "./plugin-panels.js";
import { SETTINGS_DIALOG_ID, SETTINGS_DIALOG_TITLE_ID, SettingsDialogChrome } from "./workspace/settings-dialog-chrome.js";
import { SETTINGS_ENTRY_PLUGIN_ID } from "./entry.js";
import { createExtensionInstallRemote } from "../../services/extension-install-remote.js";
import { createManagedExtensionsController } from "./managed-extensions.js";
import { createMarketplaceInstallController, TRUSTED_KEYS_SETTING } from "./marketplace-install.js";
import { createMarketplaceRemote } from "../../services/marketplace-remote.js";
import type { ManagedExtensionsSource } from "./plugin-settings-section.js";

export const SETTINGS_PLUGIN_ID = "settings";
export { SETTINGS_DIALOG_ID, SETTINGS_DIALOG_TITLE_ID, SETTINGS_ENTRY_PLUGIN_ID };

/** 设置内容按首次打开加载（不进画布启动包）。 */
const SettingsWorkspace = lazy(() =>
  import("./workspace/settings-workspace.js").then((module) => ({ default: module.SettingsWorkspace }))
);

export type SettingsSectionId = "backend" | "plugins" | "appearance" | "runtimes";

/**
 * 设置专用扩展装配（change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.2）。
 *
 * 只装配 `settings.plugin-config` 贡献：已激活扩展直接复用；未激活但声明设置能力的扩展由
 * `load()` 按需构造 settings-only 工厂；旧 artifact 无设置入口时给出原因，不回退完整 plugin。
 */
export type ExtensionSettingsAssembly = {
  /** 已激活扩展 id（其贡献已在当前 scope 内，直接复用）。 */
  activeIds: () => ReadonlySet<string>;
  /** 按需加载某扩展的设置专用贡献；失败返回安全原因。 */
  load: (extensionId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 关闭设置时释放本次按需装配的设置资源。 */
  dispose: () => void;
};

export type SettingsPluginOptions = {
  /** 画布权威目录（插件管理 facade 的展示元数据）。 */
  catalog?: readonly CanvasExtensionMetadata[];
  /** 运行时可配置 optional allowlist。 */
  ids?: readonly string[];
  /** 本次启动实际装配状态（composition root 注入）。 */
  assembled?: Readonly<Record<string, boolean>>;
  /** 本次启动加载失败的 browser-local optional。 */
  failed?: ReadonlySet<string>;
  /** composition root 注入的偏好 store（所有权仍归调用方）。 */
  preferenceStore?: ExtensionPreferenceStore;
  /** 设置专项扩展装配（未激活扩展按需装配 settings.plugin-config）。 */
  extensionSettings?: ExtensionSettingsAssembly;
};

/** 一次设置实例（弹窗打开到关闭之间）的本地状态；关闭/强制释放即丢弃。 */
type SettingsInstance = {
  edit: SettingsEditSession;
  /** 放弃确认进行中：重复关闭请求不重复弹确认。 */
  confirming: boolean;
};

export function settingsPlugin(options: SettingsPluginOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      let disposed = false;
      const service = <T,>(name: string): T | undefined => ctx.get(name as never) as T | undefined;
      const settingsRemote = service<SettingsRemote>("settingsRemote");
      const statusService = service<ApplicationExtensionStatusService>("applicationExtensionStatus");
      const generationModels = service<GenerationModelsStatusService>("generationModelsStatus");
      // App scope 的通知服务：设置只消费，不在弹窗生命周期内创建第二份订阅。
      const notifications = ctx.get("taskNotifications" as never) as TaskNotificationService | undefined;

      // 扩展自带设置面板（`settings.plugin-config`）：只按 pluginId 投影，不 import 具体实现。
      const settingsPanels: SettingsPanelSource = {
        list: () =>
          ctx.slots.list("settings.plugin-config").map((entry) => ({
            id: entry.id,
            pluginId: entry.pluginId,
            render: entry.render,
            source: entry
          })),
        subscribe: (listener) => ctx.slots.subscribe("settings.plugin-config", listener),
        version: () => ctx.slots.version()
      };

      // 写配置会改变插件健康与模型可执行性；写成功后主动重取权威状态。
      // 复用当前 Canvas scope 的既有服务，不新建 poller/socket。
      const backend = createBackendSettingsStore(
        withRuntimeStateRefresh(settingsRemote ?? unavailableSettingsRemote, [
          () => statusService?.refresh() ?? Promise.resolve(),
          () => generationModels?.refresh() ?? Promise.resolve()
        ])
      );
      const { facade, notify, dispose } = createExtensionManagerFacade({
        catalog: options.catalog ?? [],
        ids: options.ids ?? [],
        assembled: options.assembled ?? {},
        ...(options.failed ? { failed: options.failed } : {}),
        ...(options.preferenceStore ? { preferenceStore: options.preferenceStore } : {}),
        // 设置不再触发刷新/重启：未保存的目录目标由下一次启动读取。
        refresh: () => undefined,
        site: {
          ...(statusService ? { statusService } : {}),
          canManageSite: () => backend.canManage(),
          providerExtensions: () => {
            const state = backend.getState();
            return providerExtensionIds(state.status === "ready" ? state.snapshot : null);
          }
        },
        ...(generationModels ? { generationModels } : {})
      });
      const unsubscribeBackend = backend.subscribe((...args) => notify(...args));

      // 受管扩展（change: 2026-10-21-add-extension-marketplace-point，7.2）：任务进度与卡片操作。
      // 任务终态后重取设置与插件状态（新扩展的启停/版本以权威快照为准）。
      const managedController = createManagedExtensionsController({
        remote: createExtensionInstallRemote(),
        reload: async () => {
          await backend.load();
          await statusService?.refresh();
        }
      });
      const unsubscribeManagedAdopt = backend.subscribe(() => {
        const state = backend.getState();
        managedController.adoptSnapshot(state.status === "ready" ? state.snapshot : null);
      });
      // 当前页面仍在用旧版本的扩展（升级/卸载不热换），来自 `extension.release.changed`。
      let pendingReopen: readonly string[] = [];
      let latestRelease: { releaseId: string; href: string } | null = null;
      const pendingListeners = new Set<() => void>();
      const offReleaseChanged = ctx.on("extension.release.changed", (payload) => {
        pendingReopen = [...payload.pendingReopen];
        latestRelease = { releaseId: payload.releaseId, href: payload.href };
        for (const listener of [...pendingListeners]) listener();
      });
      // 「重新打开画布」复用 P0 的 HostConnectivity 提示路径：先 repin 新 release，再只重建 Canvas scope。
      const hostConnectivity = service<{
        offerRelease(next: { releaseId: string; href: string }): void;
        reopenCanvas(): Promise<void>;
      }>("hostConnectivity");
      // 「从市场安装」（change: 2026-10-21-add-server-extension-marketplace，7.5）：受理后交给同一任务列表。
      const marketplaceController = createMarketplaceInstallController({
        remote: createMarketplaceRemote(),
        onJob: (jobId, job) => managedController.track(jobId, job),
        readTrustedKeys: () => {
          const state = backend.getState();
          const entry = state.status === "ready" ? state.snapshot.settings.find((item) => item.key === TRUSTED_KEYS_SETTING) : undefined;
          return typeof entry?.value === "string" ? entry.value : "";
        },
        writeSetting: async (key, value) => {
          const result = await (settingsRemote ?? unavailableSettingsRemote).write({ [key]: value });
          if (!result.ok) return { ok: false, error: result.error };
          await backend.load();
          return { ok: true };
        }
      });
      const managed: ManagedExtensionsSource = {
        controller: managedController,
        marketplace: marketplaceController,
        pendingReopen: {
          get: () => pendingReopen,
          subscribe: (listener) => {
            pendingListeners.add(listener);
            return () => pendingListeners.delete(listener);
          }
        },
        ...(hostConnectivity
          ? {
              reopenCanvas: async () => {
                if (!latestRelease) return;
                hostConnectivity.offerRelease(latestRelease);
                await hostConnectivity.reopenCanvas();
              }
            }
          : {})
      };

      /** 当前打开的设置实例（singleton；关闭即丢弃）。 */
      let instance: SettingsInstance | null = null;
      const disposeInstance = () => {
        instance?.edit.reset();
        instance = null;
      };
      const currentInstance = (): SettingsInstance => {
        instance ??= { edit: createSettingsEditSession(), confirming: false };
        return instance;
      };

      /**
       * 打开设置。`pluginId` 让调用方直接落到某个插件的详情（扩展用自己的入口打开自己的
       * 配置面时用），省掉「先进列表再找一遍」；它只是一个初始视图提示，不是权限。
       */
      const open = async (
        input: { canvasId?: string | null; section?: SettingsSectionId; pluginId?: string } = {}
      ) => {
        const payload = {
          ...(input.section ? { section: input.section } : {}),
          ...(input.pluginId ? { pluginId: input.pluginId } : {})
        };
        if (disposed) {
          return { ok: false as const, code: "dialog-unavailable" as const, reason: "设置已释放" };
        }
        // 打开时才读导航（惰性）：插件装配阶段它可能还没就绪，也不应成为硬依赖。
        const navigation = ctx.get("canvasNavigation" as never) as
          | import("../../navigation/contracts.js").CanvasNavigationService
          | undefined;
        if (!navigation) {
          // 空壳/恢复页：没有画布聚焦现场可结算，直接入栈；Dialog Host 仍是唯一 owner。
          const result = ctx.dialogs.open({
            dialogId: SETTINGS_DIALOG_ID,
            payload
          });
          return result.ok
            ? { ok: true as const }
            : { ok: false as const, code: "dialog-unavailable" as const, reason: result.error };
        }
        // 复用既有受控编辑结算：dirty focus 取消/失败则不入栈，迟到结果按画布与聚焦代次丢弃。
        return navigation.requestOpenDialog({
          dialogId: SETTINGS_DIALOG_ID,
          payload,
          ...(input.canvasId !== undefined ? { canvasId: input.canvasId } : {})
        });
      };

      /**
       * dirty 时的共享确认（离开设置或内部导航）。返回用户是否确认放弃。
       *
       * 用共享 AlertDialog（保留「继续编辑」为默认安全动作）；结果按子实例身份结算，父实例已释放
       * 或已变化时丢弃迟到结果。
       */
      const confirmDiscard = (instanceId: string, description: string) =>
        new Promise<boolean>((resolve) => {
          const actionKey = `settings-discard:${instanceId}`;
          let abandon = false;
          const disposeAction = ctx.dialogs.registerAlertAction(actionKey, async () => {
            abandon = true;
            return { ok: true };
          });
          const opened = ctx.dialogs.open({
            dialogId: ALERT_DIALOG_ID,
            payload: {
              title: "放弃未保存的修改？",
              description,
              confirmLabel: "放弃修改",
              cancelLabel: "继续编辑",
              danger: true,
              actionKey
            }
          });
          if (!opened.ok) {
            disposeAction();
            resolve(false);
            return;
          }
          const childId = opened.instance.instanceId;
          const unsubscribe = ctx.dialogs.subscribe(() => {
            if (ctx.dialogs.find(childId)) return;
            unsubscribe();
            disposeAction();
            if (abandon) ctx.dialogs.find(instanceId) ? resolve(true) : resolve(false);
            else resolve(false);
          });
        });

      // 关闭 guard：所有关闭来源（Header X / Escape / 遮罩 / 业务 requestClose）共用。
      const disposeGuard = ctx.dialogs.registerCloseGuard(SETTINGS_DIALOG_ID, (dialog) => {
        const current = instance;
        if (!current) return "allow";
        // 写请求进行中：拒绝关闭与内部导航，避免重复提交与半提交状态。
        if (current.edit.isPending()) return "handled";
        if (!current.edit.isDirty()) {
          disposeInstance();
          return "allow";
        }
        if (current.confirming) return "handled";
        current.confirming = true;
        void confirmDiscard(
          dialog.instanceId,
          "继续编辑会保留当前输入；放弃修改只丢弃尚未保存的内容，已保存的配置不受影响。"
        ).then((abandon) => {
          if (instance !== current) return;
          current.confirming = false;
          if (!abandon) return;
          current.edit.discardDrafts();
          // 只执行捕获的退出意图：实例/身份已变则丢弃。
          const top = ctx.dialogs.top();
          if (top?.instanceId !== dialog.instanceId) return;
          disposeInstance();
          ctx.dialogs.close(dialog.instanceId);
        });
        return "handled";
      });

      const disposeDialog = ctx.dialogs.registerDialog(SETTINGS_DIALOG_ID, {
        definition: {
          dismissible: true,
          // singleton：连续打开不替换 payload、不重置表单；已打开时停在当前分区与输入。
          singleton: true,
          size: "lg",
          variant: "standard",
          validatePayload: (payload) => {
            const record = (payload ?? {}) as { section?: unknown; pluginId?: unknown };
            const section = record.section;
            const pluginId = typeof record.pluginId === "string" && record.pluginId !== "" ? record.pluginId : undefined;
            return {
              ok: true,
              payload: {
                ...(section === "backend" || section === "plugins" || section === "appearance" || section === "notifications" || section === "runtimes"
                  ? { section }
                  : {}),
                ...(pluginId ? { pluginId } : {})
              }
            };
          }
        },
        renderer: ({ instance: dialogInstance, requestClose }) => {
          const current = currentInstance();
          const payload = dialogInstance.payload as { section?: SettingsSectionId; pluginId?: string };
          return (
            <Suspense fallback={<SettingsLoading onRequestClose={requestClose} instanceId={dialogInstance.instanceId} />}>
              <SettingsWorkspace
                backend={backend}
                theme={ctx.theme}
                extensions={facade}
                settingsPanels={settingsPanels}
                managed={managed}
                {...(notifications ? { notifications } : {})}
                onRequestClose={requestClose}
                onRequestNavigate={async () => {
                  // 写请求进行中：拒绝切分区/进详情/返回列表（与关闭同一门禁）。
                  if (current.edit.isPending()) return false;
                  if (!current.edit.isDirty()) return true;
                  return await confirmDiscard(
                    dialogInstance.instanceId,
                    "继续编辑会保留当前输入；放弃只丢弃当前视图尚未保存的内容。"
                  ).then((abandon) => {
                    if (!abandon || instance !== current) return false;
                    current.edit.discardDrafts();
                    return true;
                  });
                }}
                instanceId={dialogInstance.instanceId}
                {...(payload.section ? { initialSection: payload.section } : {})}
                {...(payload.pluginId ? { initialPluginId: payload.pluginId } : {})}
                editSession={current.edit}
                {...(options.extensionSettings ? { extensionSettings: options.extensionSettings } : {})}
                onOpenTelemetry={() => {
                  // 打开复盘页 = 离开画布设置：先走与关闭同一套门禁（写请求中拒绝、脏输入先确认），
                  // 用户取消就停在设置里。change: 2026-10-20-add-local-client-telemetry，任务 5.5。
                  void (async () => {
                    if (current.edit.isPending()) return;
                    if (current.edit.isDirty()) {
                      const abandon = await confirmDiscard(
                        dialogInstance.instanceId,
                        "继续编辑会保留当前输入；放弃只丢弃当前视图尚未保存的内容。"
                      ).then((value) => value);
                      if (!abandon || instance !== current) return;
                      current.edit.discardDrafts();
                    }
                    ctx.dialogs.close(dialogInstance.instanceId);
                    // 带上来源画布：复盘页是整页路由，没有它「返回画布」只能落到默认画布。
                    const here = ctx.appRouter.getLocation();
                    const canvasId = here.page === "canvas" ? here.canvasId : undefined;
                    ctx.appRouter.navigate({
                      page: "telemetry",
                      ...(canvasId ? { telemetry: { canvasId } } : {})
                    });
                  })();
                }}
              />
            </Suspense>
          );
        }
      });

      // 打开能力：标题栏入口、兼容地址与其它指路操作共用（不调用 App Router）。
      const settingsOpen = {
        open: (input?: { canvasId?: string | null; section?: SettingsSectionId; pluginId?: string }) =>
          open(input ?? {})
      };
      ctx.provide("settingsOpen" as never, settingsOpen as never);

      // E2E/排障：确定性打开设置（生产无副作用，不写业务状态）。
      const hooks = globalThis as unknown as { __settings?: unknown };
      hooks.__settings = { open: (input?: { section?: SettingsSectionId }) => void open(input ?? {}) };

      /** 强制释放：页面离开/scope dispose 时收回本 owner 打开的所有设置层（含放弃确认）。 */
      const closeOwnedDialogs = () => {
        for (const dialog of ctx.dialogs.getSnapshot().stack) {
          if (dialog.dialogId === SETTINGS_DIALOG_ID) ctx.dialogs.close(dialog.instanceId);
        }
      };

      ctx.effect(
        () => () => {
          disposed = true;
          hooks.__settings = undefined;
          closeOwnedDialogs();
          disposeDialog();
          disposeGuard();
          unsubscribeBackend();
          unsubscribeManagedAdopt();
          offReleaseChanged();
          pendingListeners.clear();
          managedController.dispose();
          dispose();
          disposeInstance();
          options.extensionSettings?.dispose();
        },
        "settings-dialog"
      );
    },
    {
      name: SETTINGS_PLUGIN_ID,
      // 不硬注入 canvasNavigation：设置必须在画布壳、空状态与 renderer 失败时都可打开
      // （change: 2026-10-17-move-settings-into-canvas-dialog，design D1）。
      // 有导航时经它做受控编辑结算；没有时直接打开（此时也不存在聚焦编辑现场）。
      inject: ["slots", "dialogs", "theme", "appRouter"],
      provide: ["settingsOpen"]
    }
  );
}

/**
 * 设置内容首次加载时的占位。
 *
 * 必须复用**同一套 Dialog 外壳**：早期版本直接渲染 `.dlg` + `.status-overlay`，而后者是
 * `position: fixed; inset: 0`，于是加载提示会盖住整屏（并短暂露出没有弹窗外框的裸层）。
 * 这里保留固定 Header、左栏占位与右栏文案，加载完成后结构不变、不产生跳版。
 */
function SettingsLoading({ onRequestClose, instanceId }: { onRequestClose: () => void; instanceId?: string }) {
  return (
    <SettingsDialogChrome
      {...(instanceId ? { instanceId } : {})}
      onRequestClose={onRequestClose}
      nav={
        <nav className="settings-workbench__nav" aria-label="设置分区">
          <span className="settings-workbench__nav-placeholder" />
          <span className="settings-workbench__nav-placeholder" />
          <span className="settings-workbench__nav-placeholder" />
        </nav>
      }
    >
      <p className="settings-workbench__loading" role="status" data-testid="settings-loading">
        正在加载设置…
      </p>
    </SettingsDialogChrome>
  );
}

/** 缺少 settingsRemote 时的稳定失败（不崩溃、不伪造成功）。 */
const unavailableSettingsRemote: SettingsRemote = {
  async fetchSnapshot() {
    return { ok: false, code: "unavailable", error: "当前页面没有配置服务" };
  },
  async write() {
    return { ok: false, code: "unavailable", error: "当前页面没有配置服务" };
  }
};
