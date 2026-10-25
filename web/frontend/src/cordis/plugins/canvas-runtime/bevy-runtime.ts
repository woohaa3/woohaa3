/// <reference types="vite/client" />
import { hoverNodeStore } from "../../services/hover-store.js";
import { RuntimeIssues } from "./runtime-issues.js";
import { protectWasmModule } from "./wasm-call-boundary.js";
import { TextureUploadBoundary } from "./texture-upload-boundary.js";
import { ModelResourceFailures } from "./model-resource-failures.js";
import { ModelPayloadScheduler } from "./model-payload-scheduler.js";
import { createModelResourceRegistrar } from "./model-resource-registrar.js";
import { PositionSceneMirror } from "./position-scene-mirror.js";
import { createRuntimeRealm, type RuntimeRealm } from "./runtime-realm.js";
import { RuntimeSupervisor, readRuntimeHealth } from "./runtime-supervisor.js";
/**
 * Bevy WASM 运行时宿主
 * （change: replace-godot-canvas-runtime-with-bevy）。
 *
 * 运行时实现移植自 `xyflow-bevy`：单向快照入口 `set_scene`、keyed 纹理 `set_texture`、
 * `is_ready` / `rendered_revision`。3D 模型随节点快照的 `model` 字段下发，没有独立的
 * `set_model_scene` / shot capture API。
 *
 * 模块/查询/运行时类型契约在 `bevy-runtime-types.ts`（文件体积守卫），此处重导出保持既有
 * 导入路径不变。
 */
import type {
  CanvasRenderScene,
  PreparedModelResource
} from "@woohaa3/contracts";
import { canvasPositionUpdateRequest, modelDescriptorOf, modelDescriptorPayload, modelPayloadLeaseRequest, modelPrepareRequest, CANVAS_RENDER_SCENE_VERSION, CANVAS_VIEWPORT_UPDATE_VERSION, CANVAS_POSITION_UPDATE_VERSION, CANVAS_OBSERVER_UPDATE_VERSION } from "@woohaa3/contracts";

import { sceneDiagnostics, measureSceneWork } from "./scene-diagnostics.js";
import { createRuntimeViewport } from "./runtime-viewport.js";
import { createRuntimeObserver } from "./runtime-observer.js";
import {FocusDetailEncoder} from "./focus-details.js";
import { pollShotCapture } from "./shot-capture-poll.js";
import {
  createQueryBridge,
  encodeCompositeAssetScopesRequest,
  encodeDropTargetRequest,
  encodeGizmoRequest,
  encodeMarqueeRequest,
  encodeModelPickRequest,
  encodePointRequest,
  encodeProbeRequest,
  parseGizmoResult,
  projectCompositeAssetScopes,
  projectDropTarget,
  projectMarquee,
  projectModelPick,
  projectPoint,
  projectProbe,
  projectFilmSetItemPick,
  queryCompositeAssetItemBoundsRaw,
  queryCompositeAssetItemPickRaw
} from "./query-bridge.js";
import type {
  BevyModule,
  BevyRuntime
} from "./bevy-runtime-types.js";

export type {
  AxisDragConstraint,
  BevyModule,
  BevyRuntime,
  CompositeAssetScopeGeometryEntry,
  GizmoHitResult,
  PointHit,
  ProbeCandidate,
  QueryResult,
  QueryUnavailableReason
} from "./bevy-runtime-types.js";

/** 截图输出尺寸（与 Bevy `capture.rs` 一致）。 */
export const CAPTURE_WIDTH = 1280;
export const CAPTURE_HEIGHT = 720;

/** 进程内单调的截图 request id（用于匹配迟到/切换后的旧结果）。 */
let captureRequestSeq = 1;
function nextCaptureRequestId(): number {
  captureRequestSeq += 1;
  return captureRequestSeq;
}

/** 稳定模块诊断标识；实际 glue 在 runtime-realm-entry 通过字面量 import 打包。 */
export const BEVY_WASM_MODULE = "../bevy-wasm/woohaa_bevy_canvas.js";

/** 两个 key 集合是否完全相同（幂等短路用）。 */
function sameKeySet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/**
 * 初始化时校验当前必需 WASM 能力（change: 2026-10-07-remove-residual-compatibility）。
 *
 * 缺失当前资源注册或 Shot Camera capture 导出时抛稳定错误，使宿主呈现明确的版本/能力不匹配，
 * 而不是把能力缺失伪装成截图超时或回退旧边界。
 */
