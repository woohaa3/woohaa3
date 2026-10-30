/**
 * Canvas Context Menu Plugin
 * （change: adopt-frontend-cordis-plugin-runtime，design D5/D6）。
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
import { planGroupNodes, planInsertNode, planUngroupNodes } from "../../../extension-api/command-planner.js";
import { CANVAS_MENU_SECTION, COMPOSITE_ASSET_NODE_TYPE, FILM_SET_SHOT_PREVIEW_NODE_TYPE, partitionManagedNodeDeletion, resolveShotReferenceSource } from "@woohaa3/contracts";

/** 便签的规范节点类型（与 `node-catalog.ts` 的模板 nodeType 一致）。 */
const STICKY_NOTE_NODE_TYPE = "sticky-note";
import { shotReferenceTemplateItems } from "./shot-reference-menu.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { IMPORT_SERVICE, type ImportService } from "../service-keys.js";
import { GROUP_RUN_SERVICE, type GroupRunService } from "../service-keys.js";
import { definePlugin } from "../../plugin.js";
import { CANVAS_CONTEXT_MENU_TYPE } from "../canvas-runtime/plugin.js";
import { nodeRenameStore } from "./rename-store.js";
import { NodeRenameOverlay } from "./rename-dialog.js";
import { stickyNoteStore } from "./sticky-note-store.js";
import { StickyNoteOverlay } from "./sticky-note-dialog.js";
import {
  GROUP_STRUCTURE_ACTION_IDS,
  GROUP_STRUCTURE_ACTION_LABELS,
  describeGroupStructureAction,
  runGroupStructureAction,
  type GroupStructureDeps
} from "./group-structure-actions.js";
import type { CanvasContextMenuItem } from "./canvas-context-menu.js";
import type { SlotsService } from "../../contract/platform.js";
import { reportContributionFault } from "../../contribution-guard.js";
import type { ExtensionFaultService } from "../../extension-faults.js";

export const CANVAS_MENU_PLUGIN_ID = "canvas-context-menu";
export const CANVAS_MENU_CONTRIBUTION_ID = "canvas-menu";

/** 拍摄镜头预览保护的菜单说明（change: 2026-10-15，任务 5.5 / design D2）。 */

/** 节点右键菜单使用的结构节点形状（change: add-canvas-node-grouping）。 */
export type CanvasMenuNode = { id: string; type: string; parentId?: string };

/** 选区动作（打组/解组）的稳定动作 ID；多选横条贡献与右键菜单项共用同一身份。 */
export const SELECTION_ACTION_IDS: Readonly<Record<"group" | "ungroup", string>> = {
  group: "group-selection",
  ungroup: "ungroup-selection"
};

/** 选区动作展示文案（多选横条与右键共用）。 */
export const SELECTION_ACTION_LABELS: Readonly<Record<"group" | "ungroup", string>> = {
  group: "打组",
  ungroup: GROUP_STRUCTURE_ACTION_LABELS.ungroup
};

/** 只读统一原因文案（多选横条与右键一致）。 */
const READONLY_REASON = "当前会话不可写（画布只读）";

/**
 * 解析多选横条上一个选区动作的描述（纯函数）
 * （change: 2026-10-16-add-group-selection-toolbar，design D1）。
 *
 * 打组：选区至少有 2 个非 group 节点；解组：选区含 group 或其成员。不适用时返回 null（该项不
 * 呈现）。只读时仍呈现但禁用，并给出与右键一致的原因。
 */
export function selectionActionDescriptor(input: {
  nodes: readonly CanvasMenuNode[];
  selectedNodeIds: readonly string[];
  writable: boolean;
  kind: "group" | "ungroup";
}): { label: string; enabled: boolean; reason?: string } | null {
  const { nodes, selectedNodeIds, writable, kind } = input;
  const applicable = kind === "group"
    ? selectedNodeIds.filter((id) => nodes.find((node) => node.id === id)?.type !== "group").length >= 2
    : selectedNodeIds.some((id) => {
        const node = nodes.find((candidate) => candidate.id === id);
        return node?.type === "group" || (!!node?.parentId && node.type !== "group");
      });
  if (!applicable) return null;
  return {
    label: SELECTION_ACTION_LABELS[kind],
    enabled: writable,
    ...(writable ? {} : { reason: READONLY_REASON })
  };
}

