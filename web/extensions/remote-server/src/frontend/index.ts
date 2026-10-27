/**
 * remote-server 前端入口（扫描约定的 `src/frontend/index.ts`）。
 *
 * 两个装配面：
 * - **Canvas scope**：`plugin()` 注册顶栏徽标（连接状态在任何画布上都可见）、画布切换器
 *   条目上的「同步远端」动作（本地画布默认不上传，由用户逐张显式启用）与远端画布的
 *   「协作」入口：窗口里创建/撤销服务端签发的协作邀请，并展示只读成员名单
 *   （见 collaborators-dialog.tsx）；
 * - **设置弹窗**：`settingsPlugin()`（实现在 `settings-plugin.tsx`）只注册
 *   `settings.plugin-config` 面板，用户从「设置 → 插件配置 → 服务端接入」进入。
 *
 * 为什么不给接入面单独开一个全屏页面：接入是「配一次、平时只看徽标」的低频操作，与
 * sdk-agent / local-agent / oauth-agent 的授权面板同一档次；做成独立页面既要独占一套
 * page scope 与路由，又会让人误以为它是一个业务区。设置里的插件详情本来就是插件自己的
 * 配置面，接入放这里不需要任何核心改动。
 *
 * 本文件不含 JSX（扫描入口会直接读取它）。
 */
import type {
  Context,
  ApplicationRemoteService,
  DialogsService,
  ExtensionFrontendDescriptor,
  SlotsService
} from "@woohaa3/frontend/extension-api";

import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import { REMOTE_SERVER_CAPABILITY, REMOTE_SERVER_EXTENSION_ID } from "../shared.js";
import { createRemoteServerCatalogActionRenderer } from "./catalog-action.js";
import { createRemoteServerCollaboratorsActionRenderer } from "./collaborators-action.js";
import {
  REMOTE_SERVER_COLLABORATORS_DIALOG_ID,
  createRemoteServerCollaboratorsDialogRenderer,
  remoteServerCollaboratorsDialogDefinition
} from "./collaborators-dialog.js";
import { REMOTE_SERVER_DEBUG_DIALOG_ID, ensureRemoteServerDebugDialog } from "./debug-dialog.js";
import { REMOTE_SERVER_FRONTEND_METADATA } from "./metadata.js";
import { createRemoteServerService } from "./remote.js";
import { createRemoteServerBadgeRenderer } from "./remote-badge.js";
import { registerRemoteServerSettingsPanel, remoteServerSettingsExtension } from "./settings-plugin.js";
import "./remote-server.css";

export { REMOTE_SERVER_CAPABILITY } from "../shared.js";
export { createRemoteServerApi, createRemoteServerService } from "./remote.js";
export type { RemoteServerApi, RemoteServerService } from "./remote.js";
export {
  REMOTE_SERVER_DEBUG_DIALOG_ID,
  REMOTE_SERVER_DEBUG_POLL_INTERVAL_MS,
  RemoteServerDebugDialog,
  createRemoteServerDebugDialogRenderer,
  formatDiagnosticEntry,
  remoteServerDebugDialogDefinition
} from "./debug-dialog.js";
export { RemoteServerBadge, createRemoteServerBadgeRenderer } from "./remote-badge.js";
export {
  RemoteServerCollaboratorsDialog,
  REMOTE_SERVER_COLLABORATORS_DIALOG_ID,
  createRemoteServerCollaboratorsDialogRenderer,
  formatMemberGrantedAt,
  inviteStatusOf,
  remoteServerCollaboratorsDialogDefinition
} from "./collaborators-dialog.js";
export {
  RemoteServerCollaboratorsAction,
  createRemoteServerCollaboratorsActionRenderer
} from "./collaborators-action.js";
export {
  RemoteServerCatalogAction,
  createRemoteServerCatalogActionRenderer,
  isLocalOnlyCatalogEntry
} from "./catalog-action.js";
export { RemoteServerSettingsPanel } from "./settings-panel.js";
export { remoteServerSettingsExtension } from "./settings-plugin.js";
export { REMOTE_SERVER_FRONTEND_METADATA } from "./metadata.js";

