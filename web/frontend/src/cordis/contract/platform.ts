/**
 * 平台 Service 与 typed slot 契约（dialogs、slots、input scopes、selection、
 * parameter preview、task catalog、theme、diagnostics 等）。
 * 从 `contracts.ts` façade 拆分（change: 2026-09-28-split-frontend-god-plugins，task 1.5）。
 */
import type { ComponentType, ReactNode } from "react";
import type { AppThemeSnapshot, CanvasSummary, CanvasTaskCatalog, ServerCanvas } from "@woohaa3/contracts";
import type { CanvasSyncStatus } from "../services/canvas-state/index.js";
import type { CanvasContextMenuItem } from "../plugins/canvas-menu/canvas-context-menu.js";
import type {
  DialogCloseGuard,
  DialogCloseResult,
  DialogDefinition,
  DialogInstance,
  DialogHostApi,
  OpenDialogRequest,
  OpenDialogResult
} from "../services/dialogs/types.js";
export type { DialogCloseGuard, DialogCloseResult } from "../services/dialogs/types.js";
import type { DialogRenderer } from "../services/dialogs/renderer-registry.js";
import type { SelectionSnapshot } from "../services/selection-store.js";
import type { ParameterPatch } from "../services/parameter-preview.js";

export type { CanvasSyncStatus };

/**
 * 片段目录 capability 契约（由 prompt-snippets extension 提供；宿主 Context 只持有契约）。
 *
 * change: 2026-10-10-extract-optional-feature-extensions，design D4：具体 service 实现与 Context
 * 增强属于对应 extension，宿主只公开**契约**供消费者按 capability key 查找；核心不 type-import
 * 包内部实现。实现细节（防抖、serial、缓存）不在契约内。
 */
export type SnippetCatalogFilter = "all" | "builtIn" | "untagged" | { tagId: string };

export type SnippetCatalogState = {
  status: "idle" | "loading" | "ready" | "error";
  items: import("@woohaa3/contracts").PromptSnippet[];
  total: number;
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
  query: string;
  filter: SnippetCatalogFilter;
  activeTagId: string | null;
  counts: { all: number; builtIn: number; untagged: number };
};

export type SnippetCatalogTagState = {
  status: "idle" | "loading" | "ready" | "error";
  items: Array<import("@woohaa3/contracts").PromptSnippetTag & { snippetCount: number }>;
  error: string | null;
};

export type SnippetCatalogMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

export type SnippetCatalogService = {
  getState(): SnippetCatalogState;
  getTagState(): SnippetCatalogTagState;
  subscribe(listener: () => void): () => void;
  setQuery(query: string): void;
  setFilter(filter: SnippetCatalogFilter): void;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
  loadTags(): Promise<void>;
  dispose(): void;
};

/**
 * 当前 Canvas page scope 身份（宿主注入；extension 用它确定目标画布，不假定默认画布）。
 *
 * change: 2026-10-10-extract-optional-feature-extensions，design D2/D6。
 */
export type CanvasScopeService = {
  /** 当前 scope 的稳定 canvasId。 */
  canvasId(): string;
};

/**
 * 受控只读画布 facade（宿主注入；extension MUST NOT import 宿主内部 canvas store）。
 *
 * change: 2026-10-10-extract-optional-feature-extensions，design D4。
 * `getCanvas` 返回 canonical（Yjs 派生、只读）画布；`getWorkingCanvas` 返回含本地未提交预览的
 * working projection（缺失时回退 canonical）。`subscribe` 通知任一只读快照变化。
 */
export type CanvasStoreFacade = {
  getCanvas(): ServerCanvas | null;
  getWorkingCanvas(): ServerCanvas | null;
  subscribe(listener: () => void): () => void;
};

/**
 * 通用扩展画布命令提交能力（change: 2026-10-10-add-game-furnace-extension，design D4）。
 *
 * 扩展把通用语义 `CanvasCommand[]` 经受保护会话提交到 canonical；只读会话拒绝。宿主不出现任何
 * 业务插件分支：命令种类与校验都由 `@woohaa3/contracts` 的 canonical reducer 决定。
 */
export type CanvasCommandsService = {
  /** 会话是否可写（离线/同步未就绪/历史只读时为 false）。 */
  isWritable(): boolean;
  submit(commands: readonly import("@woohaa3/contracts").CanvasCommand[], commandId: string): CanvasCommandsResult;
};
export type CanvasCommandsResult =
  | { ok: true; handle: import("../services/canvas-state/index.js").CommandHandle }
  | { ok: false; reason: string; code?: string };
export type DialogRegistration = {
  definition: DialogDefinition;
  renderer?: DialogRenderer;
};