/**
 * 右键菜单读取的分组事实（change: 2026-10-16-add-group-selection-toolbar，任务 2.2）。
 *
 * 由宿主注入，使**右键与横条共享**同一提交门禁与同一批量执行预览（N 与禁用原因）；纯函数测试
 * 可不传，缺省视为「未提交、无预览」。
 */
export type NodeContextMenuFacts = {
  nodeData?: Readonly<Record<string, unknown>>;
  /** 该分组是否仍在编排一批提交；true 时分组三个动作都禁用（不能绕过提交门禁）。 */
  groupSubmitting?: (groupId: string) => boolean;
  /** 该分组的只读预览（N 与是否可用）；缺省时不显示数量。 */
  groupPreview?: (groupId: string) => { count: number; enabled: boolean; reason?: string };
  /**
   * 指针当前命中的节点 id（change: 2026-10-15-add-film-set-shooting-shot-previews，任务 5.5 / design D2）。
   * 用于拍摄镜头预览保护：指针位于预览上时隐藏以其身份执行的普通删除/重命名。
   */
  activeNodeId?: string | null;
};

/** 节点右键菜单项：打组（≥2 个非 group 选中）、解组（选中 group 或其成员）、
 * 整理（单选 group）、批量执行（单选 group）、删除。 */
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
  const canGroup = selected.filter((id) => nodes.find((node) => node.id === id)?.type !== "group").length >= 2;
  const canUngroup = selected.some((id) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node?.type === "group" || (!!node?.parentId && node.type !== "group");
  });
  const soloGroup = selected.length === 1 && nodes.find((node) => node.id === selected[0])?.type === "group"
    ? selected[0]
    : null;
  // 分组提交期间，该组的批量执行/整理/解组全部禁用（横条与右键共用同一门禁）。
  const submitting = soloGroup ? facts.groupSubmitting?.(soloGroup) ?? false : false;
  const groupGate = !writable || submitting;
  const groupGateReason = !writable ? "当前会话不可写（画布只读）" : submitting ? "提交中" : undefined;
  // 批量执行：右键与横条共用同一预览；N 由预览给出，禁用时附可读原因。
  // 分组执行能力缺失（task-execution 未装配）时不出现该菜单项。
  const bulk = soloGroup && facts.groupPreview ? facts.groupPreview(soloGroup) : null;
  const bulkDisabled = groupGate || (bulk ? !bulk.enabled : false);
  const bulkReason = bulk && !bulk.enabled ? bulk.reason : groupGateReason;
  // 单选分组时「解组」在右键同时提供选区解组与分组固定入口；选中成员时仍用选区解组/移出。
  // 两者共用同一 planner（`planUngroupNodes`）与同一门禁，行为一致。
  const canUngroupSelection = canUngroup;
  return [
    ...(canGroup ? [{ id: SELECTION_ACTION_IDS.group, label: SELECTION_ACTION_LABELS.group, disabled: !writable, ...(writable ? {} : { reason: READONLY_REASON }) }] : []),
    ...(canUngroupSelection ? [{ id: SELECTION_ACTION_IDS.ungroup, label: SELECTION_ACTION_LABELS.ungroup, disabled: !writable, ...(writable ? {} : { reason: READONLY_REASON }) }] : []),
    ...(soloGroup ? [{ id: "tidy-group", label: GROUP_STRUCTURE_ACTION_LABELS.tidy, disabled: groupGate, ...(groupGateReason ? { reason: groupGateReason } : {}) }] : []),
    // 批量执行：右键与横条共用同一预览；有预览时给出 N（`批量执行 · N`），
    // 禁用时附可读原因；预览缺失（纯函数回归/能力未装配）时仍呈现「运行」固定入口。
    ...(soloGroup
      ? [{
          id: "run-group",
          label: bulk ? (bulk.enabled ? `批量执行 · ${bulk.count}` : "批量执行") : "运行",
          disabled: bulkDisabled,
          ...(bulkReason ? { reason: bulkReason } : {})
        }]
      : []),
    ...(soloGroup ? [{ id: "ungroup-group", label: GROUP_STRUCTURE_ACTION_LABELS.ungroup, disabled: groupGate, ...(groupGateReason ? { reason: groupGateReason } : {}) }] : []),
    // 重命名（change: 2026-10-09-improve-canvas-workflow，任务 2.3）：单个作品可重命名；
    ...(selected.length === 1 ? [{ id: "rename-node", label: "重命名作品", disabled: !writable }] : []),
    ...(canDelete ? [{ id: "delete-node", label: "删除作品", danger: true, disabled: !writable }] : [])
  ];
}

