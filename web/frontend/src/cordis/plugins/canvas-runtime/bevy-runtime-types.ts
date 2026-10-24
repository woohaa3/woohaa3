/**
 * Bevy WASM 运行时宿主类型契约
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，从 `bevy-runtime.ts` 拆出以保持
 * 业务单文件 ≤500 行的体积守卫）。
 *
 * 只放类型：模块导出面、查询结果包络、运行时接口。实现与装载逻辑仍在 `bevy-runtime.ts`，
 * 并通过 `export type { ... }` 重导出本处类型，保持既有导入路径不变。
 */
import type {
  CanvasRenderScene,
  CanvasPositionUpdate,
  CanvasObserverUpdate,
  PreparedModelMetadata,
  PreparedModelResource
} from "@woohaa3/contracts";

/** wasm-bindgen 导出的 Bevy 画布模块表面。 */
export type BevyModule = {
  default: (input?: unknown) => Promise<unknown>;
  start: () => void;
  runtime_health?: () => string;
  seed_runtime_generation?: (previous: number) => void;
  set_scene: (json: string) => number;
  set_texture: (id: string, width: number, height: number, rgba: Uint8Array) => void;
  set_image_focus_details?: (manifest:string,pixels:Uint8Array)=>void;
  /** 上传片场媒体平面纹理（键为全局唯一 planeId；change: 2026-10-08-make-film-set-model-only）。 */
  set_model_media_texture?: (id: string, width: number, height: number, rgba: Uint8Array) => void;
  rendered_revision: () => number;
  is_ready: () => boolean;
  /** 请求一次镜头截图（change: 2026-10-07-remove-residual-compatibility —— 直接 Shot Camera 边界）。 */
  request_shot_capture?: (json: string) => void;
  /** 轮询匹配 (requestId, generation) 的结果帧（无则空数组）。 */
  poll_shot_capture?: (requestId: number, generation: number) => Uint8Array;
  /** shot camera 运行时诊断快照 JSON（change: add-reusable-bevy-shot-camera）。 */
  shot_diagnostics?: () => string;
  /**
   * 2D interaction 查询入口（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
   * 只接收坐标/模式 JSON，返回小型语义结果 JSON；绝不接收 scene。
   */
  query_point_hit: (json: string) => string;
  query_marquee: (json: string) => string;
  query_probe: (json: string) => string;
  /** 普通正交画布模型 picking（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。 */
  query_model_pick?: (json: string) => string;
  /** 片场对象 picking（change: 2026-10-09-add-film-set-object-motion-and-editing）。 */
  query_composite_asset_item_pick?: (json: string) => string;
  /** 片场对象世界包围盒（选中反馈/gizmo 定位）。 */
  query_composite_asset_item_bounds?: (json: string) => string;
  /** 模型编辑 gizmo 命中与轴拖动约束（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。 */
  query_gizmo_hit?: (json: string) => string;
  /** 合并准备与注册（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。 */
  prepare_and_register_model_resource?: (json: string) => string;
  prepare_scene_resources?: (json: string) => string;
  /** model asset 派生诊断（JSON）。 */
  model_asset_diagnostics?: () => string;
  /**
   * 纯视口增量提交（change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
   * 返回新的 interaction generation；非法输入抛稳定错误。缺失时能力校验明确失败。
   */
  set_viewport?: (json: string) => number;
  /** Native 专用：排队导航，只在真实接受后回调。 */
  queue_viewport?: (json: string, accepted: (generation: number) => void) => void;
  /** 聚焦观察镜头增量；缺省（旧 WASM）时调度器回退 full。 */
  set_observer?: (json: string) => number;
  observer_capability?: () => string;
  set_positions?: (json: string) => number;
  position_capability?: () => string;
  /** 最近一次完整场景接受的 base generation（base 身份缓存；change: 同上）。 */
  base_scene_generation?: () => number;
  /** 视口能力版本字符串；loader 据非空/匹配校验能力（change: 同上）。 */
  viewport_capability?: () => string;
  /**
   * 场景 wire 能力版本字符串；loader 据非空/匹配校验，旧 WASM 明确拒绝
   * （change: 2026-10-15-add-film-set-overview-lod，design D1）。
   */
  scene_capability?: () => string;
  /**
   * 通用 drop target 查询（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
   * 只接收坐标、generation 与来源排除列表，返回最上层实际节点 identity。
   */
  query_drop_target?: (json: string) => string;
  /** 复合资产范围几何读取（拖动提示消费）。 */
  query_composite_asset_scopes?: (json: string) => string;
  /** 实际工作计数快照（JSON）：世界索引 / pick 候选 / 静态 mesh 重建（change: 同上）。 */
  canvas_work_diagnostics?: () => string;
  /** Native-only background diagnostics; never used for acceptance/picking. */
  async_canvas_work_diagnostics?: () => Promise<string>;
};

