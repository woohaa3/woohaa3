/**
 * Canvas Context Menu Plugin
 * （change: adopt-frontend-cordis-plugin-runtime，design D5/D6；
 *  change: remove-canvas-groups-and-film-set —— 分组与片场菜单/横条入口全部删除）。
 *
 * 拥有上下文菜单的内容与选择处理：向 `canvas.context-menu` slot 注册菜单项与 select 处理器，
 * 通过 Canvas Runtime 的瞬时菜单状态驱动渲染。不再由 Host 维护菜单业务分支。
 */
import type { Context } from "@deepseek-ai/cordis";
import { createElement } from "react";
import { EmptyCanvas } from "./empty-canvas.js";
import type { Plugin } from "@deepseek-ai/cordis";
import type { ContextMenuContext } from "../../contracts.js";
import {
  NODE_TEMPLATES,
  connectLabelFor,
  connectNodeDataFor,
  defaultNodeDataForType,
  findNodeTemplate
} from "../../domain/node-catalog.js";
import { planInsertNode } from "../../../extension-api/command-planner.js";
import { CANVAS_MENU_SECTION, COMPOSITE_ASSET_NODE_TYPE, createHighEntropyId, partitionManagedNodeDeletion } from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { IMPORT_SERVICE, type ImportService } from "../service-keys.js";
import { definePlugin } from "../../plugin.js";
import { CANVAS_CONTEXT_MENU_TYPE } from "../canvas-runtime/plugin.js";
import { nodeRenameStore } from "./rename-store.js";
import { NodeRenameOverlay } from "./rename-dialog.js";
import type { CanvasContextMenuItem } from "./canvas-context-menu.js";
import type { SlotsService } from "../../contract/platform.js";
import { reportContributionFault } from "../../contribution-guard.js";
import type { ExtensionFaultService } from "../../extension-faults.js";
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";

export const CANVAS_MENU_PLUGIN_ID = "canvas-context-menu";
export const CANVAS_MENU_CONTRIBUTION_ID = "canvas-menu";

/** 节点右键菜单使用的结构节点形状。 */
export type CanvasMenuNode = { id: string; type: string };

/**
 * 右键菜单读取的宿主事实。
 *
 * 由宿主注入，使右键复用统一删除门禁（托管节点保护）。
 */
export type NodeContextMenuFacts = {
  nodeData?: Readonly<Record<string, unknown>>;
  /** 指针当前命中的节点 id。 */
  activeNodeId?: string | null;
};

export function conversionFeedbackCurrent(active: boolean, disposed: boolean, expectedCanvasId: string, currentCanvasId?: string): boolean {
  return active && !disposed && currentCanvasId === expectedCanvasId;
}

/** 节点右键菜单项：重命名、删除。 */
export function nodeContextMenuItems(
  nodes: readonly CanvasMenuNode[],
  selectedNodeIds: readonly string[],
  writable: boolean,
  facts: NodeContextMenuFacts = {}
): Array<{ id: string; label: string; danger?: boolean; disabled?: boolean; reason?: string }> {
  const activeNodeId = facts.activeNodeId;
  const selected = [...selectedNodeIds];
  const deletion = partitionManagedNodeDeletion(nodes, facts.nodeData ?? {}, activeNodeId ? [activeNodeId] : selected);
  const canDelete = deletion.allowed.length > 0;
  const active = nodes.find(node => node.id === activeNodeId);
  const data = activeNodeId ? facts.nodeData?.[activeNodeId] as { sharedWorldInstance?: unknown } | undefined : undefined;
  return [
    ...(active?.type === "model3d" && !data?.sharedWorldInstance ? [{ id: "convert-world", label: "转换到共享世界", disabled: !writable }] : []),
    ...(selected.length === 1 ? [{ id: "rename-node", label: "重命名作品", disabled: !writable }] : []),
    ...(canDelete ? [{ id: "delete-node", label: "删除作品", danger: true, disabled: !writable }] : [])
  ];
}

