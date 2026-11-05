/// <reference types="vite/client" />
/**
 * 开发/E2E 可读的热路径计数器
 * （change: optimize-model-scene-snapshot-hot-path，任务 5.1；
 *   change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 1.2 —— 增加
 *   序列化/指纹/viewport 提交及 Rust 实际工作计数）。
 *
 * 只统计**确定性事件**（scene build / submit / 模型注册 / 派生元数据 / 跨边界字节 /
 * 序列化 / 指纹 / viewport 提交 / 世界索引与静态 mesh 重建），供单元测试与浏览器性能用例
 * 断言复杂度不变式。生产路径不产生逐帧日志，只累加数字；计数不改变渲染结果。镜像到
 * `globalThis.__canvasSceneDiagnostics` 供 E2E 读取。
 *
 * `worldSnapshotBuilds` / `pickCandidateBuilds` / `meshBuilds` 由 Rust 接受点通过
 * `scene_work_diagnostics` 上报后合并（见 `bevy-runtime.ts`），代表**实际发生**的工作，
 * 不是推测；纯视口路径这些计数不增加。
 */

export type SceneDiagnostics = {
  /** Dev collector only; absent until the renderer supplies these counters. */
  rustRenderMs?: number;
  rustRenderFrames?: number;
  rustRenderQueueMs: number;
  rustRenderPrepareMs: number;
  rustRenderPrepareFrames: number;
  rustGeometryBuilds: number;
  rustGeometryBuildMs: number;
  rustGeometryCacheHits: number;
  lastSceneJsonCodeUnits: number;
  frameExecutions: number;
  frameExecutionMs: number;
  sceneBuildMs: number;
  fingerprintMs: number;
  stringifyMs: number;
  wasmAcceptMs: number;

  /** 已构建的 `CanvasRenderScene` 次数（含被 fingerprint 去重的构建）。 */
  sceneBuilds: number;
  /** 实际提交给 Bevy `set_scene` 的次数。 */
  sceneSubmits: number;
  /** 提交被 fingerprint 短路（未跨边界）的次数。 */
  sceneDedupes: number;
  /** 完整场景 JSON 序列化次数（`JSON.stringify` 场景）。 */
  sceneStringify: number;
  /** `renderSceneFingerprint` 计算次数。 */
  fingerprintBuilds: number;
  /** 纯视口增量提交次数（`set_viewport` 接受）。 */
  viewportSubmits: number;
  /** 聚焦观察镜头增量提交次数（`set_observer` 接受）。 */
  observerSubmits: number;
  /** 最近一次场景提交路由（`full` / `observer` / `viewport` / `positions` / `dedupe`）。 */
  lastSubmitRoute?: string;
  /** 最近一次提交帧的失效原因，便于核对增量路径为何回退。 */
  lastDirtyReasons?: string[];
  positionSubmits: number;
  /** `prepare_and_register_model_resource` 实际调用次数（幂等复用不计）。 */
  modelRegistrations: number;
  /**
   * `declare_model_resource` 实际声明次数
   * （change: 2026-10-23-scale-canvas-media-residency，design D5）。
   *
   * descriptor 声明与 payload 注册分成两次边界调用：同一 key 只声明一次，payload 可在预算
   * 淘汰后重新准备，因此两者计数不同步是正常状态。
   */
  modelDescriptors: number;
  /** `set_model_payload_leases` 提交次数（只有需求投影变化时才提交）。 */
  modelLeaseSubmits: number;
  /** 最近一次 lease 提交后 Rust 报告的淘汰 payload 数（累计）。 */
  modelPayloadEvictions: number;
  /** 重型模型 payload 准备的累计同步耗时（ms；真实主线程时间）。 */
  modelPrepareMs: number;
  /** 单项模型准备的最大同步耗时（ms）。 */
  modelPrepareMaxMs: number;
  /** 已完成的模型 payload 准备次数。 */
  modelPrepareCount: number;
  /** 单项准备超过帧预算的次数（真实超预算项，不是平均）。 */
  modelPrepareOverBudget: number;
  /** 一次场景提交中跨 WASM 边界的字节总量（scene JSON + 资源 payload + viewport JSON）。 */
  boundaryBytes: number;
  /** 模型派生元数据（prepare）次数。 */
  derivedMetadata: number;
  /**
   * 2D interaction 查询次数与解析出的查询字节
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
   */
  interactionQueries: number;
  /** 查询返回 unavailable/stale 的次数（用于验证无 TS fallback 篡改）。 */
  interactionUnavailable: number;
  /** Rust：interaction snapshot 世界索引重建次数（纯视口复用，不增加）。 */
  worldSnapshotBuilds: number;
  /** Rust：模型 picking 候选 AABB 重建次数（纯视口复用，不增加）。 */
  pickCandidateBuilds: number;
  /** Rust：静态 2D mesh 重建次数（纯视口复用，不增加）。 */
  meshBuilds: number;
  cardBlockBuilds: number;
  cardDecorationBuilds: number;
  edgeBlockBuilds: number;
  batchSourceMeshBuilds: number;
};