/**
 * Dialog open pre-commit participant（change: unify-canvas-presentation-navigation，design D4）。
 * 在合法 Dialog 实例进入 stack 前同步运行；返回 false/抛错时拒绝打开且不改变 stack。
 */
export type DialogOpenParticipant = import("../services/dialogs/types.js").DialogOpenParticipant;

/** Dialog Service facade：stack/focus/busy/modal gate 与 owner-scoped registry。 */
export interface DialogsService extends DialogHostApi {
  getSnapshot(): DialogHostSnapshot;
  subscribe(listener: (snapshot: DialogHostSnapshot) => void): () => void;
  top(): DialogInstance | null;
  find(instanceId: string): DialogInstance | null;
  requestCloseTop(): DialogCloseResult;
  requestClose(instanceId?: string): DialogCloseResult;
  /** 注册某类 Dialog 的关闭请求 guard（instance-scoped 调用）；返回注销函数。 */
  registerCloseGuard(dialogId: string, guard: DialogCloseGuard): () => void;
  getDiagnostic(): string | null;
  resolveRenderer(dialogId: string): DialogRenderer | null;
  resolveAlertAction(key: string | undefined): (() => Promise<{ ok: true } | { ok: false; error: string }>) | null;
  isModalActive(): boolean;
  /** 注册 definition + 可选 renderer；重复 ID 抛错并要求调用方回滚。 */
  registerDialog(dialogId: string, registration: DialogRegistration): () => void;
  /** 注册一个异步 alert action；返回注销函数。 */
  registerAlertAction(key: string, action: () => Promise<{ ok: true } | { ok: false; error: string }>): () => void;
  registeredDialogIds(): string[];
  /**
   * 注册 Dialog open pre-commit participant（change: unify-canvas-presentation-navigation）。
   * 在纯校验通过、stack 提交前同步运行；返回 false 时拒绝打开。返回注销函数。
   */
  registerOpenParticipant(participant: DialogOpenParticipant): () => void;
}

export type DialogHostSnapshot = import("../services/dialogs/host-store.js").DialogHostSnapshot;

export type RouteProps = { path: string; navigate: (to: string) => void };
export type CanvasSlotProps = {
  revision: number;
  canvas?: import("@woohaa3/contracts").ServerCanvas | null;
  writable: boolean;
  /**
   * 派生后的同步状态展示模型（change: move-sync-status-to-corner-panel）。
   *
   * 可选：旧调用方（如 media-import overlay、测试）可继续只传 `{ revision, writable }`。
   */
  sync?: import("../sync-status.js").SyncStatusView;
  /**
   * 断线/异常时状态气泡里的「重新连接」动作
   * （change: 2026-10-21-recover-canvas-connection-explicitly）。
   *
   * 由 CanvasHost 从 CanvasSession 派生；宿主渲染状态气泡时据此提供显式恢复入口。
   */
  onReconnect?: () => void;
  /**
   * 当前 node-focus 的节点与 kind；未聚焦为 null
   * （change: 2026-10-10-add-game-furnace-extension：供 extension 聚焦工作区贡献按 owner 判定）。
   */
  focus?: { nodeId: string; kind: string } | null;
  /**
   * 当前是否有模态 Dialog 处于栈顶（宿主由 Dialog Service 派生的**通用**门禁）。
   *
   * 通用工作区贡献据此在模态打开时暂停/停止自身瞬态（如试玩会话、capture）；模态关闭
   * 只**不**恢复，绝不自动重启（change: 2026-10-10-add-game-furnace-extension，design D6）。
   * 宿主不知道任何具体业务，只暴露该通用布尔。
   */
  modalActive?: boolean;
};

export type ContextMenuContext = {
  nodeId: string | null;
  /** 菜单锚点（屏幕坐标用于定位，世界坐标用于插入）。 */
  screen: { x: number; y: number };
  world: { x: number; y: number; z?: number };
  connectFrom?: { nodeId: string; nodeType: string };
  writable: boolean;
  /** 当前节点选择；多选打组/解组不依赖指针下的单个节点。 */
  selectedNodeIds?: readonly string[];
};

/**
 * 提示词片段引用来源
 * （change: add-prompt-snippet-library，design D10 修订）。
 *
 * 产品形态对齐参考实现：**保存**由节点右键菜单触发；**引用**由提示词输入框键入 `#` 触发。
 * Prompt Snippets Plugin 提供本 capability；Task Execution 只按该公共 contract 消费，
 * 不 import 片段目录实现或执行面板内部 mutable singleton。
 */
export type PromptSnippetSearchResult = {
  id: string;
  name: string;
  summary: string;
};

export type PromptSnippetSource = {
  /** 按 query 搜索片段（`#` 引用候选）；空 query 返回最近/内置列表。 */
  search(query: string): Promise<readonly PromptSnippetSearchResult[]>;
  /**
   * 把片段正文 materialize 为目标节点的 token string；未连接素材会降级为可读文本。
   * 片段不存在或无法解析时返回 null。
   */
  materialize(snippetId: string, nodeId: string): string | null;
};