export const canvasMenuExtension: Plugin.Function<void> = definePlugin(
  (ctx: Context) => {
    let disposed = false;
    const conversionCleanups = new Set<() => void>();
    ctx.effect(() => () => {
      disposed = true;
      for (const cleanup of conversionCleanups) cleanup();
    }, "canvas-menu-conversion-cleanup");
    const removeEmpty = ctx.slots.register("canvas.overlay", {
      id: "empty-canvas", owner: CANVAS_MENU_PLUGIN_ID, priority: 0,
      render: (props) => createElement(EmptyCanvas, { ctx, writable: props.writable, modalActive: props.modalActive })
    });
    ctx.effect(() => () => removeEmpty(), "canvas-empty-overlay");
    // 注册 Canvas Navigation menu definition（change: unify-canvas-presentation-navigation）。
    // 渲染由 canvas-host 按 navigation snapshot 完成；这里只声明 definition 与 owner。
    const disposeMenuDefinition = ctx.canvasNavigation.registerMenu({
      type: CANVAS_CONTEXT_MENU_TYPE,
      owner: CANVAS_MENU_PLUGIN_ID,
      render: () => null
    });
    ctx.effect(() => () => disposeMenuDefinition(), "canvas-menu-definition");

    const remove = ctx.slots.register("canvas.context-menu", {
      id: CANVAS_MENU_CONTRIBUTION_ID,
      owner: CANVAS_MENU_PLUGIN_ID,
      priority: 0,
      items: (context: ContextMenuContext) => {
        const { nodeId, writable, selectedNodeIds, connectFrom } = context;
        if (nodeId) {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const nodes = canvas?.document.nodes ?? [];
          return nodeContextMenuItems(nodes, selectedNodeIds ?? [], writable, {
            activeNodeId: nodeId,
            nodeData: canvas?.nodeData
          });
        }
        // 拉线创建只列出合法可连接节点（创作工具类节点不作为连线目标）。
        const baseTemplates = NODE_TEMPLATES.filter((template) => template.nodeType !== COMPOSITE_ASSET_NODE_TYPE);
        return [
          ...baseTemplates.map((template) => ({
            id: `insert:${template.id}`,
            label: template.label,
            section: CANVAS_MENU_SECTION.basicMaterial,
            disabled: !writable
          })),
          // 扩展贡献的通用节点模板；宿主只按通用节点契约合并菜单项，不 import 任何具体扩展内容。
          ...(connectFrom ? [] : extensionNodeTemplateItems(ctx, context)),
          { id: "upload", label: "上传…", section: CANVAS_MENU_SECTION.other, disabled: !writable }
        ];
      },
      onSelect: (itemId, context) => {
        if (itemId === "convert-world") {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const nodeId = context.nodeId;
          if (!canvas || !nodeId || !ctx.canvasSession.isWritable() ||
              !canvas.document.nodes.some(node => node.id === nodeId && node.type === "model3d") ||
              canvas.nodeData[nodeId]?.sharedWorldInstance) return;
          const canvasId = canvas.id;
          const operationId = createHighEntropyId("world-conversion");
          const instanceId = createHighEntropyId("world-instance");
          const actionKey = `world-conversion:${operationId}`;
          let dialogId: string | null = null;
          let unsubscribe: (() => void) | undefined;
          let active = true;
          let pending: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
          const cleanup = () => { active = false; unregister(); unsubscribe?.(); conversionCleanups.delete(cleanup); };
          const unregister = ctx.dialogs.registerAlertAction(actionKey, () => {
            if (pending) return pending;
            pending = (async () => {
              let result: Awaited<ReturnType<typeof ctx.canvasEdit.convertWorld>>;
              try {
                result = await ctx.canvasEdit.convertWorld({ remote: ctx.canvasRemote, canvasId, operationId, targets: [{ nodeId, instanceId }] });
              } catch (error) {
                if (!conversionFeedbackCurrent(active, disposed, canvasId, workingCanvasOf(woohaa3CanvasStore.getState())?.id)) return { ok: false as const, error: "页面已切换" };
                return { ok: false as const, error: error instanceof Error ? error.message : "转换失败" };
              }
              if (!conversionFeedbackCurrent(active, disposed, canvasId, workingCanvasOf(woohaa3CanvasStore.getState())?.id)) return { ok: false as const, error: "页面已切换" };
              if (!result.ok) return { ok: false as const, error: result.reason };
              cleanup();
              if (dialogId) ctx.dialogs.close(dialogId);
              return { ok: true as const };
            })().finally(() => { pending = null; });
            return pending;
          });
          conversionCleanups.add(cleanup);
          const opened = ctx.dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "转换到共享世界", description: "将此旧模型转换为共享世界实例。转换可撤销。", confirmLabel: "转换", cancelLabel: "取消", actionKey } });
          if (!opened.ok) { cleanup(); return; }
          dialogId = opened.instance.instanceId;
          unsubscribe = ctx.dialogs.subscribe(() => { if (dialogId && !ctx.dialogs.find(dialogId)) cleanup(); });
          return;
        }
        if (itemId === "delete-node") {
          if (!context.nodeId) return;
          submitDelete(ctx, context.nodeId);
          return;
        }
        if (itemId === "rename-node") {
          const nodeId = context.nodeId ?? context.selectedNodeIds?.[0];
          if (!nodeId) return;
          openRename(nodeId);
          return;
        }
        if (itemId === "upload") {
          const importService = ctx.get(IMPORT_SERVICE) as ImportService | undefined;
          importService?.requestFile({
            world: context.world,
            ...(context.connectFrom ? { connectFrom: context.connectFrom } : {})
          });
          return;
        }
        if (itemId.startsWith("insert-template:")) {
          insertExtensionTemplateNode(ctx, itemId.slice("insert-template:".length), context);
          return;
        }
        if (itemId.startsWith("insert:")) {
          insertNode(ctx, itemId.slice("insert:".length), context);
        }
      }
    });
    ctx.effect(() => () => remove(), "canvas-menu-contribution");

    // 重命名浮层（change: 2026-10-09-improve-canvas-workflow，任务 2.3）。
    // 只读时打开仍可查看但不能提交；切换画布/dispose 清空，避免写错目标。
    const removeRenameOverlay = ctx.slots.register("canvas.overlay", {
      id: "node-rename",
      owner: CANVAS_MENU_PLUGIN_ID,
      priority: 30,
      render: () =>
        NodeRenameOverlay({
          store: nodeRenameStore,
          resolve: () => ({ edit: ctx.canvasEdit, writable: ctx.canvasSession.isWritable() })
        })
    });
    ctx.effect(() => () => {
      removeRenameOverlay();
      nodeRenameStore.close();
    }, "canvas-menu-rename-overlay");

    function openRename(nodeId: string): void {
      const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
      const data = canvas?.nodeData[nodeId] as { title?: string } | undefined;
      nodeRenameStore.open(nodeId, typeof data?.title === "string" ? data.title : "");
    }
  },
  { name: CANVAS_MENU_PLUGIN_ID, inject: ["slots", "canvasSession", "canvasNavigation", "canvasEdit", "canvasRuntime", "canvasRemote", "dialogs"] }
);

