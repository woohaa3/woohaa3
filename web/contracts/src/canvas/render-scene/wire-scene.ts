/**
 * `CanvasRenderScene` 节点/边/瞬时态 wire 类型（自 `render-scene.ts` 拆出）
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R01）。
 *
 * 只承载发给 Bevy `set_scene` 的快照 wire 结构与本地瞬时呈现态类型；不包含任何投影算法，
 * 也不依赖具体业务领域模块（仅引用叶子 wire 类型）。
 */
import type { Aabb } from "../model-transform.js";
import type { AppThemeSnapshot } from "../../theme/index.js";
import type { BevyModelPlacement, BevyModelPreview, BevyModelReference } from "./wire-model.js";
import type { BevyNodeKind } from "./node-geometry.js";
import type { BevyRenderDraft, BevyRenderMarquee, BevyRenderSurface } from "./wire-transient.js";
import type {
  BevyMediaPlanePrimitive,
  BevyOwnershipLinkPrimitive,
  BevyPreviewCardPrimitive,
  BevyRunFeedbackPrimitive
} from "./wire-primitives.js";

/** 通用呈现原语 wire 类型（预览卡片/归属线/运行反馈/媒体平面/受管条目运动）。 */
export * from "./wire-primitives.js";

/**
 * CanvasRenderScene 版本；结构变化时必须升版本。
 *
 * - change: unify-application-theme-tokens —— scene 携带必填 `theme` snapshot，提升为 v2；
 * - change: add-node-endpoint-hover —— 节点端点改为悬停态呈现并新增 `hover` 瞬时态，提升为 v3；
 * - change: add-edge-hover-delete —— `hover` 扩展为节点/连线并新增连线删除按钮，提升为 v4；
 * - change: add-canvas-node-grouping —— 新增 `group` kind、绝对几何投影与 group presentation；
 * - change: optimize-model-scene-snapshot-hot-path —— 模型 Scene IR 从节点内联 payload 拆出为
 *   按内容签名注册的不可变资源，节点只携带 `{ resourceKey, signature, sceneVersion, placement }`；
 * - 合并后：group 投影与模型资源引用并存，场景版本提升为 v6；旧 WASM/Frontend 组合按版本拒绝；
 * - change: add-drag-touch-connections —— 新增单节点拖动中的 Q/E 触碰粘连瞬时投影 `dragAttach`
 *   （操作条、模式、接触目标与待提交边），场景版本提升为 v7；
 * - change: add-multi-select-aggregate-connect —— 新增多选聚合拉线把手的瞬时投影
 *   `aggregateConnect`（左右把手、拖拽方向/指针与待提交边），场景版本提升为 v8；
 * - change: 2026-10-08-add-image-focus-editing-and-unified-node-history —— 图片聚焦引入
 *   `imageFocus`（Camera2d 二维取景瞬时投影）与聚焦工作区可用矩形 `contentRect`，提升为 v9；
 * - Embedded model previews and their local observer poses use v10.
 * - change: 2026-10-09-improve-canvas-workflow（任务 2.2）—— 卡片主标题拆分为作品显示名称
 *   `title` 与次要类型标记 `typeLabel`；`body` 只承载内容预览。提升为 v11。
 * - change: 2026-10-10-add-video-node-focus-workspace —— 视频聚焦引入 `videoFocus`（与
 *   `imageFocus` 共用二维媒体取景语义的独立 wire），提升为 v13（v12 已被内嵌模型预览占用）。
 * - 视频解码/缓冲的本地 `mediaLoading` 呈现状态使用 v14。
 * - change: 2026-10-12-align-film-set-scope-with-isometric-grid —— `BevyCompositeAssetPresentation`
 *   新增通用 `scopeShape`（`rect` | `isometric-diamond`）与 `scopeGround`（模型地面占地），提升为
 *   v15/v16。复合资产类别默认 `isometric-diamond`；旧 WASM 会忽略未知字段并按矩形绘制/命中，
 *   因此必须靠版本同步升级拒绝混合组合。
 * - change: 2026-10-12-unify-generation-history-strip —— 普通节点新增节点下方独立历史条
 *   （`historyStrip`），聚合节点新增运行遮罩投影（`aggregateRun`）。提升为 v17。
 * - change: 2026-10-13-add-node-to-film-set-shortcut —— 节点新增可选 `nodeActions`（顶部操作横条
 *   的动作描述：ID/文案/可用/tone/icon/iconOnly + 模型名摘要），横条以屏幕像素排版。
 *   横条由 Bevy 绘制、Rust 命中，因此内容必须随 scene 下发；提升为 v18，旧 WASM 忽略未知
 *   字段将不绘制横条，故必须版本同步。
 * - change: 2026-10-15-add-film-set-overview-lod —— `BevyCompositeAssetPresentation` 新增可选
 *   通用 `geometryQuality`（`overview-primitives-v1`）总览 primitive LOD 策略声明；旧 WASM 会忽略
 *   未知字段并按 World 一律 High 绘制，故必须版本同步升级拒绝混合组合。提升为 v19。
 * - change: 2026-10-15-add-film-set-shooting-shot-previews —— 预览卡片新增节点内
 *   `shotPreview` 呈现、场景新增派生 `shotPreviewLinks` 归属线集合、动画播放新增
 *   `shot-node-preview` 模式与目标卡片路由；旧 WASM 会忽略未知字段（卡片不绘制预览、
 *   不画归属线、hover 目标错位），因此必须版本同步升级拒绝混合组合。提升为 v20。
 * - change: 2026-10-20-unify-node-execution-feedback —— 圆点身份、预览选择和指针反馈提升为
 *   v21；拒绝忽略 selected/hovered/pressed 的旧 renderer，避免预览与加载反馈不一致。
 * - v23：复合资产新增可信派生 ownershipLinks，使用模型局部锚点与目标节点底部绘制管理虚线。
 * - v24：复合资产增加只读 panel，背景、文字和媒体缩略图由 Bevy 统一呈现。
 * - change: 2026-10-22-enhance-film-set-running-effects —— v22 增加片场执行身份与阶段，
 *   工作相机扫描消费同一摘要，装饰时间留在 renderer。
 * - v24：shotPreview.backdrop 将每镜头背景传至 preview/capture；旧 renderer 会静默忽略，
 *   因此同步提升能力版本，拒绝混合组合。
 * - v25：复合容器面板（文本与引用缩略图）由 Bevy 在画布内绘制；旧 renderer 会忽略该字段，
 *   面板不显示，因此同步提升能力版本拒绝混合组合。
 * - change: 2026-10-23-scale-canvas-media-residency —— v26 起模型引用只需 **轻量 descriptor
 *   已声明**：payload 未驻留是合法 cold/preparing 状态，重型 IR 由需求 lease 与预算淘汰。
 *   旧 renderer 会把 cold 引用当作未知资源并拒绝整帧，因此必须同步提升能力版本。
 * - change: 2026-10-28-generic-extension-content-ownership（任务 4.3）—— 业务呈现字段改为通用
 *   原语：节点 `shotPreview` → 场景 `previewCards`，`shotPreviewLinks`/`compositeAsset.ownershipLinks`
 *   → 场景 `ownershipLinks`，`aggregateRun.filmSet` → 场景 `runFeedback`，
 *   `AnimationPlayback.objects` → `managedItemMotion`，`compositeAsset.media` → `mediaPlanes`，
 *   `filmSetGroups` → `managedItemGroups`；业务语义只经版本化 `payload` 透传。旧 renderer 会忽略
 *   未知字段并少画卡片/归属线/运行反馈，因此必须同步提升能力版本拒绝混合组合。
 * - v30：group-owned film-set bindings 携带 prepared source identities；媒体内容保留 provider
 *   identity 与 schema version。
 * - v31：group presentation 可携带可信的 overview primitive LOD 声明；旧 renderer 会静默把
 *   所有 group 徽标保持在 High，因此必须拒绝混合组合。
 * - v32：通用呈现原语落到上述字段；v31 及更旧版本按版本不匹配拒绝，不能原地改 v31 语义。
 */