/**
 * 通用「选中节点操作」横条的贡献契约
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1/3.2/3.4 / design D6/D7 修订）。
 *
 * 横条**由 Bevy 在画布场景内绘制、由 Rust interaction snapshot 命中**（整张画布仍是同一张
 * canvas，因此中键/空格/右键拖拽平移与滚轮缩放在横条覆盖区域照常生效）。贡献因此不再贡献 DOM
 * 横条本体，而是：
 * - `describe`：给出**纯数据**动作描述（文案、可用性、是否带设置箭头、模型名摘要）；
 * - `activate`：命中后派发（`menu: true` 表示命中独立设置箭头）；
 * - `settings`（可选）：点击设置箭头后在横条锚点打开的**DOM 弹窗**（复杂 UI 走 DOM）。
 *
 * 宿主只做通用描述收集、绘制数据下发、命中派发与弹窗锚定，MUST NOT import 任何具体扩展实现
 * 或按 film-set ID 分支。下载由宿主自己贡献（`order: 0`）；film-set 通过同一 slot 贡献转换。
 */
export type NodeActionContext = {
  nodeId: string;
  nodeType: string;
  /** 单选节点当前是否可写（来自会话权限）。 */
  writable: boolean;
};

/**
 * 命中上下文：在显示上下文之上标明命中的是本体还是独立设置箭头，并提供**宿主设置弹窗开启器**。
 *
 * 横条由 Bevy 绘制时，宿主是设置 DOM 弹窗的**唯一渲染者**（扩展自身的 `<Popover>` 只在聚焦
 * 标题栏挂载）。因此贡献在一次点击无法直接开始、需要打开就近设置时 MUST 调用
 * `requestSettings()`，由宿主在节点锚点打开本贡献的 `settings` 弹窗；只写扩展内部瞬态
 * `settingsOpen` 在横条模式下没有任何渲染者。
 */
export type NodeActionActivation = NodeActionContext & {
  menu: boolean;
  /** 请求宿主打开本贡献的设置弹窗（`menu: true` 命中已由宿主直接打开，无需再次调用）。 */
  requestSettings: () => void;
};

/** 一个动作的纯数据描述；`null` 表示当前不呈现该动作。 */
export type NodeActionDescriptor = {
  /** 通用动作强调与图标呈现。 */
  tone?: "primary" | "neutral";
  icon?: "download";
  iconOnly?: boolean;
  /** 按钮文案（中文）。 */
  label: string;
  /** 是否可用；false 时仍可命中，由 `activate` 决定是否响应。 */
  enabled: boolean;
  /** 不可用原因（供 tooltip/诊断；无障碍不适用，仅用于呈现）。 */
  reason?: string;
  /** 是否在按钮后附加独立设置箭头（点击派发 `menu: true`）。 */
  menu?: boolean;
  /** 横条右端的模型名摘要（可选）。 */
  summary?: string | null;
};

export type NodeActionContribution = {
  /** 贡献稳定 ID；同一 slot 内重复会启动失败。 */
  id: string;
  /** 拥有者（诊断用）。 */
  owner: string;
  /** 从左到右顺序。 */
  order: number;
  /** 贡献是否在本节点可用；false 时不呈现。 */
  available?: (context: NodeActionContext) => boolean;
  /** 纯数据动作描述；返回 null 表示本节点不呈现。 */
  describe: (context: NodeActionContext) => NodeActionDescriptor | null;
  /** 命中派发；`menu` 为真表示命中独立设置箭头。 */
  activate: (activation: NodeActionActivation) => void;
  /** 设置箭头的 DOM 弹窗内容（复杂 UI 走 DOM）；缺省则 `menu` 动作不打开弹窗。 */
  settings?: import("react").ComponentType<NodeActionSettingsProps>;
};

export type NodeActionSettingsProps = {
  /** 固定来源节点（激活时锁定，不随 selection 变化）。 */
  nodeId: string;
  nodeType: string;
  writable: boolean;
  /** 关闭弹窗（宿主管理开关与锚点）。 */
  onClose: () => void;
};

/**
 * 多选动作横条的选区上下文
 * （change: 2026-10-16-add-group-selection-toolbar，design D1/D2）。
 *
 * 横条锚定选区轴对齐包围盒顶部，没有单一节点身份；因此上下文只携带稳定选区与写权限。
 */
export type SelectionActionContext = {
  /** 当前选区（稳定 canonical nodeId；至少 2 个）。 */
  selectedNodeIds: readonly string[];
  /** 当前会话是否可写。 */
  writable: boolean;
};