const state: SceneDiagnostics = {
  rustRenderQueueMs: 0,
  rustRenderPrepareMs: 0,
  rustRenderPrepareFrames: 0,
  rustGeometryBuilds: 0,
  rustGeometryBuildMs: 0,
  rustGeometryCacheHits: 0,
  lastSceneJsonCodeUnits: 0,
  frameExecutions: 0,
  frameExecutionMs: 0,
  sceneBuildMs: 0,
  fingerprintMs: 0,
  stringifyMs: 0,
  wasmAcceptMs: 0,

  sceneBuilds: 0,
  sceneSubmits: 0,
  sceneDedupes: 0,
  sceneStringify: 0,
  fingerprintBuilds: 0,
  viewportSubmits: 0,
  observerSubmits: 0,
  positionSubmits: 0,
  modelRegistrations: 0,
  modelDescriptors: 0,
  modelLeaseSubmits: 0,
  modelPayloadEvictions: 0,
  modelPrepareMs: 0,
  modelPrepareMaxMs: 0,
  modelPrepareCount: 0,
  modelPrepareOverBudget: 0,
  boundaryBytes: 0,
  derivedMetadata: 0,
  interactionQueries: 0,
  interactionUnavailable: 0,
  worldSnapshotBuilds: 0,
  pickCandidateBuilds: 0,
  meshBuilds: 0,
  cardBlockBuilds: 0,
  cardDecorationBuilds: 0,
  edgeBlockBuilds: 0,
  batchSourceMeshBuilds: 0
};

/** 页面级单例（字段可直接读写，便于热路径 `+=`）。 */
export const sceneDiagnostics: SceneDiagnostics = state;

/**
 * 帧内每个步骤的累计墙钟（ms），按 `frameLoop.step` 的操作名分组。
 *
 * `frameExecMs` 只回答"这一帧花了多少"，不回答"花在哪一步"：片场卡片的会话同步、
 * 纹理上传、投影通知都在同一个帧结算里，只有拆到步骤名才能看出是谁把 120Hz 的
 * 8.33ms 预算吃穿。只累加数字，不改返回值或异常。
 */
export const frameStepMs: Record<string, number> = {};

/** 记一次步骤耗时（非有限值或非正值直接丢弃）。 */
export function noteFrameStep(operation: string, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  frameStepMs[operation] = (frameStepMs[operation] ?? 0) + ms;
}

/**
 * v4: time wire encoding and synchronous acceptance, including rejected calls.
 *
 * 计时在所有构建里都做（change: 2026-10-25-enhance-telemetry-performance-collection，D4）：
 * `perf.frame` 要上报窗口内的 wire 编码次数与同步接受耗时之和，而它是产品事实，不是开发期
 * 采集。代价只是两次单调时钟读取，不改变返回值或异常。
 */
export function measureSceneWork<T>(key: "stringifyMs" | "wasmAcceptMs", now: () => number, run: () => T): T {
  const started = now();
  try { return run(); }
  finally { state[key] += Math.max(0, now() - started); }
}

/** Rust 上报计数的最新合并值；用于把累计值差分成增量。 */
const emptyRustCounters = { rustRenderQueueMs: 0, rustRenderPrepareMs: 0, rustRenderPrepareFrames: 0, rustGeometryBuilds: 0, rustGeometryBuildMs: 0, rustGeometryCacheHits: 0, worldSnapshotBuilds: 0, pickCandidateBuilds: 0, meshBuilds: 0, cardBlockBuilds: 0, cardDecorationBuilds: 0, edgeBlockBuilds: 0, batchSourceMeshBuilds: 0 };

const defaultRustOwner = {};
let rustBaselines = new WeakMap<object, typeof emptyRustCounters>();
let renderBaselines = new WeakMap<object, { renderMs: number; renderFrames: number }>();

/**
 * 合并 Rust `scene_work_diagnostics` 上报的累计计数。
 * 只增加（单调），不会因上报缺失而回退。
 */