export const CANVAS_RENDER_SCENE_VERSION = "woohaa-canvas-render-scene-v32" as const;

/**
 * 受管条目组呈现 schema 版本（原片场 group 渲染 schema）。
 *
 * 组渲染是 owner 提供的通用原语：`ownerMode` 只声明条目如何组合（`model3d`/`image`/`video`
 * 的变换、可见性与资源身份），不含任何扩展 id 或业务字段名。
 */
export const MANAGED_ITEM_GROUP_SCHEMA_VERSION = "woohaa-managed-item-group-v1" as const;

export type BevyManagedItemGroupItem = {
  itemId: string;
  sourceNodeId: string;
  kind: "model3d" | "image" | "video";
  contentKey: string;
  /** Prepared source-card resource identity; group renderers use this instead of a snapshot. */
  resourceKey?: string;
  signature?: string;
  transform: { x: number; y: number; z: number; yaw: number; scale: number };
  visible: boolean;
  diagnostic?: string;
  aspectRatio?: number;
};

export type BevyManagedItemGroup = {
  schemaVersion: typeof MANAGED_ITEM_GROUP_SCHEMA_VERSION;
  ownerNodeId: string;
  /** 组徽标原点（画布坐标）。 */
  origin: { x: number; y: number };
  items: BevyManagedItemGroupItem[];
  ground?: { width: number; depth: number; color?: string };
  ownerTransform?: { x: number; y: number; z: number; yaw: number; scale: number };
  activeItemId?: string | null;
};