/** 多选横条命中上下文（`menu` 为独立设置箭头，当前无贡献使用）。 */
export type SelectionActionActivation = SelectionActionContext & {
  menu: boolean;
};

/**
 * 多选动作横条贡献（change: 2026-10-16-add-group-selection-toolbar）。
 *
 * 与 `canvas.node-action` 同构，但目标从「单个节点」换成「当前选区」：宿主在选中 ≥2 个节点时
 * 按 `order` 收集 `describe`，由 Bevy 在画布内绘制、Rust 命中；命中按 `id` 回传派发。宿主 MUST
 * NOT import 具体扩展实现或按业务 ID 分支。
 */
export type SelectionActionContribution = {
  /** 贡献稳定 ID（= 命中回传的 `actionId`）；同一 slot 内重复会启动失败。 */
  id: string;
  /** 拥有者（诊断用）。 */
  owner: string;
  /** 从左到右顺序。 */
  order: number;
  /** 贡献当前选区是否可用；false 时不呈现。 */
  available?: (context: SelectionActionContext) => boolean;
  /** 纯数据动作描述；返回 null 表示当前不呈现。 */
  describe: (context: SelectionActionContext) => NodeActionDescriptor | null;
  /** 命中派发；`menu` 为真表示命中独立设置箭头。 */
  activate: (activation: SelectionActionActivation) => void;
};

/**
 * 画布目录条目上的动作贡献上下文（`canvas.catalog-item-action` slot）。
 *
 * 宿主在画布切换器里为**每个条目**渲染这些贡献；贡献方按条目状态自行决定是否呈现
 * （例如远端接入扩展只在「仅本机」且已连接时提供「同步远端」）。宿主不认识任何具体
 * 扩展，也不按扩展 ID 分支。
 */
export type CanvasCatalogItemActionProps = {
  /** 该条画布目录条目（含 `sources` / `sync`，供贡献方判断是否可操作）。 */
  entry: CanvasSummary;
  /** 打开（切换到）这张画布；同步动作需要画布在本机被加载才会真正开始推内容。 */
  openCanvas: (canvasId: string) => void;
  /** 动作完成后刷新目录（来源与同步徽标随之更新）。 */
  refreshCatalog: () => Promise<void>;
};

export type CatalogItemActionContribution = {
  /** 贡献稳定 ID；同一 slot 内重复会启动失败。 */
  id: string;
  /** 拥有者（诊断用）。 */
  owner: string;
  /** 越小越靠前。 */
  priority?: number;
  render: ComponentType<CanvasCatalogItemActionProps>;
};


/**
 * 新建画布时可勾选的选项（`canvas.create-option` slot）。
 *
 * 宿主只负责：建完画布后按勾选顺序调用每个贡献的 `apply`，失败如实报出（不回滚画布——
 * 画布已经建好了，回滚会让用户丢掉刚建的东西）。「要不要出现、什么时候可用」由贡献方
 * 自己回答，宿主不认识任何扩展。
 */