/**
 * `settingsOpen` 的类型来自 `cordis/context.ts` 的 Context 增强（settings 插件提供），
 * 扩展不重复声明：重复声明会盖掉增强里"一定存在"的类型，让人以为需要判空。
 */
type ExtensionContext = Context & {
  applicationRemote: ApplicationRemoteService;
  slots: SlotsService;
  /** 宿主 Dialog Service：调试窗口注册在这里（宿主没有它时插件不装配，见 inject）。 */
  dialogs: DialogsService;
};

/**
 * Canvas 常驻入口：贡献顶栏徽标、画布目录条目动作、设置面板与 capability，不启动轮询、
 * 不读画布内容。
 *
 * 徽标需要的那一次状态读取在这里触发；之后由设置面板负责刷新，避免一个纯展示组件带来
 * 周期网络请求。
 *
 * 点击徽标直接打开**本扩展的设置面板**（`settingsOpen.open({ pluginId })`）：徽标是接入
 * 状态的唯一常驻表达，看到「已连接 / 连接异常」的人下一个动作就是「去改配置」，让他再去
 * 设置里找一遍插件卡片是不必要的往返。
 *
 * 徽标的注册挂在该能力上（见下方 `ctx.inject`）：能力未就绪就不渲染徽标，能力撤销就跟着
 * 注销。**不渲染"点了没反应的按钮"，也不渲染"点了没反应的文本"**——后者正是装配期快照造出的
 * 真实故障（徽标被固化成只读 span）。
 */