/** 与 Rust `GraphNode` 对应。 */
export type BevyRenderNode = {
  id: string;
  type: BevyNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 正文内容预览（不包含作品名称；名称由 `title` 承载）。 */
  body: string;
  /**
   * 主标题：作品显示名称（显式名优先、其次已提交提示词摘要、最后中文默认名）
   * （change: 2026-10-09-improve-canvas-workflow，任务 2.2）。
   */
  title: string;
  /**
   * 次要类型标记（中文）；与主标题分列布局，不挤占名称。
   *
   * 复合资产节点由可信 adapter 声明的**业务类型名**覆盖（如「片场」「游戏炼丹炉」），
   * 否则回落通用内容类型标签（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
   */
  typeLabel: string;
  progress: number;
  busy: boolean;
  /** 浏览器媒体解码/缓冲中的瞬时状态；不表示生成任务正在运行。 */
  mediaLoading?: boolean;
  /** 是否有可显示纹理（图片/视频封面）。 */
  texture: boolean;
  /** 是否绘制右下角 resize 抓手（仅单选节点，change: add-node-resize）。 */
  resizable: boolean;
  /**
   * 是否上传中的幽灵节点（只渲染、不可交互；change: add-paste-import-workflows）。
   * Rust 侧忽略该字段（serde 默认允许未知字段）；前端交互/命中测试据此门禁。
   */
  ghost?: boolean;
  /**
   * group 结构容器（change: add-canvas-node-grouping）。
   *
   * `x/y/width/height` 已由映射层投影为**绝对画布几何**（成员同理）；
   * Bevy 只负责按低 z 画虚线容器，不持有 parentId 或相对坐标。
   */
  group?: BevyGroupPresentation;
  /**
   * 卡片分类名覆盖（change: 2026-10-05-bind-model-animation-to-shots）。
   *
   * 默认（缺省）由 Bevy 主题 palette 按 kind 给出分类名；自包含 3D 节点用它区分
   * 「3D 模型」与「导演场」，避免两类都显示同一分类名。
   */
  cardLabel?: string;
  /** 3D 模型轻量引用（仅 model3d/animation3d 且脚本执行成功时）。 */
  model?: BevyModelReference;
  /** Browser-local orbit view rendered into the card, never into canonical nodeData. */
  modelPreview?: BevyModelPreview;
  /**
   * 片场范围（change: 2026-10-08-make-film-set-model-only）。
   *
   * 纯模型片场不绘制顶部卡片/端口/控件；此字段给出条件性范围虚线框的世界坐标几何，
   * 范围绘制、hover、选择、框选、双击与 drop 命中复用同一份派生几何。缺失时 Rust 使用
   * 节点锚点附近的最小范围（空片场）。
   */
  compositeAsset?: BevyCompositeAssetPresentation;
  /**
   * 节点下方独立历史条呈现（change: 2026-10-12-unify-generation-history-strip，design D4）。
   *
   * 普通内容节点携带；聚合节点与 group 缺失。`dots` 按 createdAt 升序，每个圆点的
   * 状态与当前装饰由 run-state 摘要派生。`truncated` 为被折叠的较早记录数。
   * 只承载浏览器本地派生状态，不进入 ServerCanvas / Y.Doc。
   */
  historyStrip?: BevyHistoryStripPresentation;
  /**
   * 聚合节点运行遮罩（change: 2026-10-12-unify-generation-history-strip，design D5；
   *  change: 2026-10-28-generic-extension-content-ownership 任务 4.3）。
   *
   * 仅聚合节点携带；`active` 表示存在运行中操作，驱动覆盖整个节点范围的半透明遮罩与“运行中”
   * 文案。具体阶段/文案由场景级 `runFeedback` 原语提供；缺失或 `active: false` 表示不绘制。
   */
  aggregateRun?: BevyAggregateRunPresentation;
};