export function assertRequiredCapabilities(module: BevyModule): void {
  const missing: string[] = [];
  if (!module.prepare_and_register_model_resource) missing.push("prepare_and_register_model_resource");
  // change: 2026-10-23-scale-canvas-media-residency —— descriptor 声明与 payload lease 是模型
  // 驻留的必需通道；缺失时明确能力不匹配，不静默回退「引用即常驻整场 IR」。
  if (!module.declare_model_resource) missing.push("declare_model_resource");
  if (!module.set_model_payload_leases) missing.push("set_model_payload_leases");
  if (!module.request_shot_capture) missing.push("request_shot_capture");
  if (!module.poll_shot_capture) missing.push("poll_shot_capture");
  // change: 2026-10-10-optimize-canvas-interaction-hot-path —— 新 Frontend 必须有视口增量
  // 边界；缺失时明确能力不匹配，不静默回退旧 full-scene 接口（design D3 / spec）。
  if (!module.set_viewport) missing.push("set_viewport");
  if (!module.base_scene_generation) missing.push("base_scene_generation");
  if (!module.viewport_capability) missing.push("viewport_capability");
  if (!module.set_positions) missing.push("set_positions");
  if (!module.position_capability) missing.push("position_capability");
  // change: 2026-10-12-align-film-set-scope-with-isometric-grid —— 片场菱形范围要求 drop
  // 目标查询与范围几何读取；缺失时明确能力不匹配，不静默回退 TS 矩形几何（design D5/D8）。
  if (!module.query_drop_target) missing.push("query_drop_target");
  if (!module.query_composite_asset_scopes) missing.push("query_composite_asset_scopes");
  // change: 2026-10-15-add-film-set-overview-lod —— 片场总览 LOD 要求 scene wire 版本同步；
  // 缺失 scene 能力字符串时明确能力不匹配，不静默忽略新增 `compositeAsset.geometryQuality`。
  if (!module.scene_capability) missing.push("scene_capability");
  if (missing.length > 0) {
    throw new Error(`Bevy WASM 缺少必需能力：${missing.join(", ")}`);
  }
  // 场景 wire 版本必须逐字节一致：结构变化时必须同步升级，旧 WASM 明确拒绝。
  const scene = module.scene_capability!();
  if (scene !== CANVAS_RENDER_SCENE_VERSION) {
    throw new Error(`Bevy WASM 场景能力不匹配：${scene || "(空)"} != ${CANVAS_RENDER_SCENE_VERSION}`);
  }
  // 视口 wire 版本必须逐字节一致：结构变化时必须同步升级，旧 WASM 明确拒绝。
  const capability = module.viewport_capability!();
  if (capability !== CANVAS_VIEWPORT_UPDATE_VERSION) {
    throw new Error(`Bevy WASM 视口能力不匹配：${capability || "(空)"} != ${CANVAS_VIEWPORT_UPDATE_VERSION}`);
  }
  const positions = module.position_capability!();
  if (positions !== CANVAS_POSITION_UPDATE_VERSION) {
    throw new Error(`Bevy WASM 位置能力不匹配：${positions || "(空)"} != ${CANVAS_POSITION_UPDATE_VERSION}`);
  }
  // 观察镜头增量是可选能力：旧 WASM 缺导出时调度器回退 full，不阻断装载。
  if (module.observer_capability) {
    const observer = module.observer_capability();
    if (observer !== CANVAS_OBSERVER_UPDATE_VERSION) {
      throw new Error(`Bevy WASM 观察镜头能力不匹配：${observer || "(空)"} != ${CANVAS_OBSERVER_UPDATE_VERSION}`);
    }
  }
}

export type BevyLoaderOptions = {
  /** 动态 import 实现；测试可注入。 */
  importModule?: () => Promise<BevyModule>;
  /** 状态镜像目标；默认 `globalThis`。 */
  target?: typeof globalThis;
  /** 页面退出时取消尚未完成的 renderer 装载。 */
  signal?: AbortSignal;
};

/** 运行时 generation 计数器（进程内单调递增）。 */
let runtimeGeneration = 0;

function nextRuntimeGeneration(): number {
  runtimeGeneration += 1;
  return runtimeGeneration;
}

/** 创建当前页面独占的运行时；同页重复装载由 CanvasRuntimeHost 合并。 */
export function loadBevyRuntime(options: BevyLoaderOptions = {}): Promise<BevyRuntime> {
  return createBevyRuntime(options);
}

