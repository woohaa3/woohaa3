/**
 * 游戏炼丹炉 extension 前端装配
 * （change: 2026-10-10-add-game-furnace-extension，任务 2.4/2.5、4.3/4.4、5.x；按 integration
 * 新架构重实现）。
 *
 * 目标分支移除了「容器插件」体系后，扩展不再能注册专属 node type / 容器渲染器。本插件按新架构
 * 只做**通用**的事：
 * - 向宿主 `canvas.node-template` slot 贡献「创建游戏炼丹炉节点」（通用纯模型 `composite-asset`）；
 * - 向宿主 `canvas.focus-workspace` slot 贡献 kind 为注册工作区（双击聚焦进入）；
 * - 向宿主 `canvas.node-drop` slot 贡献 `composite-asset` 的复制拖入收集。
 *
 * 宿主因此不出现任何 `game-furnace` 分支；几何由 extension 自有的 `modelScript` 表达，项目内容
 * 由本扩展后端 handler + 节点稳定关联承载（见 notes/port-plan.md）。
 *
 * 装配策略：`server-active`——所有注册只在服务端扩展实际 active 时存在，停用/释放即移除。
 */
import type { Context, Plugin } from "@woohaa3/frontend/extension-api";
import { defineExtensionPlugin } from "@woohaa3/frontend/extension-api";
import type { CanvasStoreFacade, CanvasCommandsService, CanvasEditService, ApplicationRemoteService, SlotsService, TaskCatalogService, CanvasNavigationService, MediaRemoteService, CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { compositeAssetSceneOps, executeModelScriptVersioned, prepareModelResource, sceneIrVersionFor, CANVAS_MENU_SECTION, isSupportedModelScriptVersion, MODEL_SCRIPT_LANGUAGE } from "@woohaa3/contracts";
import { GAME_FURNACE_LABEL, GAME_FURNACE_PLUGIN_ID } from "../../state/shared/index.js";
import { createGameFurnaceNodeData, GAME_FURNACE_NODE_TYPE, isGameFurnaceNodeData } from "../../preview/shared/geometry.js";
import { extendGameFurnaceDrop } from "./drop.js";
import { extendGameFurnaceFileDrop } from "./file-drop.js";
import type { CanvasRuntimeService } from "@woohaa3/frontend/extension-api";
import { createGameFurnaceRemote, remoteFailureMessage } from "./remote.js";
import { reportGameFurnace } from "../../authoring/browser/feedback.js";
import { startTargetDetachWatcher } from "./target-watcher.js";
import { GameFurnaceWorkspace } from "./workspace.js";

/** 节点模板 contribution 稳定 ID（诊断/去重）。 */
export const GAME_FURNACE_NODE_TEMPLATE_ID = "game-furnace-node";
/** 聚焦工作区 contribution 稳定 ID。 */
export const GAME_FURNACE_FOCUS_WORKSPACE_ID = "game-furnace-workspace";
/** 节点 drop contribution 稳定 ID。 */
export const GAME_FURNACE_NODE_DROP_ID = "game-furnace-node-drop";

/**
 * 聚焦工作区的 focus kind（与双击入口的复合资产业务判别对齐）。
 *
 * 通用宿主契约（`CanvasFocusKind`）已含该值；这里只声明本扩展拥有的工作区 kind。
 */
export const GAME_FURNACE_FOCUS_KIND = "extension";

/** 宿主在 extension scope 注入的能力。 */
type ExtensionContext = Context & {
  slots: SlotsService;
  compositeAssets: CompositeAssetRegistry;
  canvasState: CanvasStoreFacade;
  canvasRuntime: CanvasRuntimeService;
  canvasCommands: CanvasCommandsService;
  canvasEdit: CanvasEditService;
  applicationRemote: ApplicationRemoteService;
  mediaRemote: MediaRemoteService;
  taskCatalog: TaskCatalogService;
  canvasNavigation: CanvasNavigationService;
};

/**
 * 注册「创建游戏炼丹炉节点」菜单项 + 通用聚焦工作区 + 复制拖入收集。
 */
export function gameFurnaceExtension(): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const disposers: (() => void)[] = [];
      const cleanup = () => { for (const dispose of disposers.splice(0).reverse()) dispose(); };
      ctx.effect(() => cleanup, "game-furnace-contributions");
      try {
      disposers.push(ctx.compositeAssets.register({
        extensionId: GAME_FURNACE_PLUGIN_ID, owner: GAME_FURNACE_PLUGIN_ID,
        // 业务类型显示名：浮动名称面板据此标注聚合节点业务类型
        // （change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
        label: GAME_FURNACE_LABEL,
        executionKey: data => `${JSON.stringify(data.scenePlacement)}:${String(data.modelScriptVersion)}:${String(data.modelScript ?? "")}`,
        prepare(_nodeId, data) {
          if (typeof data.modelScript !== "string" || !isSupportedModelScriptVersion(data.modelScriptVersion)) return null;
          const execution = executeModelScriptVersioned(data.modelScript, data.modelScriptVersion);
          return execution.ok ? { resource: prepareModelResource({ sceneVersion: sceneIrVersionFor(data.modelScriptVersion), ops: compositeAssetSceneOps(execution.scene.ops, data.scenePlacement) }) } : null;
        }
      }));

        disposers.push(ctx.slots.register("canvas.node-template", {
          id: GAME_FURNACE_NODE_TEMPLATE_ID,
          owner: GAME_FURNACE_PLUGIN_ID,
          nodeType: GAME_FURNACE_NODE_TYPE,
          label: GAME_FURNACE_LABEL,
          section: CANVAS_MENU_SECTION.creationTools,
          order: 1,
          createNodeData: () => createGameFurnaceNodeData()
        }));

        // 双击聚焦：宿主对 `extension3d` 进入 `extension` 工作区 kind，渲染本扩展工作区。
        disposers.push(ctx.slots.register("canvas.focus-workspace", {
          id: GAME_FURNACE_FOCUS_WORKSPACE_ID,
          owner: GAME_FURNACE_PLUGIN_ID,
          kind: GAME_FURNACE_FOCUS_KIND,
          matchesFocus: ({ focus }) => {
            const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
            return !!focus && !!canvas?.document.nodes.some((node) => node.id === focus.nodeId
              && node.type === GAME_FURNACE_NODE_TYPE && isGameFurnaceNodeData(canvas.nodeData[node.id]));
          },
          validate: ({ focus }) => {
            const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
            const data = focus ? canvas?.nodeData[focus.nodeId] : undefined;
            if (!data || !isSupportedModelScriptVersion(data.modelScriptVersion)) return "此炼丹炉的模型版本不受支持，请更新节点定义。";
            if (data.modelScriptLanguage !== MODEL_SCRIPT_LANGUAGE) return "此炼丹炉的模型脚本语言与版本不匹配。";
            return null;
          },
          render: ({ writable, focus, modalActive }) => (
            <GameFurnaceWorkspace
              writable={writable}
              nodeId={focus?.nodeId ?? null}
              modalActive={modalActive ?? false}
              canvasState={ctx.canvasState}
              commands={ctx.canvasCommands}
              remote={ctx.applicationRemote}
              mediaRemote={ctx.mediaRemote}
              taskCatalog={ctx.taskCatalog}
              onConfigureModels={() => { ctx.canvasNavigation.openDialog({ dialogId: "plugin-manager", payload: {} }); }}
              onBack={() => { void ctx.canvasNavigation.requestExitNodeFocus(); }}
            />
          )
        }));

        // 复制拖入：拖动来源节点落在炼丹炉节点范围内并释放时，收集为素材（不提交源移动）。
        disposers.push(extendGameFurnaceDrop(ctx));
        disposers.push(extendGameFurnaceFileDrop(ctx));

        // 任务 6.10：目标删除的取消/脱离必须在 **Canvas scope** 观察，而非仅聚焦工作区——普通画布上
        // 删除一个未被聚焦的炼丹炉节点也要按权限取消/脱离其后端在途任务。观察器追踪上次画布节点集合，
        // 画布切换/首次加载/临时 null 不误报；同一 canvas+node 去重；失败经 live region 回报后可重试。
        const targetRemote = createGameFurnaceRemote({ transport: ctx.applicationRemote.transport });
        disposers.push(startTargetDetachWatcher({
          canvasState: ctx.canvasState,
          detach: (input) => targetRemote.detachTarget(input),
          onFailure: (_input, failure) => reportGameFurnace(`目标删除处理失败：${remoteFailureMessage(failure)}`)
        }));
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    { name: GAME_FURNACE_PLUGIN_ID, inject: ["compositeAssets", "slots", "canvasState", "canvasRuntime", "canvasCommands", "canvasEdit", "applicationRemote", "mediaRemote", "taskCatalog", "canvasNavigation"] }
  );
}