export function remoteServerExtension(): ReturnType<typeof defineExtensionPlugin<ExtensionContext>> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const service = createRemoteServerService(ctx.applicationRemote.transport);
      ctx.provide(REMOTE_SERVER_CAPABILITY, service as never);
      void service.refresh().catch(() => undefined);

      // 运行中的扩展由主插件提供设置面板（见 registerRemoteServerSettingsPanel 的注释）。
      // 调试窗口也由主插件注册：设置面板只负责「打开入口」，窗口本体属于扩展自己的 surface。
      //
      // 打开前再 ensure 一次：设置专用装配可能先注册过窗口（扩展未运行时），随后设置关闭会把它
      // 注销；那时主插件已经启动、不能再回头补注册。每次打开都补一次注册，「服务端日志」
      // 按钮就不会在少数时序下变成一个点了没反应的入口。
      const debugDialogDisposers: Array<() => void> = [];
      const ensureDebugDialog = (): void => {
        debugDialogDisposers.push(ensureRemoteServerDebugDialog(ctx.dialogs, service));
      };
      ensureDebugDialog();
      ctx.effect(
        () => () => {
          for (const dispose of debugDialogDisposers.splice(0)) dispose();
        },
        "remote-server-debug-dialog"
      );
      const openDebug = () => {
        ensureDebugDialog();
        ctx.dialogs.open({ dialogId: REMOTE_SERVER_DEBUG_DIALOG_ID, payload: {} });
      };
      registerRemoteServerSettingsPanel(ctx, service, openDebug);

      // 「协作」窗口：远端画布的协作邀请与只读成员名单。窗口随插件卸载注销；条目入口
      // 只负责「给哪张画布开窗口」，窗口内的读写全部收敛在 collaborators-dialog.tsx。
      const removeCollaboratorsDialog = ctx.dialogs.registerDialog(REMOTE_SERVER_COLLABORATORS_DIALOG_ID, {
        definition: remoteServerCollaboratorsDialogDefinition,
        renderer: createRemoteServerCollaboratorsDialogRenderer(service)
      });
      ctx.effect(() => () => removeCollaboratorsDialog(), "remote-server-collaborators-dialog");
      const openCollaborators = (input: { canvasId: string; title: string }): void => {
        ctx.dialogs.open({ dialogId: REMOTE_SERVER_COLLABORATORS_DIALOG_ID, payload: input });
      };

      // 徽标可点依赖「打开设置」能力，用 `ctx.inject` 声明式等待，**不得**在装配期 `ctx.get`：
      // 提供者在同一启动批次里要等整批 fiber 结算才 active，而 cordis 4 的 `ctx.get` 默认 strict
      // （未 active 的提供者返回 undefined）。快照一次，徽标就被永久固化成只读 span —— 点不动、
      // 文字可选中（真实故障）。声明式写法让贡献的生命周期跟着能力走：能力就绪才注册，能力撤销
      // 随即注销。机制说明见 docs/diagrams/target-plugin-service-defenses.html。
      ctx.inject(["settingsOpen"], (scoped) => {
        const settingsOpen = scoped.settingsOpen;
        const removeBadge = ctx.slots.register("canvas.topbar", {
          id: `${REMOTE_SERVER_EXTENSION_ID}-badge`,
          owner: REMOTE_SERVER_EXTENSION_ID,
          // 比身份徽标（priority 1）更靠右：先显示「我是谁」，再显示「接到哪」。
          priority: 2,
          render: createRemoteServerBadgeRenderer(service, () => {
            void settingsOpen.open({ section: "plugins", pluginId: REMOTE_SERVER_EXTENSION_ID });
          })
        });
        scoped.effect(() => () => removeBadge(), "remote-server-badge");
      });

      // 画布切换器的每一条「仅本机」画布旁的动作入口：本地画布默认不上传，由用户逐张点
      // 「同步远端」。贡献只挂一次，宿主对每个条目渲染它；是否呈现由组件按连接状态与条目
      // 来源自行判断（见 catalog-action.tsx 的注释）。
      const removeCatalogAction = ctx.slots.register("canvas.catalog-item-action", {
        id: `${REMOTE_SERVER_EXTENSION_ID}-catalog-sync`,
        owner: REMOTE_SERVER_EXTENSION_ID,
        priority: 10,
        render: createRemoteServerCatalogActionRenderer(service)
      });
      ctx.effect(() => () => removeCatalogAction(), "remote-server-catalog-action");

      // 已在远端的画布入口：与上面「同步远端」互斥（组件各自按连接状态与条目来源判断）。
      // 协作窗口是扩展自己的 surface，条目动作只把画布身份交给宿主 Dialog Service。
      const removeCollaboratorsAction = ctx.slots.register("canvas.catalog-item-action", {
        id: `${REMOTE_SERVER_EXTENSION_ID}-collaborators`,
        owner: REMOTE_SERVER_EXTENSION_ID,
        priority: 10,
        render: createRemoteServerCollaboratorsActionRenderer(service, openCollaborators)
      });
      ctx.effect(() => () => removeCollaboratorsAction(), "remote-server-collaborators-action");

      // 新建画布时可勾选的「同时同步到远端」：建好后由宿主调用 apply 把它推到远端。
      // 只在已连接时出现；不回填 defaultEnabled——新建默认本地，同步是显式选择。
      const removeCreateOption = ctx.slots.register("canvas.create-option", {
        id: `${REMOTE_SERVER_EXTENSION_ID}-create-sync`,
        owner: REMOTE_SERVER_EXTENSION_ID,
        priority: 10,
        label: "同时同步到远端",
        description: "建好后立刻把这张画布同步到远端，可邀请协作者。",
        available: () => service.getSnapshot().phase === "connected",
        apply: async ({ canvasId }) => {
          const result = await service.api.enableCanvasSync(canvasId);
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        }
      });
      ctx.effect(() => () => removeCreateOption(), "remote-server-create-option");

      ctx.effect(() => () => service.dispose(), "remote-server-service");
    },
    {
      name: "remote-server-extension",
      // `settingsOpen` 不进本插件的 `inject`：只有徽标需要它，其余贡献（目录动作、两个窗口、
      // 设置面板）不依赖设置能力；让整个插件等它会把调试窗口一并拖住。需要它的那一处用
      // `ctx.inject` 局部等待（见 badge 注册处）。
      // `dialogs` 则必须注入：调试窗口是扩展自己注册的 surface，没有 Dialog Service 就无处装载。
      inject: ["applicationRemote", "slots", "dialogs"],
      provide: REMOTE_SERVER_CAPABILITY
    }
  );
}

export const descriptor: ExtensionFrontendDescriptor = {
  ...REMOTE_SERVER_FRONTEND_METADATA,
  plugin: () => remoteServerExtension(),
  settingsPlugin: () => remoteServerSettingsExtension()
};