async function createBevyRuntime(options: BevyLoaderOptions): Promise<BevyRuntime> {
  const target = options.target ?? (globalThis as typeof globalThis);
  options.signal?.throwIfAborted();

  const issues = new RuntimeIssues();
  let supervisor: RuntimeSupervisor | null = null;
  let realm: RuntimeRealm | null = null;
  let realmFault: string | null = null;
  /** 浏览器 realm 的 iframe 在首个 themed scene 绘制前保持透明，避免切换画布时白闪。 */
  let revealScheduled = false;
  const fault = (reason: string) => {
    realmFault = reason; supervisor?.fail(reason);
  };
  const disposeRealm = () => realm?.dispose();
  const callsAllowed = () => !supervisor || supervisor.phase === "running";
  const loadModule = async (candidate = false) => {
    if (options.importModule) return protectWasmModule(await options.importModule(), issues);
    realmFault = null;
    realm = await createRuntimeRealm(target, fault, options.signal);
    return protectWasmModule(realm.module, issues, () => candidate || callsAllowed());
  };
  let module = await loadModule();
  try {
    await module.default();
    options.signal?.throwIfAborted();
    if (!options.importModule && (!module.runtime_health || !module.seed_runtime_generation)) throw new Error("Bevy WASM 缺少恢复健康协议");

    // 初始化时校验当前必需 WASM 能力（change: 2026-10-07-remove-residual-compatibility）：
    // 缺失必需导出时明确失败，不回退旧注册/把能力缺失伪装成截图超时。
    assertRequiredCapabilities(module);
    if (!options.importModule) readRuntimeHealth(module.runtime_health!());
    module.start();

  } catch (error) { disposeRealm(); throw error; }

  let disposed = false;
  /** 最近一次提交的快照（E2E/排障观察用；change: add-node-endpoint-hover）。 */
  let lastScene: CanvasRenderScene | null = null;
  const positionMirror = new PositionSceneMirror();
  /** 当前运行时 generation；每次创建 runtime 递增（WASM 重启后资源需重放）。 */
  let generation = nextRuntimeGeneration();
  /**
   * 最近接受的 interaction generation
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）：由 Rust `set_scene` 返回值更新。
   * 未接受任何场景时为 0，查询应返回 unavailable。
   */
  let interactionGeneration = 0;
  /**
   * 最近一次**完整场景**接受的 generation（base 身份）
   * （change: 2026-10-10-optimize-canvas-interaction-hot-path，design D3）。
   * `setScene` 成功后更新为返回的 generation；`setViewport` 不改动它。
   */
  let baseSceneGeneration = 0;
  /** 本 generation 内已成功注册的 resource key；重启后清空重放。 */
  const registeredKeys = new Set<string>();
  /** 已声明 descriptor 的 key（可与 payload 驻留分离）。 */
  const declaredKeys = new Set<string>();
  /** 曾声明过 descriptor 的模型内容身份；用于把资产/片场 key 与模型 key 区分开。 */
  const knownModelKeys = new Set<string>();
  /**
   * 最近一次提交场景携带的模型资源（payload 补准备的数据来源）。
   *
   * 只引用 model-scene provider 持有的不可变资源，**不复制** ops：本运行时不再保留整场 IR
   * 副本，否则 payload 淘汰省下的内存会被 replay 缓存抵消（design D5）。
   */
  let lastModelResources: ReadonlyMap<string, PreparedModelResource> = new Map();
  /**
   * 当前需求请求的 payload lease key 集合（内容身份）；`null` 表示尚未收到需求投影。
   *
   * `null` 时沿用保守语义（引用即准备），避免初始化阶段把全部模型降为 cold；
   * 收到第一次投影后才按需求准备/淘汰（design D5）。
   */
  let requestedLeases: Set<string> | null = null;
  /** 已真正提交给 Rust 的 lease 子集（只含已声明过的模型 key）。 */
  let submittedLeases = new Set<string>();
  let leasesSubmitted = false;
  const resourceFailures = new ModelResourceFailures();
  const textures = new TextureUploadBoundary(issues);
  const focusDetails=new FocusDetailEncoder();
  let retryVersion = 0;
  const retryListeners = new Set<() => void>();
  /**
   * 有界模型 payload 准备调度（design D3 / 任务 6.1）。
   *
   * 并发与每帧片段预算只由页面集中策略注入（`setModelPrepareBudget`），默认沿用 policy 的
   * 2 项 / 6ms；`drain` 每帧最多推进这么多项，剩下的留到后续帧。
   */
  const payloadScheduler = new ModelPayloadScheduler({
    now: () => now(),
    concurrency: 2,
    budgetMs: 6,
    isResident: (key) => registeredKeys.has(key),
    hasContent: (key) => lastModelResources.has(key),
    wanted: () => requestedLeases,
    prepare: (key) => {
      const resource = lastModelResources.get(key);
      if (!resource) return;
      registrar.register(resource);
    },
    onPrepared: (key, cost) => {
      resourceFailures.clear(key);
      sceneDiagnostics.modelPrepareMs += cost;
      sceneDiagnostics.modelPrepareMaxMs = Math.max(sceneDiagnostics.modelPrepareMaxMs, cost);
      sceneDiagnostics.modelPrepareCount += 1;
      // 单项超预算计入诊断：真实设备上必须能看到「这一项本身就慢」。
      if (cost > payloadScheduler.budget().budgetMs) sceneDiagnostics.modelPrepareOverBudget += 1;
    },
    onFailed: (key, error) => {
      resourceFailures.fail(key, lastModelResources.get(key), error instanceof Error ? error.message : String(error));
    }
  });
  /**
   * 声明轻量 descriptor 与注册重型 payload 的边界调用
   * （design D5；跨边界细节见 `ModelResourceRegistrar`）。
   */
  const registrar = createModelResourceRegistrar({
    module: () => module,
    declaredKeys,
    registeredKeys,
    knownModelKeys
  });
  /**
   * 声明 descriptor；payload 只在该 key 属于当前需求（或尚未投影）时进入有界准备队列。
   *
   * 两步分成两次边界调用：descriptor 极轻且只需声明一次，payload 可被预算淘汰后按需重建。
   * 缺少 descriptor 通道的旧 runtime 由能力校验在初始化时拒绝（不静默降级）。
   */
  const registerModelResource = (resource: PreparedModelResource): void => {
    registrar.declare(resource);
    if (registeredKeys.has(resource.resourceKey)) return;
    // 尚未投影（`requestedLeases === null`）时保持保守「引用即准备」；投影后由 lease 决定。
    if (requestedLeases && !requestedLeases.has(resource.resourceKey)) return;
    // 走同一个有界准备队列（design D3 / 任务 6.1）：场景一次引用几十个模型时不能在这一次
    // `set_scene` 里同步全部装配完，否则主线程片段预算形同不存在。队列在同一调用内推进到
    // 本帧预算上限，因此单模型场景仍在提交场景前就绪。
    payloadScheduler.enqueue(resource.resourceKey);
  };
  /**
   * 为当前需求（lease 内）的模型准备重型 payload。
   *
   * 单个失败只隔离该内容：descriptor 已声明，场景引用仍合法（显示 preparing 卡片）；
   * 内容变化或显式重试后再准备。
   *
   * 预算（design D3 / 任务 6.1）：同一帧最多推进 `modelPrepareConcurrency` 项、累计
   * `modelPrepareBudgetMs` 毫秒，其余留在队列由后续帧继续（见 `ModelPayloadScheduler`）。
   */
  const preparePayloadsForLeases = (keys: ReadonlySet<string>): void => {
    payloadScheduler.enqueueAll(keys);
    payloadScheduler.drain();
  };
  /** 每帧推进有界数量的待准备 payload。 */
  const drainPendingPayloads = (): void => {
    payloadScheduler.drain();
  };
  /**
   * 把当前需求投影成模型 payload lease 提交给 Rust，并为需求内 cold 项补准备
   * （change: 2026-10-23-scale-canvas-media-residency，design D5）。
   *
   * 顺序固定：先提交 lease（此后淘汰只发生在需求之外），再准备 payload。反过来会把刚重建
   * 的 payload 暴露给本轮淘汰。
   *
   * 需求集合未变化时幂等短路：静止帧不跨边界提交 lease。尚未收到需求投影时不做任何事，
   * 由 `setScene` 走保守的「引用即准备」。
   */
  const submitModelLeases = (): boolean => {
    if (disposed || !requestedLeases) return false;
    const next = new Set<string>();
    for (const key of requestedLeases) {
      // 只有已声明为模型资源的 key 才可能持有 payload；资产/片场内容身份不是模型。
      if (knownModelKeys.has(key)) next.add(key);
    }
    if (leasesSubmitted && sameKeySet(submittedLeases, next)) return false;
    submittedLeases = next;
    leasesSubmitted = true;
    if (!module.set_model_payload_leases) {
      throw new Error("Bevy 运行时缺少 set_model_payload_leases 边界");
    }
    const report = JSON.parse(
      module.set_model_payload_leases(modelPayloadLeaseRequest(next))
    ) as { retained?: unknown; evicted?: unknown; evictedKeys?: unknown; residentKeys?: unknown };
    sceneDiagnostics.modelLeaseSubmits += 1;
    // Rust 侧已淘汰的 payload 不再驻留；重新取得需求时必须重准备。`residentKeys` 是权威账本：
    // payload 也可能被其它注册调用顺带淘汰，只信「本轮注册成功」会把 cold 当成 ready。
    const resident = new Set(
      Array.isArray(report.residentKeys)
        ? report.residentKeys.filter((key): key is string => typeof key === "string" && !!key)
        : []
    );
    const evicted = Array.isArray(report.evictedKeys)
      ? report.evictedKeys.filter((key): key is string => typeof key === "string" && !!key)
      : [];
    for (const key of evicted) resident.delete(key);
    for (const key of next) registeredKeys.delete(key);
    for (const key of resident) registeredKeys.add(key);
    sceneDiagnostics.modelPayloadEvictions += typeof report.evicted === "number" ? report.evicted : evicted.length;
    preparePayloadsForLeases(next);
    return true;
  };
  /**
   * 记录当前需求的内容身份，并立即尝试提交（投影早于首次场景时只记录，等 descriptor 声明）。
   */
  const setModelPayloadLeases = (keys: Iterable<string>): void => {
    if (disposed) return;
    const next = new Set<string>();
    for (const key of keys) if (typeof key === "string" && key) next.add(key);
    if (requestedLeases && sameKeySet(requestedLeases, next)) return;
    requestedLeases = next;
    // 需求投影是独立的帧前导入口（先于 `setScene`）：它也算一个准备帧，否则上一帧残留的
    // 预算计数会让本帧一项都推进不了。
    payloadScheduler.beginFrame();
    submitModelLeases();
  };

  /**
   * 合并准备与注册：Rust 派生兼容 signature/AABB/extent 并注册，只返回轻量 metadata
   * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 6.6）。
   * 缺新导出时返回 `null`；调用方保留最近合法资源并隔离诊断，不回落 TS 派生。
   */
  const prepareAndRegisterModelResource = registrar.prepareAndRegister;

  const queryBridge = createQueryBridge(() => interactionGeneration);
  const { runQuery, guardGeneration } = queryBridge;

  const now = () => target.performance?.now() ?? performance.now();

  const runtime: BevyRuntime = {
    ...(import.meta.env.DEV ? { getFrameCounters: () => {
      if (disposed || !module.runtime_health || (supervisor && supervisor.phase !== "running")) return undefined;
      try {
        const health = readRuntimeHealth(module.runtime_health());
        const drawCalls3d = health.drawCalls3d;
        return { generation, renders: health.renders, updates: health.updates,
          ...(typeof drawCalls3d === "number" && Number.isSafeInteger(drawCalls3d) && drawCalls3d >= 0 ? { drawCalls3d } : {}) };
      } catch { return undefined; }
    } } : {}),
    getRuntimeIssues: issues.getSnapshot,
    subscribeRuntimeIssues: issues.subscribe,
    reportRuntimeIssue: issues.report,
    clearRuntimeIssue: issues.clear,
    recoverRuntime: () => supervisor?.retry(),
    retryVersion: () => retryVersion,
    subscribeRuntimeRetry: listener => { retryListeners.add(listener); return () => { retryListeners.delete(listener); }; },
    retryRuntimeIssues: () => {
      textures.retry(); retryVersion += 1;
      for (const listener of retryListeners) { try { listener(); } catch { /* Retry observers cannot interrupt the runtime. */ } }
    },
    getRenderIssues: resourceFailures.getSnapshot,
    subscribeRenderIssues: resourceFailures.subscribe,
    retryFailedModels: resourceFailures.retry,
    acceptsPlayback: () => !disposed && (!supervisor || supervisor.phase === "running"),
    isReady: () => {
      try {
        return !disposed && (!supervisor || supervisor.phase === "running") && module.is_ready();
      } catch { return false; }
    },
    renderedRevision: () => module.rendered_revision(),
    generation: () => generation,
    interactionGeneration: () => interactionGeneration,
    baseSceneGeneration: () => baseSceneGeneration,
    getWorkDiagnostics: () => !disposed && module.canvas_work_diagnostics ? JSON.parse(module.canvas_work_diagnostics()) as Record<string, unknown> : {},
    setPositions: (input) => {
      if (disposed) throw new Error("Bevy runtime disposed");
      if (!module.set_positions) throw new Error("Bevy 运行时缺少 set_positions 边界");
      const json = measureSceneWork("stringifyMs", now, () => canvasPositionUpdateRequest(input));
      const accepted = measureSceneWork("wasmAcceptMs", now, () => module.set_positions!(json));
      sceneDiagnostics.positionSubmits += 1;
      sceneDiagnostics.boundaryBytes += new TextEncoder().encode(json).byteLength;
      interactionGeneration = accepted;
      if (lastScene) lastScene = positionMirror.apply(lastScene, input);
      return accepted;
    },
    ...createRuntimeViewport({ module: () => module, now, accepted: (input, accepted) => {
      if (disposed) return;
      interactionGeneration = accepted;
      if (lastScene) supervisor?.accepted(lastScene.revision, accepted);
      if (lastScene) lastScene = { ...lastScene, viewport: { ...input.viewport } };
    } }),
    ...createRuntimeObserver({ module: () => module, now, lastScene: () => lastScene, accepted: (scene, accepted) => {
      if (disposed) return;
      interactionGeneration = accepted;
      if (scene) { lastScene = scene; supervisor?.accepted(scene.revision, accepted); }
    } }),
    setTexture: (id, width, height, rgba, source) => textures.upload("node", id, width, height, rgba,
      // 稳定内容身份让 Rust 侧按内容+尺寸共享同一 GPU 纹理，nodeId 只是绑定实例
      // （change: 2026-10-23-scale-canvas-media-residency，design D4 / 任务 4.4）。
      () => module.set_texture(id, width, height, rgba, source?.sourceKey ?? ""), source),
    setImageFocusDetails:frame=>{
      if(!module.set_image_focus_details) {if(frame)throw new Error("画布内核缺少图片细节纹理接口");return;}
      focusDetails.upload(frame,(manifest,pixels)=>module.set_image_focus_details!(manifest,pixels));
    },
    setModelMediaTexture: (id, width, height, rgba, source) => textures.upload("plane", id, width, height, rgba,
      () => { if (!module.set_model_media_texture) throw new Error("缺少媒体平面纹理能力"); module.set_model_media_texture(id, width, height, rgba); }, source),
    registerModelResource,
    prepareAndRegisterModelResource,
    setModelPayloadLeases,
    /** 页面集中策略注入（design D3）：模型准备并发/片段预算只有一个来源。 */
    setModelPrepareBudget: (input) => {
      payloadScheduler.configure({
        ...(Number.isFinite(input.concurrency) ? { concurrency: input.concurrency } : {}),
        ...(Number.isFinite(input.budgetMs) ? { budgetMs: input.budgetMs } : {})
      });
    },
    /** 每帧推进有界数量的待准备模型 payload（静止帧也调用；无待办时零开销）。 */
    advanceModelPreparation: () => {
      if (disposed) return;
      payloadScheduler.beginFrame();
      payloadScheduler.drain();
    },
    setScene: (scene, resources) => {
      // 先声明本帧引用的 descriptor（payload 由 lease 决定是否驻留；design D5）。
      payloadScheduler.beginFrame();
      if (resources) lastModelResources = resources;
      const failureVersion = resourceFailures.version();
      let accepted = resources ? resourceFailures.project(scene, resources, lastScene, registerModelResource) : scene;
      // 本帧新声明的模型若属于当前需求，把需求 lease 与派生准备推进一次（幂等短路）。
      // 必须在提交场景之前：场景引用应当先看到 lease 已提交、payload 已就绪或明确 cold。
      submitModelLeases();
      // 尚未收到需求投影时 `submitModelLeases` 直接返回，这里按保守的「引用即准备」推进一次
      // 有界队列；已投影时上一行已排空，本行为空转。
      drainPendingPayloads();
      // payload 准备是有界的（可能延后到后续帧），但**本帧实际尝试**的失败必须立刻反映到
      // 场景：失败节点回退上一帧合法引用并提示，而不是先提交一个注定显示不出的引用。
      if (resources && resourceFailures.version() !== failureVersion) {
        accepted = resourceFailures.project(scene, resources, lastScene, registerModelResource);
      }
      sceneDiagnostics.sceneStringify += 1;
      const json = measureSceneWork("stringifyMs", now, () => JSON.stringify(accepted));
      sceneDiagnostics.sceneSubmits += 1;
      sceneDiagnostics.boundaryBytes += json.length;
      sceneDiagnostics.lastSceneJsonCodeUnits = json.length;
      // Rust 在接受点同步发布 interaction snapshot 并返回新的 generation。
      interactionGeneration = measureSceneWork("wasmAcceptMs", now, () => module.set_scene(json));
      // full 接受同时刷新 base 身份；纯视口增量沿用该身份直到下次 full。
      baseSceneGeneration = interactionGeneration;
      lastScene = positionMirror.reset(accepted);
      supervisor?.accepted(scene.revision, interactionGeneration);
      // 首个完整 scene 已提交：等 Bevy 的健康协议确认该 generation 已应用且完成 render
      // schedule（与恢复路径同一判据），再揭示 iframe。否则首帧 shader/管线准备期间仍可能
      // 露出默认浅色清屏，暗色画布切换就会白闪。只对浏览器 realm 生效（原生 reveal 是 no-op）。
      if (!revealScheduled && realm) {
        revealScheduled = true;
        const activeRealm = realm;
        const targetGeneration = interactionGeneration;
        let attempts = 0;
        const afterPaint = (callback: () => void) => {
          if (typeof target.requestAnimationFrame === "function") target.requestAnimationFrame(callback);
          else target.setTimeout(callback, 16);
        };
        const revealWhenRendered = () => {
          if (disposed) return;
          attempts += 1;
          let rendered = false;
          try {
            if (module.runtime_health) {
              const health = readRuntimeHealth(module.runtime_health());
              rendered =
                (health.appliedGeneration ?? 0) >= targetGeneration &&
                (health.renderedGeneration ?? 0) >= targetGeneration;
            }
          } catch {
            // 健康读取失败不应让画布永久隐藏；错误由 supervisor/告警面显示。
            rendered = true;
          }
          if (rendered || attempts > 240) {
            activeRealm.reveal();
            return;
          }
          afterPaint(revealWhenRendered);
        };
        afterPaint(revealWhenRendered);
      }
      textures.retain(new Set(scene.nodes.map(node => node.id)),
        new Set(scene.nodes.flatMap(node => node.compositeAsset?.media?.map(plane => plane.id) ?? [])));
    },
    queryPoint: (input) =>
      guardGeneration(input.generation, () =>
        runQuery(
          () => module.query_point_hit(encodePointRequest(input)),
          projectPoint
        )
      ),
    queryMarquee: (input) =>
      guardGeneration(input.generation, () =>
        runQuery(
          () => module.query_marquee(encodeMarqueeRequest(input)),
          projectMarquee
        )
      ),
    queryProbe: (input) =>
      guardGeneration(input.generation, () =>
        runQuery(
          () => module.query_probe(encodeProbeRequest(input)),
          projectProbe
        )
      ),
    queryDropTarget: (input) =>
      guardGeneration(input.generation, () =>
        runQuery(
          () => (module.query_drop_target ?? (() => ""))(encodeDropTargetRequest(input)),
          projectDropTarget
        )
      ),
    queryCompositeAssetScopes: (input) =>
      guardGeneration(input.generation, () =>
        runQuery(
          () => (module.query_composite_asset_scopes ?? (() => ""))(encodeCompositeAssetScopesRequest(input)),
          projectCompositeAssetScopes
        )
      ),
    queryModelPick: (input) =>
      guardGeneration(input.generation, () =>
        runQuery(
          () => (module.query_model_pick ?? (() => ""))(encodeModelPickRequest(input)),
          projectModelPick
        )
      ),
    queryCompositeAssetItemPick: (input) =>
      runQuery(
        () => queryCompositeAssetItemPickRaw(module, input),
        projectFilmSetItemPick
      ),
    queryCompositeAssetItemBounds: (nodeId) => queryCompositeAssetItemBoundsRaw(module, nodeId),
    queryGizmoHit: (input) => {
      if (!module.query_gizmo_hit) return null;
      try {
        const before = generation;
        let result = parseGizmoResult(module.query_gizmo_hit(encodeGizmoRequest(input, interactionGeneration)));
        if (result?.reason === "stale") result = parseGizmoResult(module.query_gizmo_hit(encodeGizmoRequest(input, interactionGeneration)));
        return before === generation && (!result?.available || result.generation === interactionGeneration) ? result : null;
      } catch {
        return null;
      }
    },
    requestCapture: async (input) => {
      const releaseOwner = hoverNodeStore.acquirePlaybackOwner();
      const captureGeneration = generation;
      try { return await pollShotCapture(module, {
        requestId: nextCaptureRequestId(),
        nodeId: input.nodeId,
        generation: input.generation,
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {})
      }, () => !disposed && captureGeneration === generation && (!supervisor || supervisor.phase === "running"));
      } finally { releaseOwner(); }
    },
    shotDiagnostics: () => {
      const empty = { rigs: 0, previewImages: 0, gizmoEntities: 0, capturesInFlight: 0, capturesQueued: 0 };
      if (!module.shot_diagnostics) return empty;
      try {
        const parsed = JSON.parse(module.shot_diagnostics()) as Partial<typeof empty>;
        return { ...empty, ...parsed };
      } catch {
        return empty;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      focusDetails.reset();
      retryListeners.clear();
      supervisor?.dispose();
      if (healthTimer !== null) target.clearInterval(healthTimer);
      target.document?.removeEventListener("visibilitychange", visibilityChanged);
      disposeRealm();
    }
  };
  const visibilityChanged = () => { if (supervisor?.phase === "running") supervisor.sample(supervisor.snapshot().health, false); };
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  if (!options.importModule) {
    supervisor = new RuntimeSupervisor({ issues, recover: async () => {
      const previousInteraction = interactionGeneration;
      generation = nextRuntimeGeneration();
      focusDetails.reset();
      const abandoned = realm; realm = null;
      module = new Proxy({} as BevyModule, { get: () => () => { throw new Error("渲染器正在重建"); } });
      abandoned?.dispose();
      try {
        const replacement = await loadModule(true);
        await replacement.default();
        if (disposed) { disposeRealm(); throw new Error("Runtime disposed"); }
        assertRequiredCapabilities(replacement);
        if (!replacement.runtime_health || !replacement.seed_runtime_generation) throw new Error("Bevy WASM 缺少恢复健康协议");
        replacement.seed_runtime_generation(previousInteraction);
        replacement.start();
        // 代际重建只恢复**当前需求**（design D5 / 任务 5.5）：先重放轻量 descriptor，再只为
        // 需求内的模型重准备重型 payload。不能重放整场 IR：1000 个离屏模型的准备成本与场景
        // 规模成正比，正是本 change 要消除的。
        declaredKeys.clear(); registeredKeys.clear(); submittedLeases = new Set(); leasesSubmitted = false;
        for (const key of knownModelKeys) {
          const resource = lastModelResources.get(key);
          if (!resource || !replacement.declare_model_resource) continue;
          replacement.declare_model_resource(modelDescriptorPayload(modelDescriptorOf(resource)));
          declaredKeys.add(key);
        }
        const restore = new Set<string>();
        for (const key of requestedLeases ?? lastModelResources.keys()) {
          if (lastModelResources.has(key)) restore.add(key);
        }
        if (replacement.set_model_payload_leases) {
          replacement.set_model_payload_leases(modelPayloadLeaseRequest(restore));
          submittedLeases = restore; leasesSubmitted = true;
        }
        for (const key of restore) {
          const resource = lastModelResources.get(key);
          if (!resource) continue;
          replacement.prepare_and_register_model_resource!(modelPrepareRequest({
            sceneVersion: resource.sceneVersion,
            ops: resource.ops as never,
            opsJson: JSON.stringify(resource.ops),
            expectedSignature: resource.signature
          }));
          registeredKeys.add(key);
        }
        const recoveredInteraction = lastScene ? replacement.set_scene(JSON.stringify(lastScene)) : 0;
        let remaining = 30000; let sampledAt = performance.now();
        while (!disposed && remaining > 0) {
          const now = performance.now();
          if (target.document.visibilityState === "visible") remaining -= now - sampledAt;
          sampledAt = now;
          if (realmFault) throw new Error(realmFault);
          const health = readRuntimeHealth(replacement.runtime_health());
          if (replacement.is_ready() && health.renders > 0 && (!lastScene || (health.appliedGeneration! >= recoveredInteraction && health.renderedGeneration! >= recoveredInteraction))) {
            module = protectWasmModule(replacement, issues, callsAllowed); interactionGeneration = recoveredInteraction; baseSceneGeneration = recoveredInteraction; textures.reset(); return;
          }
          await new Promise(resolve => target.setTimeout(resolve, 50));
        }
        throw new Error("渲染器重建未通过健康检查");
      } catch (error) { disposeRealm(); throw error; }
    }, invalidate: () => { try { resourceFailures.retry(); } finally { runtime.retryRuntimeIssues?.(); } } });
    if (realmFault) { supervisor.fail(realmFault); }
    target.document.addEventListener("visibilitychange", visibilityChanged);
    healthTimer = target.setInterval(() => {
      if (disposed || supervisor?.phase !== "running") return;
      if (!target.document.getElementById("bevy-canvas")) return;
      if (!realm?.connected()) { supervisor?.fail("surface-detached"); return; }
      try {
        supervisor?.sample(readRuntimeHealth(module.runtime_health!()), target.document.visibilityState === "visible");
      }
      catch (error) { supervisor?.fail(error instanceof Error ? error.message : "health"); }
    }, 1000);
  }

  // 页面级镜像：供 E2E / 排障观察运行时状态（生产无副作用）。
  (target as unknown as { __bevyRuntime?: unknown }).__bevyRuntime = {
    isReady: () => runtime.isReady(),
    renderedRevision: () => runtime.renderedRevision(),
    lastScene: () => lastScene,
    getWorkDiagnostics: runtime.getWorkDiagnostics,
    setViewport: runtime.setViewport,
    setObserver: runtime.setObserver,
    setPositions: runtime.setPositions,
    baseSceneGeneration: runtime.baseSceneGeneration,
    modelResourceErrors: resourceFailures.getSnapshot,
    runtimeIssues: issues.getSnapshot,
    runtimeHealth: () => supervisor?.snapshot(),
    generation: runtime.generation,
    recover: runtime.recoverRuntime,
    setTexture: runtime.setTexture,
    queryGizmoHit: runtime.queryGizmoHit,
    queryCompositeAssetItemBounds: runtime.queryCompositeAssetItemBounds,
    queryCompositeAssetItemPick: runtime.queryCompositeAssetItemPick,
    // 真实 WASM 命中查询：E2E 用它验证 Rust 侧 serde 确实读到 camelCase 键
    // （change: 2026-10-08-make-film-set-model-only）。
    queryPoint: (input: { x: number; y: number; zoom: number; hoveredEdgeId?: string | null }) =>
      runtime.queryPoint?.({
        generation: interactionGeneration,
        x: input.x,
        y: input.y,
        zoom: input.zoom,
        hoveredEdgeId: input.hoveredEdgeId ?? null
      }) ?? { ok: false, reason: "unsupported" },
    // accepted drop/scope 查询镜像：E2E 用它验证真实 WASM 的范围几何与目标固定
    // （change: 2026-10-12-align-film-set-scope-with-isometric-grid）。生产无副作用。
    queryCompositeAssetScopes: () =>
      runtime.queryCompositeAssetScopes?.({ generation: interactionGeneration }) ?? { ok: false, reason: "unsupported" },
    queryDropTarget: (point: { x: number; y: number }, excludedIds: readonly string[] = []) =>
      runtime.queryDropTarget?.({ generation: interactionGeneration, x: point.x, y: point.y, excludedIds }) ??
      { ok: false, reason: "unsupported" }
  };
  return runtime;
}