export type BevyNodeAction = {
  /** 通用动作强调与图标呈现。 */
  tone?: "primary" | "neutral";
  icon?: "download" | "edit" | "arrange-horizontal" | "arrange-vertical" | "arrange-grid" | "arrange-diagonal-up" | "arrange-diagonal-down" | "collapse-groups" | "expand-groups";
  iconOnly?: boolean;
  /** 稳定动作 ID；Rust 命中后回传，贡献据此派发。 */
  id: string;
  /** 可见文案（中文）。 */
  label: string;
  /** 是否可用；false 时弱化绘制，仍回传命中由贡献决定是否响应。 */
  enabled: boolean;
  /** 是否为独立设置箭头（图片/视频转换）；箭头自身是独立命中矩形。 */
  menu?: boolean;
};

/** 节点顶部操作横条呈现（change: 2026-10-13-add-node-to-film-set-shortcut）。 */
export type BevyNodeActionsPresentation = {
  /** 从左到右排列的动作。 */
  actions: BevyNodeAction[];
  /** 节点摘要（可选，显示在动作左侧）。 */
  summary?: string;
};

/**
 * 复合资产范围形状（change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D3）。
 *
 * 通用声明：`isometric-diamond` 为复合资产类别默认，即与当前地面投影轴平行的平行四边形
 * （地面宽深相等时为菱形）；可信 adapter 可按严格身份覆盖为 `rect` 轴对齐矩形。宿主与 Rust 只
 * 消费该声明，不按业务 extensionId 分支。
 */
export type CompositeAssetScopeShape = "rect" | "isometric-diamond";

/**
 * 复合资产总览 primitive LOD 策略声明
 * （change: 2026-10-15-add-film-set-overview-lod，design D1）。
 *
 * 通用声明：可信 adapter 按严格身份声明「总览按实际世界投影尺寸选择整场图元细分」。当前唯一
 * 合法值 `overview-primitives-v1`；未声明的 World 用途（普通卡片、炉体、第三方）保持 High。
 * 宿主与 Rust 只消费该声明，不按业务 extensionId、nodeData 形状或历史类型推断资格。
 */
export type CompositeAssetGeometryQuality = "overview-primitives-v1";

/**
 * 复合资产范围呈现（change: 2026-10-08-make-film-set-model-only，design D1；
 *  change: 2026-10-09-add-film-set-object-motion-and-editing 增加对象根映射；
 *  change: 2026-10-12-align-film-set-scope-with-isometric-grid 增加通用形状与地面矩形）。
 *
 * `x/y/width/height` 始终为**内容适配基准矩形**（Rust 侧同一公式派生的最小范围矩形）。复合资产
 * 类别默认 `isometric-diamond`：可见与可交互范围由 `scopeGround`（模型地面占地的等比外扩，四边
 * 平行地面投影轴）派生；**不**把 AABB 写回 width/height。可信 adapter 可按严格身份覆盖为 `rect`，
 * 此时基准矩形即范围框。这是纯派生呈现几何，不写规范文档、不进镜头成片。
 */
export type CompositeAssetEmptyPlaceholder = "brand-plinth-v1";

