/**
 * 节点顶部操作横条的**非 React** 宿主：描述收集、命中派发与设置弹窗状态
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1/3.2/3.4/3.6 / design D6/D7 修订）。
 *
 * 横条由 Bevy 绘制、Rust 命中；本模块只做三件纯逻辑的事，便于非渲染单元测试：
 * 1. 把 `canvas.node-action` 贡献的 `describe` 结果聚合成下发给 render scene 的**纯数据**描述
 *    （`nodeActions`），宿主下载与 film-set 转换共用同一接缝；
 * 2. 命中（`{ nodeId, actionId, menu }`）后按贡献 id 派发到对应 `activate`；
 * 3. 维护「设置箭头打开的 DOM 弹窗」状态（复杂 UI 走 DOM），供 React 覆盖层渲染。
 *
 * 宿主 MUST NOT import 任何具体扩展实现或按 film-set ID 分支：actionId 即贡献 id。
 */
import type { BevyNodeAction, BevyNodeActionsPresentation } from "@woohaa3/contracts";
import { decideContentAction } from "@woohaa3/contracts";
import type {
  NodeActionActivation,
  NodeActionContext,
  NodeActionContribution,
  NodeActionDescriptor,
  NodeActionSettingsProps,
  SelectionActionContext,
  SelectionActionContribution
} from "../../contract/platform.js";

/** 设置弹窗的打开状态（宿主管理开关与锚点；内容由贡献提供）。 */
export type NodeActionSettingsState = {
  nodeId: string;
  nodeType: string;
  writable: boolean;
  contributionId: string;
};

/** 聚合结果：下发给 render scene 的描述 + 每个动作 id 归属的贡献。 */
export type NodeActionDescription = {
  presentation: BevyNodeActionsPresentation;
  /** actionId（= 贡献 id）→ 贡献，用于命中派发与设置弹窗内容解析。 */
  owners: Map<string, NodeActionContribution>;
};

const REJECTED = "__content-interaction-rejected";

/** 读取 owner interaction 的门禁；没有声明动作或没有注册表时放行。 */
function contentActionDenial(
  contribution: { contentAction?: import("@woohaa3/contracts").ContentAction },
  context: NodeActionContext | SelectionActionContext
): string | null {
  if (!contribution.contentAction || !context.content) return null;
  if ("selectedNodeIds" in context) {
    for (const id of context.selectedNodeIds) {
      const node = context.nodes?.find((entry) => entry.id === id);
      if (!node) continue;
      const decision = decideContentAction(context.content, contribution.contentAction, node.type, context.nodeData?.[id]);
      if (!decision.allowed) return decision.reason || REJECTED;
    }
    return null;
  }
  const decision = decideContentAction(context.content, contribution.contentAction, context.nodeType, context.nodeData);
  if (decision.allowed) return null;
  return decision.reason || REJECTED;
}

/** 供 `describeActions` 复用的最小贡献形状（单节点横条与多选横条同构）。 */
export type ActionContributionLike<C> = {
  id: string;
  order: number;
  contentAction?: import("@woohaa3/contracts").ContentAction;
  available?: (context: C) => boolean;
  describe: (context: C) => NodeActionDescriptor | null;
};

/** 通用动作描述聚合结果（`owners` 保留原贡献引用，供命中派发）。 */
export type ActionDescription<C, T extends ActionContributionLike<C>> = {
  presentation: BevyNodeActionsPresentation;
  owners: Map<string, T>;
};

/**
 * 收集一组动作贡献的描述（按 `order` 从左到右）
 * （change: 2026-10-13-add-node-to-film-set-shortcut；
 *  change: 2026-10-16-add-group-selection-toolbar：抽成通用，供多选横条复用）。
 *
 * 只有**可用**（`available`）的贡献参与；其 `describe` 返回 null 表示当前目标不呈现。无动作时
 * 返回 null（不绘制横条）。`describe`/`available` 抛错视为该贡献不可用，不中断整条横条。
 */
export function describeActions<C, T extends ActionContributionLike<C>>(input: {
  contributions: ReadonlyArray<T>;
  context: C;
}): ActionDescription<C, T> | null {
  const ordered = [...input.contributions].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  const actions: BevyNodeAction[] = [];
  const owners = new Map<string, T>();
  let summary: string | undefined;
  for (const contribution of ordered) {
    const context = input.context;
    if (contribution.available && !safeAvailable(contribution.available, context)) continue;
    const denied = contentActionDenial(contribution, context as NodeActionContext | SelectionActionContext);
    if (denied === REJECTED) continue;
    let descriptor;
    try {
      descriptor = contribution.describe(context);
    } catch {
      continue;
    }
    if (!descriptor) continue;
    if (denied) {
      descriptor = { ...descriptor, enabled: false, reason: denied };
    }
    const menu = descriptor.menu === true;
    const icon = descriptor.icon === "download" || descriptor.icon === "edit"
      || descriptor.icon === "arrange-horizontal" || descriptor.icon === "arrange-vertical"
      || descriptor.icon === "arrange-grid" || descriptor.icon === "arrange-diagonal-up"
      || descriptor.icon === "arrange-diagonal-down"
      || descriptor.icon === "collapse-groups" || descriptor.icon === "expand-groups"
      ? descriptor.icon
      : undefined;
    actions.push({
      id: contribution.id,
      label: descriptor.label,
      enabled: descriptor.enabled,
      ...(descriptor.tone ? { tone: descriptor.tone } : {}),
      ...(icon ? { icon } : {}),
      ...(descriptor.iconOnly && icon ? { iconOnly: true } : {}),
      ...(menu ? { menu: true } : {})
    });
    owners.set(contribution.id, contribution);
    // 摘要是目标身份（组名/节点数），由排序最靠前的贡献拥有；后续动作的状态原因
    // 仍保留在 descriptor.reason 中，不能覆盖左侧身份摘要。
    if (descriptor.summary && !summary) summary = descriptor.summary;
  }
  if (actions.length === 0) return null;
  return { presentation: { actions, ...(summary ? { summary } : {}) }, owners };
}

