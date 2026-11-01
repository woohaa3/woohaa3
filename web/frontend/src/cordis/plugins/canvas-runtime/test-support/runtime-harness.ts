/**
 * Bevy 运行时测试共享 harness
 * （change: 2026-10-23-scale-canvas-media-residency：`bevy-runtime.test.ts` 触发前端文件体积
 * 守卫，把 mock WASM 模块与场景构造拆到这里）。
 *
 * `mockModule` 模拟真实 Rust 侧的**关键语义**，而不是只记录调用：
 * - `set_scene` 返回递增的 interaction generation（接受点）；
 * - `declare_model_resource` 与 `set_model_payload_leases` 分离（design D5）；
 * - payload 表有条目上限，lease 之外的条目可被预算淘汰，因此「注册成功」不等于「仍驻留」。
 *
 * 只服务单元测试：不被生产源码导入。
 */
import { CANVAS_RENDER_SCENE_VERSION, CANVAS_VIEWPORT_UPDATE_VERSION, CANVAS_POSITION_UPDATE_VERSION, CANVAS_OBSERVER_UPDATE_VERSION, defaultAppTheme, type CanvasRenderScene, type SceneV2Op } from "@woohaa3/contracts";
import type { BevyModule } from "../bevy-runtime.js";

export function v2Ops(radius: number): SceneV2Op[] {
  return [
    {
      t: "sphere",
      id: "s",
      parent: null,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: null,
      color: "#ffffff",
      radius
    } as SceneV2Op
  ];
}

export function sceneWith(resourceKey: string, signature: string): CanvasRenderScene {
  return {
    version: CANVAS_RENDER_SCENE_VERSION,
    canvasId: "canvas-harness",
    revision: 1,
    nodes: [
      {
        id: "m1",
        type: "model",
        x: 0,
        y: 0,
        width: 196,
        height: 64,
        body: "",
        title: "模型",
        typeLabel: "3D 模型",
        progress: 0,
        busy: false,
        texture: false,
        resizable: false,
        model: { sceneVersion: "woohaa-model-scene-ir-v2", resourceKey, signature }
      }
    ],
    edges: [],
    selection: { nodes: [], edge: null },
    viewport: { x: 0, y: 0, zoom: 1 },
    draft: null,
    surface: null,
    theme: defaultAppTheme()
  };
}

export type Calls = Array<{ kind: string; value: string }>;

/** 模拟 Rust payload 条目上限（真实上限见 `bridge/assets.rs` 的 MODEL_ASSET_MAX_ENTRIES）。 */
export const MODEL_PAYLOAD_LIMIT = 4;