export type BevyCompositeAssetPresentation = {
  emptyPlaceholder?: CompositeAssetEmptyPlaceholder;
  /** Shared canvas container surface, rendered inside Bevy. */
  panel?: import("../composite-children.js").CompositeContainerPanel;
  rootPlacement?: BevyModelPlacement;
  contentExtent?: number;
  /** 范围形状声明；缺失即复合资产类别默认 `isometric-diamond`。 */
  scopeShape?: CompositeAssetScopeShape;
  /**
   * 总览 primitive LOD 策略声明（change: 2026-10-15-add-film-set-overview-lod，design D1）。
   *
   * 可信 adapter 按严格身份声明 `overview-primitives-v1` 时，运行时按世界相机下的实际模型投影
   * 尺寸为该复合资产根选择整场图元细分；缺失即 World 用途保持 High。只承载派生呈现声明，
   * 不进入 canonical 内容 hash、脚本执行 key 或持久 DTO。
   */
  geometryQuality?: CompositeAssetGeometryQuality;
  /**
   * 范围地面矩形（`isometric-diamond` 时必需）：投影中心 + 沿地面 +x/+z 的半球面尺寸。
   *
   * 由映射层从模型内容局部 AABB + 共同根 + 适配单位派生；Rust 由它展开四顶点与 8 抓手。
   */
  scopeGround?: { cx: number; cy: number; hx: number; hz: number };
  x: number;
  y: number;
  width: number;
  height: number;
  /** 场内媒体平面（图片/视频）；缺失即无媒体平面（change: 2026-10-08-make-film-set-model-only）。 */
  mediaPlanes?: BevyMediaPlanePrimitive[];
  /**
   * 稳定 itemId → 组合作用域根 id（change: 2026-10-09-add-film-set-object-motion-and-editing）。
   * 供对象模式 picking 按 item 分组派生 AABB；缺失即对象 picking 不可用。
   */
  itemRoots?: Record<string, string>;
  itemPlacements?: Record<string, BevyModelPlacement>;
  layoutAabb?: Aabb | null;
};

/**
 * 片场组合信息（change: 2026-10-09-add-film-set-object-motion-and-editing）。
 *
 * 浏览器从 model-scene 组合派生的对象身份与诊断；供渲染层下发 Rust（对象 picking 的 itemRoots）
 * 与 UI 显示对象级诊断。只承载本地派生状态，不进入 canonical。
 */
export type BevyCompositeAssetCompositionInfo = {
  itemRoots: Record<string, string>;
  failures?: Array<{ itemId: string; diagnostic: string }>;
};

/**
 * 兼容别名：媒体平面原语（原 `BevyModelMediaPlane`）。
 * 新调用方应直接用 `BevyMediaPlanePrimitive`；渲染层只消费原语字段。
 */
export type BevyModelMediaPlane = BevyMediaPlanePrimitive;

/**
 * 历史条圆点状态（change: 2026-10-12-unify-generation-history-strip，design D4）。
 *
 * 与 run-state 的操作状态对应但收敛为底条可表达的最小集合：
 * 成功绿点、失败红点、执行中呼吸点、排队/取消/中断/部分成功的可区分语义。
 */
export type BevyHistoryDotState =
  | "succeeded"
  | "failed"
  | "running"
  | "queued"
  | "cancelled"
  | "interrupted"
  | "partial";

/**
 * 单个历史条圆点（change: 2026-10-12-unify-generation-history-strip，design D4）。
 *
 * `current` 表示该圆点对应的版本是节点当前生效版本，由独立装饰（外圈）表达，
 * MUST NOT 挤占状态颜色。
 */
export type BevyHistoryStripDot = {
  /** Local preview selection and pointer feedback, independent of canonical current. */
  selected?: boolean;
  hovered?: boolean;
  pressed?: boolean;
  presentationId?: string;
  operationId?: string;
  recoverable?: boolean;
  state: BevyHistoryDotState;
  current: boolean;
  entryId?: string;
};

/**
 * 节点底部历史条呈现（change: 2026-10-12-unify-generation-history-strip，design D4）。
 *
 * 只承载渲染所需的圆点状态与折叠计数；完整历史列表与详情经受控历史接口按需读取。
 */