export const canvasMenuExtension: Plugin.Function<void> = definePlugin(
  (ctx: Context) => {
    const removeGroupStatusAction = ctx.slots.register("canvas.node-action", {
      id: "group-run-status", owner: CANVAS_MENU_PLUGIN_ID, order: 100,
      available: ({ nodeType }) => nodeType === "group",
      describe: () => null,
      activate: ({ nodeId }) => ctx.emit("ui.task-activity.open-requested", { nodeId })
    });
    ctx.effect(() => () => removeGroupStatusAction(), "group-run-status-action");
    // 分组批量执行 capability（由 task-execution 提供）：右键与横条共用同一预览、提交态与入口。
    // 能力缺失时右键不出现「批量执行」项（与横条一致）。
    const groupRun = (): GroupRunService | undefined => ctx.get(GROUP_RUN_SERVICE) as GroupRunService | undefined;
    // 固定 groupId 的结构动作入口（横条与右键共用同一门禁与 planner）。
    const structureDeps: GroupStructureDeps = {
      isWritable: () => ctx.canvasSession.isWritable(),
      getCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()) ?? null,
      isSubmitting: (groupId) => groupRun()?.isSubmitting(groupId) ?? false,
      record: (commands, label) => { void ctx.canvasEdit.record(commands, label); }
    };
    // 分组横条的「整理」「解组」贡献（change: 2026-10-16-add-group-selection-toolbar，任务 2.1/2.2）：
    // 与右键共用同一 `structureDeps`（同一门禁、同一 planner，一次批次一次撤销）。宿主横条是唯一
    // 渲染者，这里只提供**纯数据描述**与命中派发。批量执行贡献由 task-execution 提供（order -20），
    // 这里排在它之后，形成「批量执行 · N」「整理」「解组」。
    const groupStructureActions: Array<{ kind: "tidy" | "ungroup"; order: number }> = [
      { kind: "tidy", order: -19 },
      { kind: "ungroup", order: -18 }
    ];
    const removeGroupStructureActions = groupStructureActions.map(({ kind, order }) =>
      ctx.slots.register("canvas.node-action", {
        id: GROUP_STRUCTURE_ACTION_IDS[kind],
        owner: CANVAS_MENU_PLUGIN_ID,
        order,
        available: ({ nodeType }) => nodeType === "group",
        describe: ({ nodeId }) => {
          const availability = describeGroupStructureAction(structureDeps, kind, nodeId);
          return {
            label: GROUP_STRUCTURE_ACTION_LABELS[kind],
            tone: "neutral" as const,
            enabled: availability.available,
            ...(availability.available ? {} : { reason: availability.reason })
          };
        },
        activate: ({ nodeId, writable }) => {
          if (!writable) return;
          void runGroupStructureAction(structureDeps, kind, nodeId);
        }
      })
    );
    // 多选动作横条的「打组」「解组」贡献（change: 2026-10-16-add-group-selection-toolbar，任务 2.x）：
    // 横条由 Bevy 绘制、Rust 命中，这里只提供**纯数据描述**与命中派发。与右键共用同一
    // `selectionActionDescriptor` 与同一 planner（打组 `planGroupNodes` / 解组 `planUngroupNodes`），
    // 保证两入口同源、同门禁。打组排在解组之前（design D1）。
    const removeSelectionActions = ([
      { kind: "group" as const, order: -30 },
      { kind: "ungroup" as const, order: -29 }
    ]).map(({ kind, order }) =>
      ctx.slots.register("canvas.selection-action", {
        id: SELECTION_ACTION_IDS[kind],
        owner: CANVAS_MENU_PLUGIN_ID,
        order,
        describe: ({ selectedNodeIds, writable }) => {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const nodes = canvas?.document.nodes ?? [];
          const descriptor = selectionActionDescriptor({ nodes, selectedNodeIds, writable, kind });
          if (!descriptor) return null;
          return {
            label: descriptor.label,
            tone: "neutral" as const,
            enabled: descriptor.enabled,
            ...(descriptor.reason ? { reason: descriptor.reason } : {})
          };
        },
        activate: ({ selectedNodeIds, writable }) => {
          if (!writable) return;
          submitSelectionStructure(ctx, kind, selectedNodeIds);
        }
      })
    );
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
          const service = groupRun();
          return nodeContextMenuItems(nodes, selectedNodeIds ?? [], writable, {
            activeNodeId: nodeId,
            nodeData: canvas?.nodeData,
            ...(service ? { groupSubmitting: (groupId: string) => service.isSubmitting(groupId) } : {}),
            ...(service ? { groupPreview: (groupId: string) => service.preview(groupId) } : {})
          });
        }
        // 拉线创建只列出合法可连接节点（创作工具类节点不作为连线目标）
        // （change: 2026-10-10-add-game-furnace-extension，任务 2.4/2.6）。
        // 注意这里**只**过滤复合资产：便签虽然也不能连线，但它在空白右键菜单里必须出现，
        // 所以便签的排除要放到下面的拉线分支里做，不能写在这个共用变量上（写在这里会把
        // 空白右键的入口一起吃掉 —— 踩过，菜单里根本看不到便签）。
        const baseTemplates = NODE_TEMPLATES.filter((template) => template.nodeType !== COMPOSITE_ASSET_NODE_TYPE);
        // 从拍摄镜头预览拉线：只提供视频生成节点（专用镜头参考，D9 / 任务 8.2）。其余项显式禁用并
        // 给出原因，避免「点击后静默失败」。
        if (connectFrom && connectFrom.nodeType === FILM_SET_SHOT_PREVIEW_NODE_TYPE) {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const source = resolveShotReferenceSource(connectFrom.nodeId, canvas?.nodeData[connectFrom.nodeId], id => canvas?.nodeData[id]);
          return shotReferenceTemplateItems(baseTemplates, writable, connectFrom, source?.kind ?? null);
        }
        // 便签归「创作工具」而不是「基础素材」：它是批注，不是可生成/可连线的素材。
        // 拉线创建（`connectFrom`）时排除 —— 便签没有端点，作为连线目标会被规则拒绝。
        const materialTemplates = baseTemplates.filter((template) => template.nodeType !== STICKY_NOTE_NODE_TYPE);
        const stickyTemplates = connectFrom
          ? []
          : baseTemplates.filter((template) => template.nodeType === STICKY_NOTE_NODE_TYPE);
        return [
          ...materialTemplates.map((template) => ({
            id: `insert:${template.id}`,
            label: template.label,
            section: CANVAS_MENU_SECTION.basicMaterial,
            disabled: !writable
          })),
          ...stickyTemplates.map((template) => ({
            id: `insert:${template.id}`,
            label: template.label,
            section: CANVAS_MENU_SECTION.creationTools,
            disabled: !writable
          })),
          // 扩展贡献的通用节点模板（change: 2026-10-10-add-game-furnace-extension，任务 2.4）。
          // 宿主只按通用节点契约合并菜单项，不 import 任何具体扩展内容；拉线创建时排除
          // （通用纯模型扩展节点不能作为连线端点）。`createNodeData` 返回 undefined 时不出现。
          ...(connectFrom ? [] : extensionNodeTemplateItems(ctx, context)),
          { id: "upload", label: "上传…", section: CANVAS_MENU_SECTION.other, disabled: !writable }
        ];
      },
      onSelect: (itemId, context) => {
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
        if (itemId === SELECTION_ACTION_IDS.group) {
          submitGroupSelection(ctx, context);
          return;
        }
        if (itemId === SELECTION_ACTION_IDS.ungroup) {
          submitUngroupSelection(ctx, context);
          return;
        }
        if (itemId === "tidy-group") {
          submitGroupStructure(structureDeps, "tidy", context);
          return;
        }
        if (itemId === "ungroup-group") {
          submitGroupStructure(structureDeps, "ungroup", context);
          return;
        }
        if (itemId === "run-group") {
          submitRunGroup(ctx, context);
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

    // 双击卡片底部标题行 → 打开同一个重命名浮层（事件由 canvas-runtime 转发）。
    const offRenameRequest = ctx.on("ui.node-rename.open-requested", ({ nodeId }) => {
      openRename(nodeId);
    });
    ctx.effect(() => () => offRenameRequest(), "canvas-menu-rename-request");

    // 便签正文浮层。与重命名同一套模式：只读时能看不能存，切换画布/dispose 清空。
    // 浮层位置在 render 时按便签的当前屏幕矩形解析 —— store 里不存几何，免得拖动后位置过期。
    const removeStickyNoteOverlay = ctx.slots.register("canvas.overlay", {
      id: "sticky-note-editor",
      owner: CANVAS_MENU_PLUGIN_ID,
      priority: 30,
      render: () =>
        StickyNoteOverlay({
          store: stickyNoteStore,
          edit: ctx.canvasEdit,
          writable: ctx.canvasSession.isWritable(),
          resolveAnchor: resolveStickyNoteAnchor
        })
    });
    ctx.effect(() => () => {
      removeStickyNoteOverlay();
      stickyNoteStore.close();
    }, "canvas-menu-sticky-note-overlay");

    // 双击便签 → 打开正文浮层（事件由 canvas-runtime 转发）。
    const offStickyNoteRequest = ctx.on("ui.sticky-note.edit-requested", ({ nodeId }) => {
      const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
      const data = canvas?.nodeData[nodeId] as { note?: string } | undefined;
      stickyNoteStore.open(nodeId, typeof data?.note === "string" ? data.note : "");
    });
    ctx.effect(() => () => offStickyNoteRequest(), "canvas-menu-sticky-note-request");

    ctx.effect(() => () => {
      for (const remove of removeGroupStructureActions) remove();
    }, "canvas-menu-group-structure-actions");

    ctx.effect(() => () => {
      for (const remove of removeSelectionActions) remove();
    }, "canvas-menu-selection-actions");

    function openRename(nodeId: string): void {
      const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
      const data = canvas?.nodeData[nodeId] as { title?: string } | undefined;
      nodeRenameStore.open(nodeId, typeof data?.title === "string" ? data.title : "");
    }

    /**
     * 便签浮层的屏幕锚点。
     *
     * 用 runtime 的 `nodeScreenRect`（同一套本地视口 + 拖动预览），而不是自己换算坐标 ——
     * 拖动中的便签也能拿到正确位置，且不会因为缩放/平移而与画布错位。
     */
    function resolveStickyNoteAnchor(nodeId: string): { left: number; top: number; width: number } | null {
      const rect = ctx.canvasRuntime.nodeScreenRect(nodeId);
      return rect ? { left: rect.left, top: rect.top + rect.height, width: rect.width } : null;
    }
  },
  { name: CANVAS_MENU_PLUGIN_ID, inject: ["slots", "canvasSession", "canvasNavigation", "canvasEdit", "canvasRuntime"] }
);

