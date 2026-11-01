/**
 * `CanvasRenderScene` 节点/边/瞬时态 wire 类型（自 `render-scene.ts` 拆出）
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R01）。
 *
 * 只承载发给 Bevy `set_scene` 的快照 wire 结构与本地瞬时呈现态类型；不包含任何投影算法，
 * 也不依赖具体业务领域模块（仅引用叶子 wire 类型）。
 */
import type { AppThemeSnapshot } from "../../theme/index.js";
import type { BevyModelPreview, BevyModelReference } from "./wire-model.js";
import type { BevyNodeKind } from "./node-geometry.js";
import type { BevyRenderDraft, BevyRenderMarquee, BevyRenderSurface } from "./wire-transient.js";

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
 */
// v27: node capability-driven rendering paths.
// v28: optional trusted overview-only emptyPlaceholder; older renderers reject the whole frame.
// v30: group-owned film-set bindings carry prepared source identities;
//      media content keeps a provider identity and schema version.
// v31: group presentations may carry the trusted overview primitive LOD declaration;
//      older renderers would silently keep every group badge at High, so reject mixed combinations.
// v32: group presentations may carry the trusted transparent overview cache declaration;
//      older renderers would ignore it and keep drawing the whole subject every frame,
//      so reject mixed combinations instead of silently dropping the capability.
// v33: scenes carry the document identity (`canvasId`). `revision` is per-document, so a renderer
//      must reset its monotonic revision baseline when the identity changes; older renderers
//      would reject every scene of a canvas whose revision is lower than the previous one's.
// v34: group presentations no longer carry badge scale/resizable flags; the badge is the model
//      itself at the shared canvas model unit, so older renderers would draw a fixed frame.
// v35: groups and film sets are removed. `group`, `compositeAsset`, `aggregateRun`,
//      `shotPreview`, `filmSetGroups`, `shotPreviewLinks` and `selectionActions` are gone;
//      older renderers would keep drawing containers, badges and film-set overlays.
export const CANVAS_RENDER_SCENE_VERSION = "woohaa-canvas-render-scene-v35" as const;

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
  /**
   * 该运行开始的时刻（Unix epoch 毫秒）；节点进度环据此按经过时间估算。
   *
   * 由运行状态投影从该 run 记录（活动面板同一条记录）的 `createdAt` 派生，因此节点与活动面板
   * 用的是**同一个起点**：刷新页面、重建渲染器或换一个渲染实例后，节点进度不会从 0 重新估算。
   * 缺失时渲染器退回「本节点首次进入运行态」的本地时钟（旧协议帧、仅 canonical `taskStatus` 的任务）。
   * （change: 2026-10-31-unify-node-and-activity-progress，design D2）。
   */
  progressStartedAt?: number;
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
   * 卡片分类名覆盖（change: 2026-10-05-bind-model-animation-to-shots）。
   *
   * 默认（缺省）由 Bevy 主题 palette 按 kind 给出分类名；自包含 3D 节点用它区分
   * 「3D 模型」与「导演场」，避免两类都显示同一分类名。
   */
  cardLabel?: string;
  /** 3D 模型轻量引用（仅 model3d 且脚本执行成功时）。 */
  model?: BevyModelReference;
  /** Browser-local orbit view rendered into the card, never into canonical nodeData. */
  modelPreview?: BevyModelPreview;
  /**
   * 节点下方独立历史条呈现（change: 2026-10-12-unify-generation-history-strip，design D4）。
   *
   * 普通内容节点携带；聚合节点与 group 缺失。`dots` 按 createdAt 升序，每个圆点的
   * 状态与当前装饰由 run-state 摘要派生。`truncated` 为被折叠的较早记录数。
   * 只承载浏览器本地派生状态，不进入 ServerCanvas / Y.Doc。
   */
  historyStrip?: BevyHistoryStripPresentation;
};

export type BevyNodeAction = {
  /** 通用动作强调与图标呈现。 */
  tone?: "primary" | "neutral";
  icon?: "download" | "edit";
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
  /**
   * 文档身份（画布 id）。
   *
   * `revision` 是**每张画布各自**的版本号，跨画布没有可比性：渲染器必须按身份重置单调基线，
   * 否则「切到 revision 更小的画布」会被误判为代数倒退而整帧丢弃
   * （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs 的投影保护）。
   */
  canvasId: string;
  revision: number;
  nodes: BevyRenderNode[];
  edges: BevyRenderEdge[];
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
};