export type BevyHistoryStripPresentation = {
  /** 按 createdAt 升序的圆点（有界）。 */
  dots: BevyHistoryStripDot[];
  /** 被折叠（未绘制）的较早记录数；>0 时底条显示折叠提示。 */
  truncated: number;
};

/**
 * 聚合节点运行遮罩呈现（change: 2026-10-12-unify-generation-history-strip，design D5；
 *  change: 2026-10-28-generic-extension-content-ownership 任务 4.3）。
 *
 * 只保留通用布尔；阶段/文案来自场景级 `runFeedback` 原语（`nodeId` 关联）。
 */
export type BevyAggregateRunPresentation = {
  /** 是否存在运行反馈；驱动范围遮罩。 */
  active: boolean;
  /** 减少动态效果偏好下使用静态可区分形态。 */
  reduceMotion?: boolean;
};

/**
 * group 容器的呈现字段（change: add-canvas-node-grouping，design D2）。
 *
 * 只承载渲染所需信息：标题、直接/递归成员计数、是否暴露聚合输出端点。
 * 成员关系仍在 `document.nodes[].parentId`，不在此重复。
 */
export type BevyGroupPresentation = {
  /** 紧凑折叠态，不改变 canonical 成员与展开尺寸。 */
  collapsed?: boolean;
  /** 以模型中点为中心的独立等比显示倍率。 */
  badgeScale?: number;
  /** 仅可写单选组显示徽标自己的缩放把手，含收起态。 */
  badgeResizable?: boolean;
  /**
   * 组容器是否绘制节点顶部操作横条。
   *
   * 普通 group 与片场组都声明该标志：展开/收起、排列、整理/解组等动作由
   * `canvas.node-action` 贡献决定实际呈现；Rust 只消费该声明，不按业务 ID 推断。
   */
  actionBar?: boolean;
  /** 可编辑标题（nodeData.title）；缺省空串。 */
  title: string;
  /** 直接成员数。 */
  memberCount: number;
  /** 递归叶子成员中具备输出能力的数量（>0 才显示聚合输出端点）。 */
  outputCapableLeafCount: number;
  /** Prepared local bounds, without ops/mesh; shared model layout and perimeter input. */
  modelBounds?: { aabb: Aabb; extent: number };
  /**
   * Trusted adapter's overview primitive LOD declaration. Only group-owned scene
   * compositions that opt in (currently film sets) get fraction-based tiers;
   * missing keeps the existing High representation.
   */
  geometryQuality?: CompositeAssetGeometryQuality;
  /** Private run projection: group-header status button; no ledger identity crosses into renderer. */
  runStatus?: { label: string; state: string };
  /** Render-only target emphasis while a node is being released into this group. */
  dropTarget?: boolean;
};

export type BevyRenderEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
};

export type BevyRenderSelection = {
  nodes: string[];
  edge: string | null;
};


// 瞬时呈现态（聚焦/编辑/悬停/拖动/聚合/播放）wire 类型与版本常量。
export * from "./wire-transient.js";
import type {
  BevyAggregateConnect,
  BevyAnimationPlayback,
  BevyDragAttach,
  BevyFocusTransition,
  BevyHover,
  BevyImageFocus,
  BevyModelEditor,
  BevyModelFocus,
  BevyVideoFocus
} from "./wire-transient.js";

/**
 * 上传中导入的「幽灵节点」渲染输入
 * （change: add-paste-import-workflows，design D7 修订）。
 *
 * **只用于渲染**：它不进入 `ServerCanvas` / Y.Doc / IndexedDB。渲染层把它当成一个普通节点，
 * 因此 Bevy 用与真实节点完全相同的卡片外观绘制（同样的边框/图标/端口/状态/进度环）。
 *
 * `id` 必须是将来真实节点的同一个 id：真实节点出现（working projection）后，同 id 的 ghost
 * 会被自动跳过，实现无跳变接管。
 */