function submitDelete(ctx: Context, nodeId: string): void {
  if (!ctx.canvasSession.isWritable()) return;
  const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
  if (!canvas || !partitionManagedNodeDeletion(canvas.document.nodes, canvas.nodeData, [nodeId]).allowed.length) return;
  void ctx.canvasEdit.record([{ type: "node.remove", nodeIds: [nodeId] }], "删除作品");
}

/** 打组：至少两个顶层非 group 节点 → 一个 group 结构批次
 * （change: add-canvas-node-grouping，任务 3.1）。 */
function submitGroupSelection(ctx: Context, context: ContextMenuContext): void {
  if (!ctx.canvasSession.isWritable()) return;
  const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
  if (!canvasState) return;
  const commands = planGroupNodes(plannerNodes(canvasState), context.selectedNodeIds ?? []);
  if (commands.length === 0) return;
  void ctx.canvasEdit.record(commands, "打组");
}

/** 解组 / 移出选中成员 → 一个结构批次（change: add-canvas-node-grouping，任务 3.1）。 */
function submitUngroupSelection(ctx: Context, context: ContextMenuContext): void {
  if (!ctx.canvasSession.isWritable()) return;
  const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
  if (!canvasState) return;
  const commands = planUngroupNodes(plannerNodes(canvasState), context.selectedNodeIds ?? []);
  if (commands.length === 0) return;
  void ctx.canvasEdit.record(commands, "解组");
}

