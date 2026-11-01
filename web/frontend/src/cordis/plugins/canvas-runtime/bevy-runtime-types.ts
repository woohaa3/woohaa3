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
  benchmark_frames?: (enabled?: boolean) => string;
  benchmark_media?: (enabled?: boolean) => string;
  seed_runtime_generation?: (previous: number) => void;
  set_scene: (json: string) => number;
  set_texture: (id: string, width: number, height: number, rgba: Uint8Array, content?: string) => void;
  set_image_focus_details?: (manifest:string,pixels:Uint8Array)=>void;
  /** 上传片场媒体平面纹理（键为全局唯一 planeId；change: 2026-10-08-make-film-set-model-only）。 */
  set_model_media_texture?: (id: string, width: number, height: number, rgba: Uint8Array) => void;
  rendered_revision: () => number;
  is_ready: () => boolean;
  /** 请求一次镜头截图（change: 2026-10-07-remove-residual-compatibility —— 直接 Shot Camera 边界）。 */
  request_shot_capture?: (json: string) => void;
  /** 轮询匹配 (requestId, generation) 的结果帧（无则空数组）。 */
  poll_shot_capture?: (requestId: number, generation: number) => Uint8Array;
  /**
   * 取消仍在 bridge slot 中、尚未路由的截图请求（`requestId` 匹配才生效）。
   *
   * 轮询超时/中止后调用：请求留在 slot 里会持续 pin 归属片场为 High。旧 WASM 可省略，
   * 此时由渲染器侧排队超时兜底。
   */
  cancel_shot_capture?: (requestId: number) => void;
  /**
   * 请求一次页面内模型历史缩略图
   * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
   *
   * 入参是服务端权威脚本派生并校验过的 V2 Scene IR 与稳定 identity；渲染在同一 App 内
   * 一次性离屏完成，不新建 App/context。
   */
  request_history_thumbnail?: (json: string) => void;
  /** 轮询历史缩略图结果帧（布局与截图通道一致；无则空数组）。 */
  poll_history_thumbnail?: (requestId: number, generation: number) => Uint8Array;
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
  /** 模型编辑 gizmo 命中与轴拖动约束（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。 */
  query_gizmo_hit?: (json: string) => string;
  /** 合并准备与注册（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。 */
  prepare_and_register_model_resource?: (json: string) => string;
  /**
   * 声明轻量模型 descriptor（change: 2026-10-23-scale-canvas-media-residency，design D5）。
   * 只登记内容身份与必要 bounds，不注册重型 payload；返回规范化 descriptor JSON。
   */
  declare_model_resource?: (json: string) => string;
  /**
   * 提交当前需求持有的模型 payload lease 并按预算淘汰 cold payload
   * （change: 同上）。返回 `{retained, evicted, evictedKeys, descriptors, cold}`。
   */
  set_model_payload_leases?: (json: string) => string;
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
   * 场景 wire 能力版本字符串；loader 据非空/匹配校验，旧 WASM 明确拒绝。
   */
  scene_capability?: () => string;
  /**
   * 通用 drop target 查询（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
   * 只接收坐标、generation 与来源排除列表，返回最上层实际节点 identity。
   */
  query_drop_target?: (json: string) => string;
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
  | { kind: "node-action"; nodeId: string; actionId: string; menu: boolean };