/**
 * 收集当前节点的横条动作描述（按 `order` 从左到右）。
 */
export function describeNodeActions(input: {
  contributions: ReadonlyArray<NodeActionContribution>;
  context: NodeActionContext;
}): NodeActionDescription | null {
  return describeActions<NodeActionContext, NodeActionContribution>(input);
}

/**
 * 收集当前选区的多选横条动作描述（按 `order` 从左到右）
 * （change: 2026-10-16-add-group-selection-toolbar）。
 */
export function describeSelectionActions(input: {
  contributions: ReadonlyArray<SelectionActionContribution>;
  context: SelectionActionContext;
}): ActionDescription<SelectionActionContext, SelectionActionContribution> | null {
  return describeActions<SelectionActionContext, SelectionActionContribution>(input);
}

/** 贡献可用性谓词失败视为不可用（不中断整条横条）。 */
function safeAvailable<C>(
  available: (context: C) => boolean,
  context: C
): boolean {
  try {
    return available(context);
  } catch {
    return false;
  }
}

/**
 * 命中派发器：把 Rust 命中的 `{ nodeId, actionId, menu }` 路由到对应贡献。
 *
 * `menu: true` 时优先打开设置弹窗（贡献声明了 `settings`）；否则调用 `activate`，并在命中上下文
 * 中注入宿主的 `requestSettings`——贡献在无法直接开始时据此打开设置弹窗（横条模式下宿主持有
 * 唯一渲染器）。找不到贡献（例如 film-set 已停用）时静默忽略——命中不回退到已删除的 TS 几何。
 */
export function routeNodeActionHit(input: {
  hit: { nodeId: string; actionId: string; menu: boolean };
  context: NodeActionContext;
  contributions: ReadonlyArray<NodeActionContribution>;
  openSettings: (state: NodeActionSettingsState) => void;
}): void {
  const contribution = input.contributions.find((entry) => entry.id === input.hit.actionId);
  if (!contribution || contentActionDenial(contribution, input.context)) return;
  const open = (): void => {
    if (!contribution.settings) return;
    input.openSettings({
      nodeId: input.context.nodeId,
      nodeType: input.context.nodeType,
      writable: input.context.writable,
      contributionId: contribution.id
    });
  };
  if (input.hit.menu) {
    open();
    return;
  }
  const activation: NodeActionActivation = {
    nodeId: input.context.nodeId,
    nodeType: input.context.nodeType,
    writable: input.context.writable,
    menu: false,
    requestSettings: open
  };
  try {
    contribution.activate(activation);
  } catch {
    // 动作自身失败不污染画布输入；错误由贡献内部诊断。
  }
}

/**
 * 多选横条命中派发器：按 `actionId` 路由到 `canvas.selection-action` 贡献
 * （change: 2026-10-16-add-group-selection-toolbar）。
 *
 * 选区横条当前无设置箭头贡献，因此只派发 `activate`。找不到贡献（例如贡献被撤销）时静默忽略。
 */
export function routeSelectionActionHit(input: {
  hit: { actionId: string; menu: boolean };
  context: SelectionActionContext;
  contributions: ReadonlyArray<SelectionActionContribution>;
}): void {
  const contribution = input.contributions.find((entry) => entry.id === input.hit.actionId);
  if (!contribution || contentActionDenial(contribution, input.context)) return;
  try {
    contribution.activate({ ...input.context, menu: input.hit.menu });
  } catch {
    // 动作自身失败不污染画布输入；错误由贡献内部诊断。
  }
}

/** 极简外部 store：设置弹窗状态 + 订阅（供 React `useSyncExternalStore`）。 */
export function createNodeActionSettingsStore() {  let state: NodeActionSettingsState | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    get(): NodeActionSettingsState | null {
      return state;
    },
    open(next: NodeActionSettingsState): void {
      state = next;
      emit();
    },
    close(): void {
      if (state === null) return;
      state = null;
      emit();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export type NodeActionSettingsStore = ReturnType<typeof createNodeActionSettingsStore>;

/** 进程内单例：canvas-shell 插件在命中设置箭头时打开，React 覆盖层订阅渲染。 */
export const nodeActionSettingsStore = createNodeActionSettingsStore();

/** 设置弹窗内容解析：按贡献 id 取 `settings` 组件。 */
export function resolveSettingsComponent(
  contributions: ReadonlyArray<NodeActionContribution>,
  contributionId: string
): import("react").ComponentType<NodeActionSettingsProps> | null {
  const contribution = contributions.find((entry) => entry.id === contributionId);
  return contribution?.settings ?? null;
}
