/**
 * Canvas Navigation Plugin
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 3.1/3.4/6.2 / design D2/D3/D4）。
 *
 * 在 Canvas page scope 提供 required `canvasNavigation` Service：画布 mode/panel/menu 的
 * 唯一 presentation 状态源。它把 menu 活动接入 Input Scope 门禁，并向 Dialog Service
 * 注册 pre-commit participant：任一合法 Dialog 入栈前同步关闭 menu/panel。普通 panel
 * 只在自己的 DOM 边界内消费输入，不建立全局画布门禁。
 *
 * 只存在于 Canvas scope；Task History scope 不安装（因此不注册 participant）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { CanvasNavigationStore } from "../../navigation/store.js";
import { FocusExitCoordinator } from "../../navigation/exit-coordinator.js";
import type { CanvasNavigationService } from "../../navigation/contracts.js";

export const CANVAS_NAVIGATION_PLUGIN_ID = "canvas-navigation";

export type CanvasNavigationExtensionOptions = {
  /** 测试注入：替换 store 实现。 */
  navigation?: CanvasNavigationService;
  /** 测试注入：替换退出协调器。 */
  focusExit?: FocusExitCoordinator;
};

export function canvasNavigationExtension(options: CanvasNavigationExtensionOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const focusExit = options.focusExit ?? new FocusExitCoordinator();
      ctx.provide("focusExit" as never, focusExit as never);
      // 编辑 feature 在打开文档后注册活动操作门禁；Navigation 在切换/退出前同步查询。
      const navigateGate = () => focusExit.switchGate();
      const navigation =
        options.navigation ??
        new CanvasNavigationStore({
          openDialog: (request) => {
            const result = ctx.dialogs.open({ dialogId: request.dialogId, payload: request.payload });
            return result.ok ? { ok: true } : { ok: false, error: result.error };
          },
          prepareExit: async () => {
            const result = await focusExit.prepare();
            return result.ok ? { ok: true } : { ok: false, reason: result.reason };
          },
          hasUnsavedChanges: () => focusExit.hasUnsavedChanges(),
          // 文档切换/返回画布前同步校验活动操作（笔迹、未确认草稿）；由编辑扩展注册。
          focusSwitchGate: () => navigateGate(),
          canvasIdentity: () => (ctx.get("canvasScope" as never) as { canvasId(): string } | undefined)?.canvasId() ?? null
        });
      ctx.provide("canvasNavigation" as never, navigation as never);

      // Menu 会接管画布输入；普通 panel 只在自己的 DOM 边界内消费事件。
      // 将任意 panel 注册成 editor scope 会让底部执行面板出现时整张画布失去
      // pointer / wheel / keyboard，违背非模态 panel 的交互语义。
      const removeMenuGate = ctx.inputScopes.addScope("menu", () => navigation.getSnapshot().menu !== null);

      // Dialog pre-commit participant：合法 Dialog 入栈前关闭 menu/panel（design D4）。
      // 清理是 close 语义：Dialog 关闭后不恢复；history focus 按来源收敛到 direct 或 overview。
      // dirty focus 尚未结算时返回 `focus-exit-required`：不先清理草稿也不入栈（design D7）。
      const removeParticipant = ctx.dialogs.registerOpenParticipant((request) => {
        // 配置当前作品的连接不退出编辑器，也不卸载持有草稿的生成面板。
        // 仅允许当前聚焦目标；其他弹窗仍须先结算编辑会话。
        const { mode, panel } = navigation.getSnapshot();
        if (request.editingOwner) {
          const owner = request.editingOwner;
          const canvasId = (ctx.get("canvasScope" as never) as { canvasId(): string } | undefined)?.canvasId();
          if (!owner.sessionId) return false;
          // 独立文件文档：不要求 nodeId，只要求当前活动呈现就是同一 documentId
          // （编辑扩展工作区，D1/D7）。
          if (owner.documentId) {
            if (owner.canvasId !== canvasId) return false;
            if (mode.type !== "document-workspace" || mode.documentId !== owner.documentId) return false;
            return navigation.clearTransientSurfaces().ok;
          }
          if (owner.canvasId !== canvasId || mode.type !== "node-focus"
            || mode.kind !== "image" || mode.owner !== "direct" || owner.nodeId !== mode.nodeId) return false;
          return navigation.clearTransientSurfaces().ok;
        }
        const payload = request.payload as { nodeId?: unknown } | undefined;
        if (request.dialogId === "agent-assistant" && typeof payload?.nodeId === "string"
          && ((mode.type === "node-focus" && payload.nodeId === mode.nodeId)
            || (panel && "nodeId" in panel && payload.nodeId === panel.nodeId))) return true;
        if (focusExit.hasUnsavedChanges()) return false;
        const result = navigation.clearTransientSurfaces();
        return result.ok;
      });

      ctx.effect(
        () => () => {
          removeMenuGate();
          removeParticipant();
          // scope dispose：收敛到空 presentation 并清除 focus 返回上下文（不恢复隐藏 panel）。
          navigation.resetPresentation();
        },
        "canvas-navigation-scopes"
      );

      // E2E/排障镜像（生产无副作用）：暴露导航 facade 供浏览器验收驱动。
      const hooks = globalThis as unknown as { __canvasNavigation?: unknown };
      hooks.__canvasNavigation = {
        enterNodeFocus: (input: { nodeId: string; kind: import("../../navigation/contracts.js").CanvasFocusKind; owner?: "direct" | "history" }) =>
          navigation.enterNodeFocus(input),
        exitNodeFocus: () => navigation.exitNodeFocus(),
        requestExitNodeFocus: () => navigation.requestExitNodeFocus(),
        openNodeHistory: (input: { nodeId: string; kind: import("../../navigation/contracts.js").CanvasFocusKind }) => navigation.openNodeHistory(input),
        getMode: () => navigation.getSnapshot().mode,
        getMenu: () => navigation.getSnapshot().menu,
        /** 设置等画布内模态的受控打开入口（与左下角入口同一通路）。 */
        openSettings: () =>
          navigation.requestOpenDialog({ dialogId: "settings", canvasId: (ctx.get("canvasScope" as never) as { canvasId(): string } | undefined)?.canvasId() ?? null })
      };
    },
    { name: CANVAS_NAVIGATION_PLUGIN_ID, inject: ["inputScopes", "dialogs"] }
  );
}