/** probe 候选（稳定节点 identity 与连接能力）。 */
export type ProbeCandidate = { nodeId: string; direction: "prev" | "next"; connectable: boolean };

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
  /** 性能读数读取的累计帧计数；render 完成表示调度完成，不表示 GPU 呈现确认。开发构建与桌面壳提供。 */
  getFrameCounters?(): {
    generation: number;
    renders: number;
    updates: number;
    drawCalls3d?: number;
    stageQueueMs?: number;
    stageQueueFrames?: number;
    stagePrepareMs?: number;
    stagePrepareFrames?: number;
    stageRenderMs?: number;
    stageRenderFrames?: number;
    drawnInstances?: number;
    stageMainMs?: number;
    stageMainFrames?: number;
    stageModelMs?: number;
    stageModelFrames?: number;
    pacing?: string;
    previews?: string;
  } | undefined;
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
  /** Read-only accepted scene geometry; never serialize its content into reports. */
  acceptedScene?(): CanvasRenderScene | null;
  /** Bounded low frequency diagnostics. Native uses asynchronous RPC. */
  readSceneDiagnostics?(): Promise<import("./diagnostics-reader.js").WorkDiagnosticResult>;
  rendererBackend?(): "native" | "wasm";
  runtimeHealthSnapshot?(): Record<string,unknown> | null;
  /**
   * 最近提交并接受的渲染场景只读快照。
   *
   * LOD 采样用它把「高优先消费者」细分为选中 / 聚焦 / 编辑 / 声明缺失；
   * 旧 fake 可省略，缺省时采样退回笼统的 `high-owner`。
   */
  lastScene?(): unknown;
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
   * 提交当前需求持有的模型 payload lease（resource key 集合），由 Rust 按预算淘汰无 lease 的
   * 重型 payload 并为需求内 cold 项重新准备
   * （change: 2026-10-23-scale-canvas-media-residency，design D5）。
   *
   * 只接受已声明过的模型 key（资产/片场内容身份会被忽略）。需求集合未变化时幂等短路，
   * 因此可在帧前导每帧调用；当前需求内的 cold payload 会在同一调用内补准备。
   */
  setModelPayloadLeases?(keys: Iterable<string>): void;
  /**
   * 覆盖模型准备的单帧并发/时间预算
   * （change: 2026-10-23-scale-canvas-media-residency，design D3 / 任务 2.2、6.1）。
   *
   * 由页面级协调器的集中策略注入：不同媒体 owner 不得各自放宽预算。未调用时用默认策略。
   */
  setModelPrepareBudget?(input: { concurrency: number; budgetMs: number }): void;
  /**
   * 每帧推进有界数量的重型模型准备（change: 2026-10-23-scale-canvas-media-residency，任务 6.1）。
   *
   * 静止帧也必须调用：待准备队列由需求驱动，不能等到下一次场景提交才继续，否则大片模型
   * 永远停在 preparing。无待办时是常量开销。
   */
  advanceModelPreparation?(): void;
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
   * 通用 drop target 查询：按既有顺序固定最上层实际节点（排除来源），只返回 identity。
   * `ok:true` 且 `value=null` 表示查询成功但该点无节点；`ok:false` 时调用方 MUST NOT 回退
   * TS 矩形几何或提交移动。
   */
  queryDropTarget?(input: {
    generation: number;
    x: number;
    y: number;
    excludedIds?: readonly string[];
  }): QueryResult<string | null>;
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
    /**
     * 请求来源的稳定标签（诊断用）：`video-export` / `shot-image` / `shot-recording` /
     * `model-editor`。渲染器把 pin 集合记进本地诊断，只有节点 id 时分辨不出是哪条业务流程
     * 把根按在 High。
     */
    source?: string;
  }): Promise<{ rgba: Uint8Array; width: number; height: number } | null>;
  /** shot camera 运行时诊断快照（rig/preview/gizmo/capture 计数）。 */
  shotDiagnostics(): { rigs: number; previewImages: number; gizmoEntities: number; capturesInFlight: number; capturesQueued: number };
  /**
   * 请求一次模型历史缩略图并等待 RGBA 像素
   * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
   *
   * 入参是服务端权威脚本派生并校验过的 V2 Scene IR；在同一 App 内一次性离屏渲染，
   * 不新建 App/context，也不写规范状态。不支持/失败/超时返回 null。
   *
   * 与 `requestCapture` 共用 latest-wins 单一回读通道，调用方必须串行发送。
   */
  requestHistoryThumbnail?(input: {
    generation: number;
    sceneVersion: string;
    ops: readonly unknown[];
    width?: number;
    height?: number;
  }): Promise<import("./history-thumbnail-poll.js").HistoryThumbnailFrame | null>;
  dispose(): void;
};