/**
 * 多选横条的结构动作派发（change: 2026-10-16-add-group-selection-toolbar）。
 *
 * 与右键同一规划器、同一门禁：打组走 `planGroupNodes`、解组走 `planUngroupNodes`，各作为一个受
 * 保护批次提交（一次撤销）。空批次不提交。
 */
function submitSelectionStructure(ctx: Context, kind: "group" | "ungroup", selectedNodeIds: readonly string[]): void {
  if (!ctx.canvasSession.isWritable()) return;
  const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
  if (!canvasState) return;
  const nodes = plannerNodes(canvasState);
  const commands = kind === "group"
    ? planGroupNodes(nodes, selectedNodeIds)
    : planUngroupNodes(nodes, selectedNodeIds);
  if (commands.length === 0) return;
  void ctx.canvasEdit.record(commands, SELECTION_ACTION_LABELS[kind]);
}

/** 固定 groupId 的结构动作（整理/解组）：横条与右键共用同一入口与门禁
 * （change: 2026-10-16-add-group-selection-toolbar，任务 2.1）。 */
function submitGroupStructure(
  deps: GroupStructureDeps,
  kind: "tidy" | "ungroup",
  context: ContextMenuContext
): void {
  const selected = context.selectedNodeIds ?? [];
  if (selected.length !== 1) return;
  runGroupStructureAction(deps, kind, selected[0]!);
}