/**
 * 2D 点命中语义结果；与 Rust `PointHit` 的 serde 输出同构
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
 */
export type PointHit =
  | { kind: "model-preview"; nodeId: string }
  | { kind: "node"; nodeId: string }
  /** 片场范围命中（纯模型片场，change: 2026-10-08-make-film-set-model-only）。 */
  | { kind: "film-scope"; nodeId: string }
  /**
   * 拍摄镜头预览卡片**内容区**命中
   * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D6）。
   *
   * 只有内容区建立拍摄播放资格；标题区、卡片边框、归属线与相机标记保持普通命中，不作为开播
   * 入口。归属（filmSetNodeId/clipId）由宿主从当前画布权威 nodeData 读取。
   */
  | { kind: "shot-preview"; nodeId: string }
  | { kind: "history"; nodeId: string }
  | { kind: "port"; nodeId: string; side: "input" | "output" }
  | { kind: "resize"; nodeId: string; handle?: string }
  | { kind: "edge"; edgeId: string }
  | { kind: "edge-delete"; edgeId: string }
  /** 多选聚合把手（change: add-multi-select-aggregate-connect）。 */
  | { kind: "aggregate-handle"; direction: "input" | "output" }
  /**
   * 顶部操作横条动作命中（change: 2026-10-13-add-node-to-film-set-shortcut）。
   * 横条由 Bevy 绘制、Rust 命中；`menu` 为真表示命中该动作的独立设置箭头。
   */
  | { kind: "node-action"; nodeId: string; actionId: string; menu: boolean }
  /**
   * 多选动作横条动作命中（change: 2026-10-16-add-group-selection-toolbar）。
   * 锚定选区包围盒、无单一节点身份；`menu` 为真表示命中该项的独立设置箭头。
   */
  | { kind: "selection-action"; actionId: string; menu: boolean };

/** probe 候选（稳定节点 identity 与连接能力）。 */
export type ProbeCandidate = { nodeId: string; direction: "prev" | "next"; connectable: boolean };

/**
 * 复合资产范围几何条目（与 Rust `ScopeGeometryEntry` serde 输出同构）
 * （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
 */
export type CompositeAssetScopeGeometryEntry = {
  nodeId: string;
  /** `rect` / `isometric-diamond`。 */
  shape: "rect" | "isometric-diamond";
  /** 闭合多边形顶点 `[x, y]`（rect 为四角，地面矩形为 top/right/bottom/left）。 */
  vertices: [[number, number], [number, number], [number, number], [number, number]];
  /** 8 抓手中心 `[x, y]`：`n, ne, e, se, s, sw, w, nw`。 */
  handles: [[number, number], [number, number], [number, number], [number, number], [number, number], [number, number], [number, number], [number, number]];
  aabb: [number, number, number, number];
  /** 内容适配基准矩形 `[x, y, width, height]`。 */
  base: [number, number, number, number];
};

/** gizmo 轴拖动约束（与 Rust `AxisDragConstraint` 同构）。 */
export type AxisDragConstraint = { axis: string; direction: [number, number]; worldPerPixel: number };

/** gizmo 命中结果（与 Rust `GizmoHitResult` 同构）。 */
export type GizmoHitResult = {
  available: boolean;
  reason?: string | null;
  handle: string | null;
  constraint?: AxisDragConstraint | null;
  yawConstraint?: { origin: [number, number, number]; u: [number, number, number]; v: [number, number, number]; normal: [number, number, number]; startAngle: number; mode: "plane" | "tangent"; direction: [number, number]; radiansPerPixel: number } | null;
  layoutId?: string | null;
  generation?: number;
  epoch?: number;
};

/** 稳定查询失败原因：未就绪 / generation 过期 / 运行时缺新导出。 */
export type QueryUnavailableReason = "unavailable" | "stale" | "unsupported";

/** 版本化查询结果包络；`ok=false` 时调用方 MUST NOT 开始手势。 */
export type QueryResult<T> =
  | { ok: true; generation: number; value: T }
  | { ok: false; reason: QueryUnavailableReason };