export function mockModule(calls: Calls, opts: { failRegister?: boolean; prepare?: boolean } = {}): BevyModule {
  // interaction generation 计数（set_scene 与 set_viewport 都推进，模拟 Rust 接受点）。
  let sceneGeneration = 0;
  let baseGeneration = 0;
  /** 模拟 Rust 侧 payload 驻留表（lease 之外可被预算淘汰）。 */
  const payloads = new Map<string, true>();
  /** 模拟 Rust 侧当前需求 lease。 */
  let leased = new Set<string>();
  const evictUnleased = (): string[] => {
    const evicted: string[] = [];
    for (const key of [...payloads.keys()]) {
      if (payloads.size <= MODEL_PAYLOAD_LIMIT) break;
      if (leased.has(key)) continue;
      payloads.delete(key);
      evicted.push(key);
    }
    return evicted;
  };
  const module: BevyModule = {
    default: async () => undefined,
    start: () => calls.push({ kind: "start", value: "" }),
    // 返回 interaction generation（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
    set_scene: (json: string) => {
      calls.push({ kind: "set_scene", value: json });
      sceneGeneration += 1;
      baseGeneration = sceneGeneration;
      return sceneGeneration;
    },    set_texture: () => undefined,
    rendered_revision: () => 1,
    is_ready: () => true,
    query_point_hit: () => JSON.stringify({ available: false, reason: "unavailable", generation: 0, hit: null }),
    query_marquee: () => JSON.stringify({ available: false, reason: "unavailable", generation: 0, nodeIds: [] }),
    query_probe: () => JSON.stringify({ available: false, reason: "unavailable", generation: 0, candidates: [] }),
    // 片场菱形范围的 drop/scope 查询（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
    query_drop_target: () => JSON.stringify({ available: false, reason: "unavailable", generation: 0, targetNodeId: null }),
  };
  if (opts.prepare !== false) {
    module.prepare_and_register_model_resource = (json: string) => {
      calls.push({ kind: "prepare", value: json });
      if (opts.failRegister) throw new Error("register failed");
      const parsed = JSON.parse(json) as { sceneVersion: string; ops: unknown[]; expectedSignature?: string };
      const signature = parsed.expectedSignature ?? "sig";
      const resourceKey = `${parsed.sceneVersion}:${signature}`;
      // 真实 Rust 会为新 payload 腾出未 lease 的旧条目。
      payloads.set(resourceKey, true);
      const evicted = evictUnleased();
      return JSON.stringify({
        resourceVersion: "woohaa-prepared-model-resource-v1",
        resourceKey,
        sceneVersion: parsed.sceneVersion,
        signature,
        extent: 2,
        aabb: { min: [-1, -1, -1], max: [1, 1, 1] },
        evictedKeys: evicted
      });
    };
    // descriptor 声明与 payload lease（change: 2026-10-23-scale-canvas-media-residency，design D5）。
    module.declare_model_resource = (json: string) => {
      calls.push({ kind: "declare", value: json });
      return json;
    };
    module.set_model_payload_leases = (json: string) => {
      calls.push({ kind: "leases", value: json });
      if (opts.failRegister) throw new Error("lease failed");
      const parsed = JSON.parse(json) as { keys?: unknown };
      const keys = Array.isArray(parsed.keys) ? parsed.keys.filter((k): k is string => typeof k === "string") : [];
      // 模拟真实 Rust：lease 是唯一驻留依据；需求内的条目不被淘汰。
      leased = new Set(keys);
      const evicted = evictUnleased();
      return JSON.stringify({
        retained: payloads.size,
        evicted: evicted.length,
        evictedKeys: evicted,
        residentKeys: [...payloads.keys()],
        descriptors: 1,
        cold: 0
      });
    };
  }
  // 直接 Shot Camera capture 边界（change: 2026-10-07-remove-residual-compatibility）。
  // 初始化能力校验要求存在；默认不产出帧（返回空数组）。
  module.request_shot_capture = (json: string) => {
    calls.push({ kind: "request_shot_capture", value: json });
  };
  module.poll_shot_capture = () => new Uint8Array();
  // 纯视口增量能力（change: 2026-10-10-optimize-canvas-interaction-hot-path）。
  // 默认能力版本正确；base 身份随 set_scene 更新、set_viewport 只推进 generation。
  module.viewport_capability = () => CANVAS_VIEWPORT_UPDATE_VERSION;
  module.position_capability = () => CANVAS_POSITION_UPDATE_VERSION;
  // 场景 wire 能力（change: 2026-10-15-add-film-set-overview-lod）。
  module.scene_capability = () => CANVAS_RENDER_SCENE_VERSION;
  module.base_scene_generation = () => baseGeneration;
  module.set_viewport = (json: string) => {
    const parsed = JSON.parse(json) as { baseSceneGeneration: number };
    if (baseGeneration === 0) throw new Error("unavailable");
    if (parsed.baseSceneGeneration !== baseGeneration) throw new Error("stale-base");
    calls.push({ kind: "set_viewport", value: json });
    return ++sceneGeneration;
  };
  module.set_positions = (json: string) => {
    const parsed = JSON.parse(json) as { baseSceneGeneration: number };
    if (!baseGeneration) throw new Error("unavailable");
    if (parsed.baseSceneGeneration !== baseGeneration) throw new Error("stale-base");
    calls.push({ kind: "set_positions", value: json });
    return ++sceneGeneration;
  };
  module.observer_capability = () => CANVAS_OBSERVER_UPDATE_VERSION;
  module.set_observer = (json: string) => {
    const parsed = JSON.parse(json) as { baseSceneGeneration: number };
    if (baseGeneration === 0) throw new Error("unavailable");
    if (parsed.baseSceneGeneration !== baseGeneration) throw new Error("stale-base");
    calls.push({ kind: "set_observer", value: json });
    return ++sceneGeneration;
  };
  (module as { __setBaseGeneration?: (value: number) => void }).__setBaseGeneration = (value: number) => { baseGeneration = value; };
  return module;
}