/**
 * 选区对齐/分布已移除（change: 2026-10-16-add-group-selection-toolbar）：多选动作横条只提供
 * 「打组」「解组」，不提供对齐/等距分布。
 */

/** document 的结构节点 → planner 需要的 `Woohaa3CanvasNode`（补空 data）。 */
function plannerNodes(canvasState: { document: { nodes: readonly { id: string; type: string; position: { x: number; y: number }; width?: number; height?: number; parentId?: string }[] } }) {
  return canvasState.document.nodes.map((node) => ({ ...node, data: {} }));
}

/**
 * 运行单选 group 的全部可运行叶子（change: add-canvas-node-grouping，任务 3.4b；
 * change: 2026-10-16-add-group-selection-toolbar：文案统一为「批量执行」，与横条共用同一 service）。
 *
 * capability 由 Task Execution Plugin 提供；缺失时静默返回（菜单项不会出现）。
 * 提交门禁（只读/提交中）由 `nodeContextMenuItems` 统一判定，这里再复核一次写权限。
 */
function submitRunGroup(ctx: Context, context: ContextMenuContext): void {
  if (!ctx.canvasSession.isWritable()) return;
  const selected = context.selectedNodeIds ?? [];
  if (selected.length !== 1) return;
  const groupRun = ctx.get(GROUP_RUN_SERVICE) as GroupRunService | undefined;
  if (!groupRun) return;
  // 提交中不重复发起（横条与右键共用同一锁）。
  if (groupRun.isSubmitting(selected[0]!)) return;
  void groupRun.runGroup(selected[0]!, { ...context.screen, token: crypto.randomUUID() });
}

function insertNode(ctx: Context, templateId: string, context: ContextMenuContext): void {
  const template = findNodeTemplate(templateId);
  if (!template) return;
  if (!ctx.canvasSession.isWritable()) return;
  const world = context.world;
  // 自包含 3D 节点直接创建时携带完整本地模型定义，不从来源节点读取。
  const nodeData = defaultNodeDataForType(template.nodeType);
  if (nodeData === undefined) return;
  const label = context.connectFrom ? connectLabelFor(context.connectFrom.nodeType, template.nodeType) : "";
  void ctx.canvasEdit.record(
    planInsertNode({
      nodeType: template.nodeType,
      position: world,
      nodeData: context.connectFrom
        ? connectNodeDataFor(
            { id: context.connectFrom.nodeId, type: context.connectFrom.nodeType },
            template.nodeType, [], workingCanvasOf(woohaa3CanvasStore.getState())?.nodeData
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
 * 把 `canvas.node-template` 贡献合并为菜单项（change: 2026-10-10-add-game-furnace-extension，
 * 任务 2.4/2.6）。宿主只按通用节点契约处理：`createNodeData` 返回 undefined 或抛错的模板不产生
 * 菜单项（例如扩展未就绪）；section 缺省「创作工具」，order 缺省排在内置创作工具项之后。
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