export type CanvasCreateOptionContribution = {
  /** 贡献稳定 ID；同一 slot 内重复会启动失败。 */
  id: string;
  /** 拥有者（诊断用）。 */
  owner: string;
  /** 越小越靠前。 */
  priority?: number;
  /** 复选框文案。 */
  label: string;
  /** 一句解释，放在文案下方。 */
  description?: string;
  /** 默认是否勾选；缺省不勾（新建默认本地，同步是显式选择）。 */
  defaultEnabled?: boolean;
  /** 此刻是否应该出现；缺省总是出现。 */
  available?: () => boolean;
  /** 画布建好后执行；失败返回原因，由宿主展示。 */
  apply: (context: { canvasId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
};

export type SlotContributionMap = {
  "app.route": { path: string; render: ComponentType<RouteProps> };
  "canvas.overlay": { render: ComponentType<CanvasSlotProps> };
  /**
   * 画布目录条目上的动作（change: canvas 同步显式化）。
   *
   * 宿主在画布切换器的每个条目旁渲染贡献；贡献方自行判断在本条目是否呈现。用于把
   * 「把这张本地画布同步到远端」这类动作做成**显式操作**，而不是登录后的默认行为。
   */
  "canvas.catalog-item-action": CatalogItemActionContribution;
  /** 新建画布时可勾选的选项（例如「同时同步到远端」）。 */
  "canvas.create-option": CanvasCreateOptionContribution;
  /**
   * 通用「选中节点操作」横条的动作贡献
   * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1 / design D6）。
   *
   * 宿主在单选图片/视频/model3d 时渲染顶部独立横条并按 `order` 排列贡献的动作；下载由宿主自己
   * 贡献。宿主只做通用布局/pointer 隔离/尺寸测量，MUST NOT import 扩展实现或按业务 ID 分支。
   */
  "canvas.node-action": NodeActionContribution;
  /**
   * 多选动作横条的动作贡献
   * （change: 2026-10-16-add-group-selection-toolbar，design D1/D2）。
   *
   * 宿主在选中 ≥2 个节点时渲染顶部独立横条（锚定选区包围盒），按 `order` 排列贡献的动作；横条由
   * Bevy 绘制、Rust 命中。宿主只做通用布局/命中派发/尺寸测量，MUST NOT import 扩展实现或按业务
   * ID 分支。
   */
  "canvas.selection-action": SelectionActionContribution;
  /**
   * 画布左上角顶栏（横向排列的常驻控件；change: 2026-10-13-...，身份/画布选择）。
   *
   * 宿主用一个固定的 flex 行承载贡献，按 priority 从左到右排列：低 priority 在左。
   * 与 `canvas.overlay` 的差别是**不做各自绝对定位**，便于「当前用户」与画布切换器相邻。
   */
  // Tauri 首页概览由完整窗口横栏承载；浏览器保留浮动行。
  "canvas.topbar": { render: ComponentType<CanvasSlotProps> };
  /**
   * 窗口顶栏右侧的紧凑读数（Tauri 横栏）。
   *
   * 与 `canvas.toolbar-status` 的区别是归属：顶栏读数是**窗口装饰的一部分**，在概览与节点聚焦
   * 编辑时都常驻，渲染在横栏靠右（画布控件之后、窗口按钮之前），悬停气泡**向下展开**；
   * 工具栏读数只在右下角控件面板里、气泡向上展开。贡献方按运行宿主自行二选一
   * （例如开发性能面板在桌面进入顶栏、在浏览器留在工具栏），宿主不按扩展 ID 分支。
   *
   * 两个位置共用同一份气泡实现：宿主注入 `renderStatus`，贡献不各自实现 tooltip。
   */
  "canvas.topbar-status": {
    /** 新贡献通过 renderStatus 自行装配气泡；旧贡献缺省由宿主包裹，兼容已加载产物。 */
    wrapsStatus?: boolean;
    render: ComponentType<CanvasSlotProps & {
      renderStatus: (readout: ReactNode, details: ReactNode) => ReactNode;
    }>;
  };
  /** 公共聚焦标题栏的可选贡献；插件拥有其内容和交互。 */
  "canvas.focus-header": { position?: "before-title" | "after-title"; render: ComponentType<{ nodeId: string }> };
  "canvas.toolbar": { render: ComponentType<CanvasSlotProps> };
  /** 工具栏状态位置的紧凑读数；宿主保留同步状态气泡与色调，采用首个可用贡献。 */
  "canvas.toolbar-status": {
    /** 新贡献通过 renderStatus 自行装配气泡；旧贡献缺省由宿主包裹，兼容已加载产物。 */
    wrapsStatus?: boolean;
    render: ComponentType<CanvasSlotProps & {
      /** 将紧凑读数及详情交给宿主，使用同一个状态气泡；不另建采样器。 */
      renderStatus: (readout: ReactNode, details: ReactNode) => ReactNode;
    }>;
  };
  /**
   * 右下角控件面板里的图标动作（紧凑图标按钮；change: unify-canvas-corner-controls）。
   *
   * `tone: "primary"` 用强调色实底表达面板主操作（如 AI 助手）；顺序仍按 priority 升序。
   */
  "canvas.toolbar-action": {
    label: string;
    icon: ComponentType<{ className?: string }>;
    tone?: "primary";
    /** Optional feature-owned contextual guidance around the action button. */
    tooltip?: ComponentType<{ children: ReactNode }>;
    onActivate: () => void;
  };
  "canvas.context-menu": {
    items: (context: ContextMenuContext) => CanvasContextMenuItem[];
    onSelect: (itemId: string, context: ContextMenuContext) => void;
  };
  /**
   * 通用扩展节点模板（change: 2026-10-10-add-game-furnace-extension，design D2）。
   *
   * 扩展声明一个**通用宿主节点**的创建项：宿主据此在 `section`（缺省「创作工具」）插入菜单项，
   * 选中时用 `createNodeData()` 产出的自包含 nodeData 创建 `nodeType` 节点。宿主只按通用
   * 节点契约处理，不 import 任何具体扩展内容，也不出现业务插件专属 node type 或分支；
   * `nodeType` 的合法性由 canonical 规范化与 reducer 校验。拉线创建时模板不作为连线目标（排除）。
   */
  "canvas.node-template": {
    icon?: ComponentType<{ className?: string }>;
    nodeType: string;
    label: string;
    section?: string;
    order?: number;
    /** 创建默认 nodeData；返回 undefined 时该模板不可用（不产生菜单项）。 */
    createNodeData: (context: ContextMenuContext) => import("@woohaa3/contracts").CanvasNodeData | undefined;
  };
  /**
   * 通用 extension 聚焦工作区（change: 2026-10-10-add-game-furnace-extension，design D5）。
   *
   * 扩展为一个 focus kind（如 `"extension"`）提供工作区覆盖层；宿主在 `node-focus` 且 kind 匹配
   * 并通过可选 matches 时渲染该贡献，并隐藏普通画布邻居（工具栏/面板/提示/菜单），使「普通画布与其他 focus mode 不
   * 并行响应」。宿主只按通用 kind/contribution 处理，MUST NOT import 任何具体业务工作区实现。
   * 非模态、铺满内容区或以自身 surface 覆盖；进入/退出由 Canvas Navigation 原子管理。
   */
  "canvas.focus-workspace": {
    /** 提供工作区的 focus kind（须为 CanvasFocusKind 之一）。 */
    kind: string;
    /** 同一 kind 的多个扩展可按当前聚焦节点身份筛选。 */
    matchesFocus?: (input: { canvas: import("@woohaa3/contracts").ServerCanvas | null; focus: { nodeId: string; kind: string } }) => boolean;
    /** 返回不可进入原因；内容/版本校验由工作区 owner 实现。 */
    validate?: (props: CanvasSlotProps) => string | null;
    /**
     * 可选布局配置或可订阅布局快照
     * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D3）。
     *
     * 只描述布局尺寸/开关（工具列宽、播放器占位、检查面板尺寸），**不**携带 DOM 查询或第二
     * runtime。公共宿主据此 + 画布尺寸计算唯一 contentRect；缺省表示公共默认布局。可订阅来源
     * 让工作区把工具开关等局部状态以布局快照上报，公共 provider 不拥有各 editor 的 toolsOpen。
     */
    layout?: import("../focus/layout.js").FocusLayoutSource;
    /**
     * 是否**独占**聚焦表面（design D3/D5）：为 true 时宿主隐藏普通画布邻居（工具栏/面板/提示/
     * 菜单）与通用 overlay，只保留该工作区与 2D 媒体取景；缺省 false 表示工作区叠加在画布之上，
     * 连接栏、历史面板等公共贡献照常呈现。通用扩展工作区（`extension`）为独占，三个 editor 为非独占。
     */
    exclusive?: boolean;
    render: ComponentType<CanvasSlotProps>;
  };
  /**
   * 通用 extension 节点复制 Drop 接收（change: 2026-10-10-add-game-furnace-extension，任务 4.3/4.4）。
   *
   * 拖动一批来源节点在 pointerup 落在某类型的纯模型扩展节点范围内时，宿主按贡献把释放委托给
   * extension；extension 自行读取画布、规划和提交（经通用 `canvasCommands`）。返回 `true` 表示
   * 已消费本次释放（来源节点回位、不提交移动）。宿主只按通用 `nodeType` 命中与 slot 分派，
   * MUST NOT import 任何具体业务收集/项目实现。
   */
  "canvas.node-drop": {
    /** 拖动素材时显示在目标节点遮罩上的提示文案。 */
    dropLabel?: string;
    /** 接收 drop 的目标节点类型（通用类型，如 `composite-asset`）。 */
    nodeType: string;
    /** 同一通用节点类型的多个扩展可按目标身份筛选。 */
    matchesTarget?: (input: { canvas: import("@woohaa3/contracts").ServerCanvas; targetNodeId: string }) => boolean;
    /**
     * 可选：这一批拖动来源是否会被该接收方接收。
     *
     * 拖动提示用它决定是否为目标绘制接收提示——返回 `false` 时不点亮该目标、不显示
     * `dropLabel`，让「拖了不会被接收的素材」在视觉上明确不指向该节点。释放判定仍由
     * `onDrop` 独立完成（未实现时缺省视为接收，保持既有贡献行为）。
     */
    acceptsSources?: (input: {
      canvas: import("@woohaa3/contracts").ServerCanvas;
      targetNodeId: string;
      sourceNodeIds: readonly string[];
    }) => boolean;
    /**
     * 释放事件：`sourceNodeIds` 为拖动来源；返回 `true` 表示已消费（无论接受或明确拒绝，
     * 都不回退成普通移动提交）。
     */
    onDrop: (input: {
      canvas: import("@woohaa3/contracts").ServerCanvas;
      targetNodeId: string;
      sourceNodeIds: readonly string[];
      point: { x: number; y: number };
    }) => boolean;
    /** 可选：拖动预览（如显示「可接收 / 原因」反馈）。 */
    onPreview?: (input: {
      canvas: import("@woohaa3/contracts").ServerCanvas;
      targetNodeId: string;
      sourceNodeIds: readonly string[];
    }) => string | null;
  };
  /**
   * 独立文档工作区呈现（编辑扩展工作区，design D1/D4）。
   *
   * 当 Canvas Navigation mode 为 `document-workspace` 时，宿主渲染**唯一**贡献；它与节点聚焦
   * 互斥，且不伪造画布节点。贡献方自己提供不透明内容背景、取景与输入 owner；宿主只提供内容
   * 矩形布局与 2D 媒体 overlay 的通用清理。
   */
  "canvas.document-workspace": {
    /** 目标文档是否仍可呈现（关闭/失效后宿主原子收敛到 overview）。 */
    isAvailable?: (documentId: string) => boolean;
    /** 可选布局配置（与 `canvas.focus-workspace` 同语义）。 */
    layout?: import("../focus/layout.js").FocusLayoutSource;
    /** 渲染：`document` 是当前活动文档身份；贡献方按它决定呈现哪个文档。 */
    render: ComponentType<CanvasSlotProps & { document?: { documentId: string } | null }>;
  };
  "dialog.renderer": { dialogId: string; render: DialogRenderer };
  /**
   * Provider 凭据弹窗顶部的插件贡献区（change: 2026-10-08-add-chatgpt-oauth-3d-generation）。
   *
   * 由 feature plugin 贡献授权行；弹窗宿主按 priority 渲染在 API Key 条目之前，不硬编码
   * 任何具体 Provider/OAuth 逻辑。
   */
  "agent-assistant.configuration": {
    kind: "login" | "installed" | "api-key";
    label: string;
    render: ComponentType<{ connectionId?: string; onSaved?: (connectionId: string) => void }>;
  };
  "provider-credentials.top": { render: ComponentType<{ requestClose?: () => void }> };
  /**
   * 设置弹窗「插件详情」里的扩展自带设置面板
   * （change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.1/5.2）。
   *
   * 声明了 `settingsPanel` metadata 的站点扩展由设置按需加载其设置贡献；贡献按 `pluginId`
   * 归到对应插件详情。宿主不 import 具体扩展实现；面板只取得 `requestClose`（语境为返回列表）
   * 与 `reportEditState`（dirty/pending 汇总）。
   */
  "settings.plugin-config": {
    /** 归属的插件 id（与插件卡片、站点目录的 extensionId 一致）。 */
    pluginId: string;
    render: ComponentType<import("../plugins/settings/plugin-panels.js").SettingsPanelRenderProps>;
  };
  /**
   * 模型/镜头 authoring 生成入口 UI（change: 2026-10-08-...，任务 6.4 / design D9；2026-10-16-...，任务 9.1 / design D10）。
   *
   * 宿主持有目标身份、门禁与 MCP 指引，并**内置渲染生成面板**（提示词/来源连接选择/提交/会话）。
   * 个人生成插件通过本 slot 只声明来源身份与可用连接，不再贡献面板 UI。
   * 宿主 MUST NOT 导入具体插件的面板或业务实现。
   *
   * `sourceId`/`sourceLabel`（change: 2026-10-16-...，任务 2.4/9.1 / design D10）：
   * 贡献方只声明自己服务的来源（对应连接 `adapterId`）与可用连接。宿主按 owner 可见连接渲染
   * 来源/连接选择，来源覆盖不了；同一来源多个贡献仍按 priority 取首个。
   * 缺省 `sourceId` 时回退到贡献 id，保持既有单一来源兼容。
   */
  "authoring.delivery": {
    resolve(input: { canvasId: string; nodeId: string; data: import("@woohaa3/contracts").CanvasNodeData | undefined }): import("./authoring.js").AssistantDeliveryTarget | null;
  };
  "authoring.generate": {
    /** 面板 UI 由宿主内置渲染（design D10）；贡献方只声明来源身份与可用连接。 */
    render?: import("./authoring.js").AuthoringGenerationComponent;
    sourceId?: string;
    sourceLabel?: string;
  };
  "input.paste": { handle: (event: ClipboardEvent) => boolean | void | Promise<void> };
  "input.drop": {
    handle: (event: DragEvent) => boolean | void | Promise<void>;
    /** dragover 反馈：只有至少一个 contribution 接受该 transfer 时才阻止默认（可选）。 */
    canAccept?: (event: DragEvent) => boolean;
  };
};

export type SlotName = keyof SlotContributionMap;

export type SlotContribution<S extends SlotName> = {
  /** contribution 稳定 ID；同一 slot 内重复 ID 会启动失败。 */
  id: string;
  /** 注册 owner（通常是 Plugin ID），用于诊断。 */
  owner: string;
  /** 越小越靠前；同 priority 按注册序号，再按 ID 稳定排序。 */
  priority?: number;
} & (S extends "canvas.node-action"
  ? { available?: (context: NodeActionContext) => boolean }
  : S extends "canvas.selection-action"
    ? { available?: (context: SelectionActionContext) => boolean }
    : { available?: () => boolean }) & SlotContributionMap[S];

export interface SlotsService {
  register<S extends SlotName>(slot: S, contribution: SlotContribution<S>): () => void;
  list<S extends SlotName>(slot: S): ReadonlyArray<SlotContribution<S>>;
  subscribe(slot: SlotName, listener: () => void): () => void;
  /** 全局版本号，供诊断/测试。 */
  version(): number;
}

export type InputScope = "modal" | "menu" | "editor";

export interface InputScopesService {
  /** 注册一个门禁谓词（例如 modal 打开时返回 true）。 */
  addGate(gate: () => boolean): () => void;
  /** 注册到指定 scope 的门禁谓词；返回注销函数（change: unify-canvas-presentation-navigation）。 */
  addScope(scope: InputScope, gate: () => boolean): () => void;
  isActive(scope: InputScope): boolean;
  /** modal/menu/editor 任一激活时，画布 pointer/keyboard/paste/drop 门禁为 true。 */
  blocksCanvas(): boolean;
  /**
   * 聚焦相机输入门禁（change: fix-model-focus-navigation-and-camera-parity，design D6）。
   *
   * focus 期间只有真正的 modal Dialog 才阻断主观察相机缩放/观察；非模态的 editor/history
   * panel 与菜单 MUST NOT 抢走 focus canvas 上的滚轮/捏合/键盘飞行。
   */
  blocksFocusInput(): boolean;
}

export interface SelectionService {
  getSnapshot(): SelectionSnapshot;
  subscribe(listener: () => void): () => void;
  setFromRuntime(
    raw: { nodeIds: readonly string[]; primaryNodeId: string | null; editingFocus: boolean },
    validNodeIds: ReadonlySet<string>
  ): void;
  setKeyboardActive(active: boolean): void;
  reset(): void;
}

export type ParameterPreviewEntry = { patch: ParameterPatch; deadline: number };

export interface ParameterPreviewService {
  set(nodeId: string, patch: ParameterPatch, deadline?: number): void;
  get(nodeId: string): ParameterPatch | undefined;
  resolve(nodeId: string): void;
  clearAll(): void;
  entries(): ReadonlyMap<string, ParameterPreviewEntry>;
  subscribe(listener: () => void): () => void;
}

export type CatalogState =
  | { status: "loading" }
  | { status: "ready"; catalog: CanvasTaskCatalog }
  | { status: "error"; error: string };

export interface TaskCatalogService {
  getState(): CatalogState;
  subscribe(listener: () => void): () => void;
  load(force?: boolean): Promise<void>;
  /** 站点生成插件/模型策略变化时使目录失效并重取（change: 2026-10-04-...，任务 3.2）。 */
  invalidate(): void;
}

/** Canvas 上空闲占位（feature-owned capability；目前仅保留菜单关闭）。 */
export interface CanvasMenuService {
  close(): void;
}

/**
 * Theme Service（change: unify-application-theme-tokens）。
 *
 * 页面级唯一主题 owner：持有当前合法 snapshot、投影 `--app-*` variables、管理本地选择
 * 生命周期。实现见 `services/theme/service.ts`（AppThemeService），但契约只依赖
 * `@woohaa3/contracts` 的纯类型，避免平台 Service 反向依赖 feature。
 */
export interface ThemeService {
  /** 当前主题 snapshot（订阅后读取；同一引用的原子对象）。 */
  getSnapshot(): AppThemeSnapshot;
  /** 订阅主题变化；返回退订函数。 */
  subscribe(listener: () => void): () => void;
  /** 用完整 preset 原子替换；非法输入整体拒绝并保留上一主题。 */
  setPreset(preset: unknown): { ok: true } | { ok: false; error: string };
  /** 按 id 选择已注册 preset。 */
  select(presetId: string): { ok: true } | { ok: false; error: string };
  /** 注册可由本地选择引用的具名 preset。 */
  registerPreset(presetId: string, preset: unknown): void;
  /** 已注册、可供 `select` 选择的 preset id。 */
  presetIds(): readonly string[];
  /** 把当前 snapshot 写到主题根容器；返回撤销函数。 */
  applyTo(root: HTMLElement): () => void;
  /** 最近一次非法切换的诊断（成功切换后清空）。 */
  diagnostic(): string | null;
  /** 释放：撤销订阅与根容器，不遗留 document 级监听。 */
  dispose(): void;
}

export type {
  DialogDefinition,
  DialogInstance,
  DialogHostApi,
  OpenDialogRequest,
  OpenDialogResult,
  DialogRenderer
};

export type { DialogRendererProps } from "../services/dialogs/renderer-registry.js";
export type { StoredAsset } from "@woohaa3/contracts";