export type GhostRenderNode = {
  id: string;
  /** woohaa3 节点类型（image/video/audio/text），用于映射 Bevy palette kind 与尺寸。 */
  nodeType: string;
  x: number;
  y: number;
  /** 节点正文（通常为文件名）。 */
  label?: string;
  /**
   * 诊断状态文案（如「上传中」）。
   *
   * 只供宿主与测试观察（`window.__canvasGhosts`、paste-import e2e）；**不转发给 Bevy**，
   * 节点卡片不显示任何状态文案，上传进度只由 `progress` 驱动的进度环表达。
   */
  status?: string;
  /** 上传进度 0..100（驱动进度环）。 */
  progress?: number;
  /** 是否已有可显示纹理（本地 object URL 已上传）。 */
  texture?: boolean;
};

/** 与 Rust `Scene` 对应；这是发给 Bevy `set_scene` 的唯一快照。 */
export type CanvasRenderScene = {
  version: typeof CANVAS_RENDER_SCENE_VERSION;
  revision: number;
  nodes: BevyRenderNode[];
  edges: BevyRenderEdge[];
  /**
   * 受管条目组原语（change: 2026-10-28-generic-extension-content-ownership 任务 4.3）。
   *
   * 每个 owner 节点声明其受管条目（模型/图片/视频）的材质、变换与可见性；渲染层按通用几何
   * 组合与命中，不读取任何业务字段。旧 `filmSetGroups` 字段已删除。
   */
  managedItemGroups?: BevyManagedItemGroup[];
  /**
   * 预览卡片原语（任务 4.3）：由 owner adapter 投影，渲染层只按通用卡片呈现。
   * 同一 `nodeId` 至多一项；未知/重复项被丢弃。
   */
  previewCards?: BevyPreviewCardPrimitive[];
  /**
   * 归属线原语（任务 4.3）：派生呈现，独立于普通 `edges` 拓扑，不参与端口/删除/重连。
   */
  ownershipLinks?: BevyOwnershipLinkPrimitive[];
  /**
   * 运行反馈原语（任务 4.3）：按 `nodeId` 关联到 owner 节点，驱动通用运行遮罩/扫描装饰。
   * 具体业务身份只出现在 `payload`。
   */
  runFeedback?: BevyRunFeedbackPrimitive[];
  selection: BevyRenderSelection;
  viewport: { x: number; y: number; zoom: number };
  draft: BevyRenderDraft | null;
  /**
   * 框选选区矩形（change: fix-group-and-marquee-preview）。
   * 缺省/`null` 表示当前没有框选。只承载浏览器本地呈现态。
   */
  marquee?: BevyRenderMarquee | null;
  surface: BevyRenderSurface | null;
  /**
   * 当前应用主题 snapshot（change: unify-application-theme-tokens，design D4）。
   *
   * 这是**呈现态**，不进入 canonical canvas 文档/Y.Doc；由 Theme Service 提供，
   * fingerprint 参与 `renderSceneEquals`，仅主题变化也会触发一次 `set_scene`。
   */
  theme: AppThemeSnapshot;
  /**
   * 模型聚焦瞬时投影（change: add-model-focus-viewing）。
   * 缺省表示普通正交画布；携带时 Bevy 切换到透视聚焦并只渲染目标。
   */
  modelFocus?: BevyModelFocus;
  /** Read-only references in focus workspace CSS pixels; original node/model geometry stays intact. */
  modelFocusContext?: { nodeId: string; x: number; y: number; width: number; height: number }[];
  /**
   * 图片聚焦瞬时投影（change: 2026-10-08-add-image-focus-editing-and-unified-node-history，design D2）。
   *
   * 缺省表示普通画布；携带时 Bevy 隐藏节点外框/标题/端口/连线及其它内容，仅显示聚焦图片，
   * 并按本地二维取景平移缩放。只承载浏览器本地呈现态，不进入 ServerCanvas / Y.Doc。
   */
  imageFocus?: BevyImageFocus;
  /**
   * 视频聚焦瞬时投影
   * （change: 2026-10-10-add-video-node-focus-workspace，design D2）。
   *
   * 缺省表示普通画布；携带时 Bevy 隐藏节点外框/标题/端口/连线及其它内容，仅显示聚焦视频的
   * 真实解码纹理，并按本地二维取景平移缩放。与 `imageFocus` 互斥，只承载浏览器本地呈现态，
   * 不进入 ServerCanvas / Y.Doc。
   */
  videoFocus?: BevyVideoFocus;
  /**
   * 模型编辑 gitmo/镜头工具瞬时态（change: add-model-editor-gizmo-shot-capture，design D1/D3）。
   *
   * 携带时 Bevy 在聚焦模型上绘制 placement gizmo 或选中镜头的 shot gizmo/frustum。
   * 只承载浏览器本地编辑态，不进入 ServerCanvas / Y.Doc。
   */
  modelEditor?: BevyModelEditor;
  /**
   * 节点端点 / 连线悬停瞬时态（change: add-node-endpoint-hover，change: add-edge-hover-delete）。
   *
   * 缺省表示无悬停——所有节点端点静止不绘制、所有连线不显示删除按钮。携带时 Bevy 在对应
   * 节点左右中点画「+」圆钮，或在对应连线中点画删除按钮。只承载浏览器本地呈现态，
   * 不进入 ServerCanvas / Y.Doc。
   */
  hover?: BevyHover;
  /**
   * 单节点拖动中的 Q/E 触碰粘连瞬时投影（change: add-drag-touch-connections，design D5）。
   *
   * 缺省表示当前没有粘连拖动；携带时 Bevy 在拖动节点下方绘制操作条、活动触须、
   * 接触反馈与待提交连线预览。只承载浏览器本地呈现态，不进入 ServerCanvas / Y.Doc。
   */
  dragAttach?: BevyDragAttach;
  /**
   * 多选聚合拉线瞬时投影（change: add-multi-select-aggregate-connect，design D5）。
   *
   * 缺省表示当前没有聚合把手；携带时 Bevy 在选区左右绘制聚合把手、活动方向强调与
   * 拖拽虚线预览。只承载浏览器本地呈现态，不进入 ServerCanvas / Y.Doc。
   */
  aggregateConnect?: BevyAggregateConnect;
  /**
   * 活动动画节点播放瞬时投影（change: 2026-10-05-bind-model-animation-to-shots，任务 4.1）。
   *
   * 缺省表示当前无活动动画节点；携带时 Bevy 为该节点独立求值模型姿态与镜头。
   * 只承载浏览器本地呈现态，不进入 ServerCanvas / Y.Doc。
   */
  animationPlayback?: BevyAnimationPlayback;
  /**
   * 公共聚焦过渡进度瞬时更新
   * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D6/D7）。
   *
   * 由 Canvas Runtime scope 的唯一 coordinator 推入；Rust 三维聚焦相机据此求值，不再启动
   * 独立计时。版本化且带 node/runtimeGeneration 身份，旧代或不匹配节点被原子丢弃。
   * 只承载浏览器本地呈现态，不进入 ServerCanvas / Y.Doc。
   */
  focusTransition?: BevyFocusTransition;
  /**
   * 每节点的顶部操作横条描述，按节点 id keyed（change: 2026-10-13-add-node-to-film-set-shortcut）。
   *
   * 横条由 Bevy 在画布内绘制、由 Rust interaction snapshot 命中，因此内容必须随 scene 下发。
   * 缺省或某节点缺失表示该节点不绘制横条。动作世界矩形由 contracts `nodeActionToolbarLayout`
   * 与 Rust 同一公式派生；只承载浏览器本地呈现态与命中所需字段，不进入 ServerCanvas / Y.Doc。
   */
  nodeActions?: Record<string, BevyNodeActionsPresentation>;
  /**
   * 多选动作横条描述（change: 2026-10-16-add-group-selection-toolbar）。
   *
   * 选中 ≥2 个节点时显示，锚定选区轴对齐包围盒顶部；缺省或空表示不绘制。与
   * `nodeActions` 同样由 Bevy 在画布内绘制、Rust 命中，动作矩形由 contracts
   * `nodeActionToolbarLayout` 与 Rust 同一公式派生。只承载浏览器本地呈现态与命中所需字段，
   * 不进入 ServerCanvas / Y.Doc。
   */
  selectionActions?: BevyNodeActionsPresentation;
};