function submitDelete(ctx: Context, nodeId: string): void {
  if (!ctx.canvasSession.isWritable()) return;
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
  if (!canvas || !partitionManagedNodeDeletion(canvas.document.nodes, canvas.nodeData, [nodeId]).allowed.length) return;
  void ctx.canvasEdit.record([{ type: "node.remove", nodeIds: [nodeId] }], "删除作品");
}

function insertNode(ctx: Context, templateId: string, context: ContextMenuContext): void {
  const template = findNodeTemplate(templateId);
  if (!template) return;
  if (!ctx.canvasSession.isWritable()) return;
  const world = context.world;
  // 自包含 3D 节点直接创建时携带完整本地模型定义，不从来源节点读取。
  const nodeData = defaultNodeDataForType(template.id);
  if (nodeData === undefined) return;
  const label = context.connectFrom ? connectLabelFor(context.connectFrom.nodeType, template.nodeType) : "";
  void ctx.canvasEdit.record(
    planInsertNode({
      nodeType: template.nodeType,
      position: world,
      nodeData: context.connectFrom
        ? connectNodeDataFor(
            { id: context.connectFrom.nodeId, type: context.connectFrom.nodeType },
            template.id, [], workingCanvasOf(woohaa3CanvasStore.getState())?.nodeData
          ) ?? nodeData
        : nodeData,
      ...(context.connectFrom ? { connectFromNodeId: context.connectFrom.nodeId } : {}),
      ...(label ? { connectLabel: label } : {})
    }),
    "创建作品"
  );
}