type GeometryWork = { builtMeshes?: number; buildMs?: number; cacheHits?: number };
export function mergeRustWorkDiagnostics(input: {
  renderStages?: { work?: { queueMs?: number; prepareMs?: number; prepareFrames?: number; renderMs?: number; renderFrames?: number } };
  models?: { geometryWork?: GeometryWork; batchGeometryWork?: GeometryWork };
  snapshotBuilds?: number;
  pickCandidateBuilds?: number;
  meshBuilds?: number;
  cardBlockBuilds?: number;
  cardDecorationBuilds?: number;
  edgeBlockBuilds?: number;
  batchSourceMeshBuilds?: number;
}, owner: object = defaultRustOwner): void {
  const rustCounters = rustBaselines.get(owner) ?? { ...emptyRustCounters };
  rustBaselines.set(owner, rustCounters);
  const apply = (key: keyof typeof rustCounters, value: number | undefined) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const delta = value - rustCounters[key];
    if (delta <= 0) return;
    state[key] += delta;
    rustCounters[key] = value;
  };
  apply("rustRenderQueueMs", input.renderStages?.work?.queueMs);
  apply("rustRenderPrepareMs", input.renderStages?.work?.prepareMs);
  apply("rustRenderPrepareFrames", input.renderStages?.work?.prepareFrames);
  if (import.meta.env.DEV) {
    // 启动窗口的逐帧追踪仍只属于开发构建（它写控制台）；累计帧计数本身在所有构建里都记。
    const baseline = renderBaselines.get(owner) ?? { renderMs: 0, renderFrames: 0 };
    renderBaselines.set(owner, baseline);
    for (const [field, key] of [["renderMs", "rustRenderMs"], ["renderFrames", "rustRenderFrames"]] as const) {
      const value = input.renderStages?.work?.[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0
        || (field === "renderFrames" && !Number.isSafeInteger(value))) continue;
      state[key] = (state[key] ?? 0) + Math.max(0, value - baseline[field]);
      baseline[field] = Math.max(baseline[field], value);
    }
  }
  const work = [input.models?.geometryWork, input.models?.batchGeometryWork];
  const total = (key: keyof GeometryWork) => {
    const values = work.map(entry => entry?.[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
    return values.length ? values.reduce((sum, v) => sum + v, 0) : undefined;
  };
  apply("rustGeometryBuilds", total("builtMeshes"));
  apply("rustGeometryBuildMs", total("buildMs"));
  apply("rustGeometryCacheHits", total("cacheHits"));
  apply("worldSnapshotBuilds", input.snapshotBuilds);
  apply("pickCandidateBuilds", input.pickCandidateBuilds);
  apply("meshBuilds", input.meshBuilds);
  apply("cardBlockBuilds", input.cardBlockBuilds);
  apply("cardDecorationBuilds", input.cardDecorationBuilds);
  apply("edgeBlockBuilds", input.edgeBlockBuilds);
  apply("batchSourceMeshBuilds", input.batchSourceMeshBuilds);
}

/**
 * 重置 JS 侧计数。保留已见过的 Rust 累计基线：下一次同一 owner 的合并按差分计入，
 * 不会把进程生命周期累计再灌进 snapshot（`__canvasSceneDiagnostics.reset()` 的测量窗口）。
 * 新 owner（测试里每次 `{}`）仍从 0 起算。
 */
export function noteSceneSubmitRoute(route: string, reasons: Iterable<string>): void {
  state.lastSubmitRoute = route;
  state.lastDirtyReasons = [...reasons];
}

export function resetSceneDiagnostics(): void {
  delete state.lastSubmitRoute;
  delete state.lastDirtyReasons;
  for (const key of Object.keys(state) as Array<keyof SceneDiagnostics>) {
    if (key === "lastSubmitRoute" || key === "lastDirtyReasons") continue;
    state[key] = 0;
  }
  if (import.meta.env.DEV) {
    delete state.rustRenderMs;
    delete state.rustRenderFrames;
  }
}

/** 供 E2E 读取的只读快照。 */
export function sceneDiagnosticsSnapshot(): SceneDiagnostics {
  return { ...state };
}

/** 把页面级镜像挂到 globalThis（生产无副作用）。 */
function installMirror(): void {
  if (typeof globalThis === "undefined") return;
  (globalThis as unknown as { __canvasSceneDiagnostics?: unknown }).__canvasSceneDiagnostics = {
    snapshot: () => sceneDiagnosticsSnapshot(),
    reset: () => resetSceneDiagnostics()
  };
}

installMirror();