export type BevyRuntime = {
  /** 开发面板读取的累计帧计数；render 完成表示调度完成，不表示 GPU 呈现确认。 */
  getFrameCounters?(): { generation: number; renders: number; updates: number; drawCalls3d?: number } | undefined;
  getRuntimeIssues?(): readonly import("./runtime-issues.js").RuntimeIssue[];
  subscribeRuntimeIssues?(listener: () => void): () => void;
  reportRuntimeIssue?(issue: import("./runtime-issues.js").RuntimeIssue): void;
  clearRuntimeIssue?(key: string): void;
  retryRuntimeIssues?(): void;
  subscribeRuntimeRetry?(listener: () => void): () => void;
  retryVersion?(): number;
  recoverRuntime?(): void;
  getRenderIssues?(): readonly import("./model-resource-failures.js").ModelRenderIssue[];
  subscribeRenderIssues?(listener: () => void): () => void;
  retryFailedModels?(): void;
  /** 最近一次（JS 读取的）不可变资源诊断；只读缓存，不调用 WASM（诊断块）。 */
  getResourceDiagnostics?(): import("./resource-diagnostics.js").ResourceDiagnostics | undefined;
  /** 开发采集边界刷新 Rust 累计诊断；生产不提供（诊断块）。 */
  refreshWorkDiagnostics?(): void;
  backgroundWorkDiagnostics?(): boolean;
  /** Bevy App 是否已 ready（字体/相机就绪）。 */
  isReady(): boolean;
  /** Synchronous owner gate, without crossing the WASM boundary. */
  acceptsPlayback?(): boolean;
  /** 最近已渲染的 2D revision。 */
  renderedRevision(): number;
  /** 当前运行时 generation；每次 WASM 初始化递增（恢复时据此重放资源）。 */
  generation(): number;
  /** 实际工作计数快照（JSON）：供 E2E/排障读取（D1 卡片/边块/容器块重建计数）。 */
  getWorkDiagnostics?(): Record<string, unknown>;
  /**
   * 最近接受的 interaction generation；`setScene` 成功后更新，未接受任何场景时为 0
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D3）。
   * 旧测试 fake 可省略；缺省时查询视为 unavailable。
   */
  interactionGeneration?(): number;
  /**
   * 最近一次**完整场景**接受的 base generation（base 身份）
   * （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
   * 纯视口增量不改动它；runtime 重启清空（返回 0）。
   */
  baseSceneGeneration?(): number;
  /**
   * 提交一次纯视口增量（普通 overview 仅 pan/zoom）
   * （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
   * 成功返回新的 interaction generation；base/version/overview 不合法时抛稳定错误，
   * 由调度器下一帧用最新 full 恢复。缺省（旧 fake/旧 WASM）视为不可用。
   */
  setViewport?(input: { baseSceneGeneration: number; viewport: { x: number; y: number; zoom: number } }): number;
  /** Native 连续导航入口；只排队，点击前由适配器同步结算最新视口。 */
  queueViewport?(input: { baseSceneGeneration: number; viewport: { x: number; y: number; zoom: number } }): void;
  /**
   * 已聚焦节点的朝向增量。成功返回新的 interaction generation，不改 base。
   * 缺省（旧 fake / 旧 WASM）时调度器回退完整 `setScene`。
   */
  setObserver?(input: Omit<CanvasObserverUpdate, "version">): number;
  setPositions?(input: Omit<CanvasPositionUpdate, "version">): number;
  /** 上传/更新一张 RGBA 纹理。 */
  setTexture(id: string, width: number, height: number, rgba: Uint8Array, source?: import("./texture-upload-boundary.js").TextureUploadSource): boolean | void;
  setImageFocusDetails?(frame:import("./focus-details.js").ImageFocusDetails|null):void;
  /** 上传片场媒体平面纹理（键为全局唯一 planeId；change: 2026-10-08-make-film-set-model-only）。 */
  setModelMediaTexture(id: string, width: number, height: number, rgba: Uint8Array, source?: import("./texture-upload-boundary.js").TextureUploadSource): boolean | void;
  /**
   * 注册/复用一份不可变模型资源；同 generation 内相同 resourceKey 只上传一次
   * （change: optimize-model-scene-snapshot-hot-path）。
   */
  registerModelResource(resource: PreparedModelResource): void;
  /**
   * 合并准备与注册：把已规范化 Scene IR 一次性交给 Rust，由其派生兼容 signature/AABB/extent、
   * 注册资源并返回轻量 metadata（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 6.6）。
   * 缺新导出时返回 `null`（调用方保留旧 registration 隔离诊断，不回落 TS 派生）。
   */
  prepareAndRegisterModelResource?(input: {
    sceneVersion: string;
    ops: readonly unknown[];
    opsJson?: string;
    expectedSignature?: string;
    expectedExtent?: number;
  }): PreparedModelMetadata | null;
  /**
   * 提交一份完整快照。先确保快照引用的模型资源已注册，再提交引用场景
   * （严格「先注册资源、后提交引用场景」）。
   */
  setScene(scene: CanvasRenderScene, resources?: ReadonlyMap<string, PreparedModelResource>): void;
  /**
   * 2D 点命中查询。调用方传入最近接受的 interaction generation；过期/未就绪时返回
   * `ok:false`，调用方 MUST NOT 回退到 TS 几何或开始手势
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，design D3）。
   * 旧测试 fake 可省略；缺省时查询视为 unavailable。
   */
  queryPoint?(input: {
    generation: number;
    x: number;
    y: number;
    zoom: number;
    hoveredEdgeId?: string | null;
  }): QueryResult<PointHit | null>;
  /** 2D 框选查询（世界坐标矩形，允许负宽高）。 */
  queryMarquee?(input: {
    generation: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }): QueryResult<string[]>;
  /** drag-touch probe 查询。 */
  queryProbe?(input: {
    generation: number;
    source: string;
    direction: "prev" | "next";
  }): QueryResult<ProbeCandidate[]>;
  /**
   * 通用 drop target 查询：按既有顺序固定最上层实际节点（排除来源），只返回 identity
   * （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D5）。
   * `ok:true` 且 `value=null` 表示查询成功但该点无节点；`ok:false` 时调用方 MUST NOT 回退
   * TS 矩形几何或提交移动。
   */
  queryDropTarget?(input: {
    generation: number;
    x: number;
    y: number;
    excludedIds?: readonly string[];
  }): QueryResult<string | null>;
  /** 复合资产范围几何读取（拖动提示消费；含 shape/四顶点/AABB/基准矩形）。 */
  queryCompositeAssetScopes?(input: {
    generation: number;
  }): QueryResult<CompositeAssetScopeGeometryEntry[]>;
  /**
   * 普通正交画布模型 picking：返回最近 canonical 模型的 identity 与世界 bounds
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，设计 D5）。
   */
  queryModelPick?(input: {
    generation: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }): QueryResult<{ nodeId: string; target: [number, number, number]; radius: number } | null>;
  /**
   * 片场对象 picking：返回 `nodeId` 下最近的稳定 itemId
   * （change: 2026-10-09-add-film-set-object-motion-and-editing）。
   */
  queryCompositeAssetItemPick?(input: {
    nodeId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** 聚焦透视相机投影（对象选择只在聚焦发生）。 */
    projection: { target: [number, number, number]; yaw: number; pitch: number; distance: number };
  }): QueryResult<{ nodeId: string; itemId: string } | null>;
  /**
   * 片场对象世界包围盒（选中反馈/gizmo 定位）
   * （change: 2026-10-09-add-film-set-object-motion-and-editing）。
   */
  queryCompositeAssetItemBounds?(nodeId: string): Array<{ itemId: string; center: [number, number, number]; radius: number; unit: number; yaw: number; worldToLocal?: number[] }>;
  /**
   * 模型编辑 gizmo 命中与轴拖动约束；返回稳定 handle 与（可选）屏幕轴约束
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 5.3/5.4）。
   */
  queryGizmoHit?(input: import("../canvas-shell/model-gizmo-hit.js").GizmoQueryInput): GizmoHitResult | null;
  /**
   * 请求一次镜头截图并等待 RGBA 像素（change: 2026-10-07-remove-residual-compatibility ——
   * 直接 Shot Camera 边界，携带 requestId + rig generation identity）。
   *
   * 相机 pose/lens 由当前 rig 提供（调用方须先提交镜头到 canonical `modelEditor.shot`）；
   * 返回匹配 identity 的帧尺寸与 RGBA 字节，不支持/失败/超时返回 null。
   */
  requestCapture(input: {
    generation: number;
    nodeId: string;
    /** 输出像素尺寸（由镜头画幅派生；缺省回退 16:9）。 */
    width?: number;
    height?: number;
  }): Promise<{ rgba: Uint8Array; width: number; height: number } | null>;
  /** shot camera 运行时诊断快照（rig/preview/gizmo/capture 计数）。 */
  shotDiagnostics(): { rigs: number; previewImages: number; gizmoEntities: number; capturesInFlight: number; capturesQueued: number };
  dispose(): void;
};