/** 扩展节点模板 contribution ID → 菜单项 ID 前缀（宿主通用，不感知具体扩展）。 */
export const EXTENSION_NODE_TEMPLATE_ITEM_PREFIX = "insert-template:";

/** 通用节点模板贡献（宿主菜单只需这些字段；纯函数测试友好）。 */
export type ExtensionNodeTemplateContribution = {
  icon?: import("react").ComponentType<{ className?: string }>;
  id: string;
  label: string;
  nodeType: string;
  section?: string;
  order?: number;
  createNodeData: (context: ContextMenuContext) => unknown;
};

/**
 * 把 `canvas.node-template` 贡献合并为菜单项。宿主只按通用节点契约处理：`createNodeData`
 * 返回 undefined 或抛错的模板不产生菜单项（例如扩展未就绪）。
 * 纯函数，便于独立测试。
 */
export function extensionNodeTemplateMenuItems(
  contributions: ReadonlyArray<ExtensionNodeTemplateContribution>,
  writable: boolean,
  context: ContextMenuContext,
  faults?: ExtensionFaultService
): CanvasContextMenuItem[] {
  const items: CanvasContextMenuItem[] = [];
  for (const contribution of contributions) {
    let nodeData: unknown;
    try {
      nodeData = contribution.createNodeData(context);
    } catch (error) {
      // 扩展模板抛错：归因并计入熔断，跳过该菜单项（change: 2026-10-21-harden-extension-fault-isolation）。
      reportContributionFault(contribution, "canvas.node-template", faults, error);
      nodeData = undefined;
    }
    if (nodeData === undefined) continue;
    items.push({
      id: `${EXTENSION_NODE_TEMPLATE_ITEM_PREFIX}${contribution.id}`,
      label: contribution.label,
      ...(contribution.icon ? { icon: contribution.icon } : {}),
      section: contribution.section ?? CANVAS_MENU_SECTION.creationTools,
      order: contribution.order ?? 100,
      disabled: !writable
    });
  }
  return items;
}

/** 合并 `canvas.node-template` 贡献为菜单项（插件内读取 slots）。 */
function extensionNodeTemplateItems(ctx: Context, context: ContextMenuContext): CanvasContextMenuItem[] {
  const slots = ctx.get("slots") as SlotsService | undefined;
  const contributions = slots?.list("canvas.node-template") ?? [];
  return extensionNodeTemplateMenuItems(contributions, context.writable, context, ctx.get("extensionFaults" as never) as ExtensionFaultService | undefined);
}

/** 选中扩展节点模板：由宿主用扩展产出的 nodeData 创建通用节点。 */
function insertExtensionTemplateNode(ctx: Context, contributionId: string, context: ContextMenuContext): void {
  if (!ctx.canvasSession.isWritable()) return;
  const slots = ctx.get("slots") as SlotsService | undefined;
  const contribution = slots?.list("canvas.node-template").find((entry) => entry.id === contributionId);
  if (!contribution) return;
  let nodeData: ReturnType<(typeof contribution)["createNodeData"]>;
  try {
    nodeData = contribution.createNodeData(context);
  } catch (error) {
    reportContributionFault(contribution, "canvas.node-template", ctx.get("extensionFaults" as never) as ExtensionFaultService | undefined, error);
    nodeData = undefined;
  }
  if (nodeData === undefined) return;
  void ctx.canvasEdit.record(
    planInsertNode({ nodeType: contribution.nodeType, position: context.world, nodeData }),
    "创建作品"
  );
}
