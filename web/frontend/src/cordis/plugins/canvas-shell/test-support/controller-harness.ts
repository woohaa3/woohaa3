/**
 * 交互控制器测试共享 harness
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 interaction-controller.test.ts 拆出）。
 *
 * 提供 DOM/事件 fake、会话 fake 工厂、画布 fixture 与运行时 capture；各 `interaction-*`
 * 测试文件共用。断言与原文件一致，仅拆出可复用设施。
 */
import { beforeEach } from "vitest";
import {
  applyCanvasCommands,
  createEmptyWoohaa3ServerCanvas,
  applyObserverToScene,
  type CanvasCommand,
  type CanvasRenderScene,
  type CanvasPositionUpdate,
  type CanvasObserverUpdate,
  type ServerCanvas
} from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../../services/canvas-state/index.js";
import { parameterPreviewStore } from "../../../services/parameter-preview.js";
import type { BevyRuntime } from "../../canvas-runtime/bevy-runtime.js";
import { sceneDiagnostics } from "../../canvas-runtime/scene-diagnostics.js";
import { PositionSceneMirror } from "../../canvas-runtime/position-scene-mirror.js";
import { hitTestOracle, selectInRectOracle } from "./interaction-oracle.js";

type Listener = (event: unknown) => void;

export function harness() {
  const listeners = new Map<string, Set<Listener>>();
  const add = (type: string, handler: Listener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(handler);
  };
  const remove = (type: string, handler: Listener) => listeners.get(type)?.delete(handler);
  const target: Record<string, unknown> = {
    navigator: { platform: "Linux" },
    addEventListener: add,
    removeEventListener: remove,
    requestAnimationFrame: undefined,
    performance: { now: () => Date.now() }
  };
  // 聚焦缩放监听的 document 目标（capture 阶段的 wheel / Safari GestureEvent）。
  const document: Record<string, unknown> = { addEventListener: add, removeEventListener: remove };
  target.document = document;
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }),
    addEventListener: add,
    removeEventListener: remove,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined
  } as unknown as HTMLCanvasElement;
  const fire = (type: string, event: Record<string, unknown>) => {
    const payload = { preventDefault: () => undefined, pointerId: 1, button: 0, clientX: 0, clientY: 0, ...event };
    for (const handler of listeners.get(type) ?? []) handler(payload);
  };
  const fireKey = (type: "keydown" | "keyup", event: Record<string, unknown>) => {
    const payload = {
      preventDefault: () => undefined,
      key: "",
      code: "",
      target: null,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...event
    };
    for (const handler of listeners.get(type) ?? []) handler(payload);
  };
  return { target, canvas, fire, fireKey };
}

export function canvasWith(nodes: Array<{ id: string; x: number; y: number }>): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: nodes.map((node) => ({ id: node.id, type: "image", position: { x: node.x, y: node.y } }))
    }
  };
}

export function runtimeCapturing(options: {
  /** 测试用模型 picking oracle：由 targets 派生（生产由 Rust 计算）。 */
  modelPick?: (input: { x: number; y: number; width: number; height: number }) => {
    nodeId: string;
    target: [number, number, number];
    radius: number;
  } | null;
  /** 测试用 gizmo 命中 oracle（生产由 Rust 计算）。 */
  gizmoHit?: (input: import("../model-gizmo-hit.js").GizmoQueryInput) => import("../../canvas-runtime/bevy-runtime.js").GizmoHitResult | null;
  /**
   * 测试用 queryPoint 命中 oracle 覆盖（生产由 Rust interaction snapshot 计算）。
   *
   * 用于驱动特定命中类别（如片场 `film-scope` 地面范围命中或选中 `resize` 抓手），
   * 覆盖默认 `hitTestOracle` 基线。
   */
  pointHit?: (input: { x: number; y: number; zoom: number; scene: CanvasRenderScene }) => import("../../canvas-runtime/bevy-runtime.js").PointHit | null;
} = {}): {
  runtime: BevyRuntime;
  scenes: Array<Record<string, unknown>>;
  viewports: Array<{ base: number; viewport: { x: number; y: number; zoom: number } }>;
  observers: Array<Omit<CanvasObserverUpdate, "version">>;
  failNextSetScene: (message?: string) => void;
  failNextSetViewport: (message?: string) => void;
  positions: Array<Omit<CanvasPositionUpdate, "version">>;
  failNextSetPositions: (message?: string) => void;
} {
  const scenes: Array<Record<string, unknown>> = [];
  const viewports: Array<{ base: number; viewport: { x: number; y: number; zoom: number } }> = [];
  const observers: Array<Omit<CanvasObserverUpdate, "version">> = [];
  const positions: Array<Omit<CanvasPositionUpdate,"version">> = [];
  const mirror = new PositionSceneMirror();
  let currentScene: CanvasRenderScene | null = null;
  let positionFailure: string | null = null;
  // 测试用 interaction generation：每次 setScene/setViewport 递增（模拟 Rust 接受点）。
  let generation = 0;
  // 最近一次完整场景接受的 base 身份（纯视口增量不会改动）。
  let baseGeneration = 0;
  // 可控注入的视口增量失败（模拟 Rust 原子拒绝：旧 base / 版本 / 非 overview）。
  let viewportFails = false;
  let viewportFailMessage = "stale-base";
  // 可控注入的提交失败（模拟生产 `module.set_scene` 抛错）。
  let setSceneFails = false;
  let setSceneFailMessage = "setScene failed";
  // 默认 model-pick：从最近提交 scene 的模型节点 AABB 正前方命中（无候选则 unavailable）。
  const defaultModelPick = (input: { x: number; y: number; width: number; height: number }) => {
    const scene = scenes.at(-1) as { nodes?: Array<{ id: string; type: string; x: number; y: number; width: number; height: number }> } | undefined;
    const node = scene?.nodes?.find((entry) => entry.type === "model" || entry.type === "model3d");
    if (!node) return null;
    const inside = input.x >= node.x && input.x <= node.x + node.width && input.y >= node.y && input.y <= node.y + node.height;
    if (!inside) return null;
    return { nodeId: node.id, target: [input.width / 2, input.height / 2, 0] as [number, number, number], radius: 2 };
  };
  const runtime = {
    isReady: () => true,
    renderedRevision: () => 1,
    setTexture: () => undefined,
    setScene: (scene: unknown) => {
      // 与生产 `bevy-runtime.setScene` 一致：先计提交尝试，再（可能抛错地）接受。
      // 抛错时（模拟 WASM 拒绝）不推送 scene，也不递增 generation；一次性失败后可重试。
      sceneDiagnostics.sceneSubmits += 1;
      if (setSceneFails) { setSceneFails = false; throw new Error(setSceneFailMessage); }
      scenes.push(scene as Record<string, unknown>);
      currentScene = mirror.reset(scene as CanvasRenderScene);
      generation += 1;
      baseGeneration = generation;
    },
    interactionGeneration: () => generation,
    baseSceneGeneration: () => baseGeneration,
    generation: () => 1,
    setPositions: (input: Omit<CanvasPositionUpdate,"version">) => {
      if (positionFailure) {
        const error=positionFailure; positionFailure=null; throw new Error(error);
      }
      if (!currentScene || input.baseSceneGeneration!==baseGeneration) throw new Error("stale-base");
      positions.push(input);
      currentScene=mirror.apply(currentScene,input);
      sceneDiagnostics.positionSubmits+=1;
      return ++generation;
    },
    // 纯视口增量（模拟 Rust：合法 base 时只推进 query generation，不改 base/scene）。
    setViewport: (input: { baseSceneGeneration: number; viewport: { x: number; y: number; zoom: number } }) => {
      sceneDiagnostics.viewportSubmits += 1;
      if (viewportFails) { viewportFails = false; throw new Error(viewportFailMessage); }
      if (input.baseSceneGeneration === 0 || input.baseSceneGeneration !== baseGeneration) {
        throw new Error("stale-base");
      }
      viewports.push({ base: input.baseSceneGeneration, viewport: { ...input.viewport } });
      if (currentScene) currentScene={...currentScene,viewport:{...input.viewport}};
      generation += 1;
      return generation;
    },
    setObserver: (input: Omit<CanvasObserverUpdate, "version">) => {
      if (!currentScene || input.baseSceneGeneration !== baseGeneration) throw new Error("stale-base");
      if (!currentScene.modelFocus || currentScene.modelFocus.nodeId !== input.nodeId) throw new Error("not-focused");
      observers.push(input);
      currentScene = applyObserverToScene(currentScene, input);
      sceneDiagnostics.observerSubmits += 1;
      return ++generation;
    },
    // 用测试基线 oracle 驱动命中分支；生产命中由 Rust interaction snapshot 计算。
    queryPoint: (input: { generation: number; x: number; y: number; zoom: number; hoveredEdgeId?: string | null }) => {
      if (input.generation !== generation) return { ok: false, reason: "stale" };
      const scene = currentScene;
      if (!scene) return { ok: false, reason: "unavailable" };
      const value = options.pointHit
        ? options.pointHit({ x: input.x, y: input.y, zoom: input.zoom, scene })
        : hitTestOracle(scene, { x: input.x, y: input.y }, input.zoom, input.hoveredEdgeId ?? null);
      return { ok: true, generation, value };
    },
    queryMarquee: (input: { generation: number; x: number; y: number; width: number; height: number }) => {
      if (input.generation !== generation) return { ok: false, reason: "stale" };
      const scene = currentScene;
      if (!scene) return { ok: false, reason: "unavailable" };
      return { ok: true, generation, value: selectInRectOracle(scene, { x: input.x, y: input.y, width: input.width, height: input.height }) };
    },
    queryProbe: () => ({ ok: false, reason: "unavailable" }),
    queryModelPick: (input: { generation: number; x: number; y: number; width: number; height: number }) => {
      if (input.generation !== generation) return { ok: false, reason: "stale" };
      const pick = options.modelPick ? options.modelPick(input) : defaultModelPick(input);
      return { ok: true, generation, value: pick };
    },
    // gizmo 命中 oracle 由 harness 注入（生产由 Rust query_gizmo_hit 计算）。
    queryGizmoHit: (input: import("../model-gizmo-hit.js").GizmoQueryInput) =>
      options.gizmoHit ? options.gizmoHit(input) : null
  } as unknown as BevyRuntime;
  return {
    runtime,
    scenes,
    viewports,
    observers,
    positions,
    failNextSetPositions: (message="stale-base") => { positionFailure=message; },
    failNextSetScene: (message = "setScene failed") => { setSceneFails = true; setSceneFailMessage = message; },
    failNextSetViewport: (message = "stale-base") => { viewportFails = true; viewportFailMessage = message; }
  };
}

export type TestSession = {
  isWritable: () => boolean;
  submitCommands: (commands: CanvasCommand[], id: string) => { ok: boolean };
};
export const submitted: CanvasCommand[] = [];

/**
 * 构造默认可写会话 fake：把命令应用到 workingCanvas，验证「提交后不闪回」由 pending
 * working effect 保持（而不是控制器内的专用超时 Map）。
 */
export function makeTestSession(): TestSession {
  return {
    isWritable: () => true,
    submitCommands: (commands) => {
      submitted.push(...commands);
      const state = woohaa3CanvasStore.getState();
      const base = state.working ?? state.canvas;
      if (base) {
        const applied = applyCanvasCommands(base, commands, { now: "2026-09-26T00:00:00.000Z" });
        if (applied.ok) woohaa3CanvasStore.getState().applyWorkingCanvas(applied.canvas);
      }
      return { ok: true, handle: { settled: Promise.resolve({ state: "committed" }) } } as never;
    }
  };
}

let currentSession: TestSession = makeTestSession();

/** 当前会话 fake（默认 makeTestSession；可用 `setSession` 替换，例如只读会话）。 */
export function getSession(): TestSession {
  return currentSession;
}

export function setSession(next: TestSession): void {
  currentSession = next;
}

/** 在测试文件顶部调用一次：清空 shared submitted / parameter preview 并重置会话。 */
export function installSharedSession(): void {
  beforeEach(() => {
    submitted.length = 0;
    parameterPreviewStore.clearAll();
    currentSession = makeTestSession();
  });
}

/** 触发 DOM 事件（事件对象带默认字段）。 */
export function domFire(dom: ReturnType<typeof harness>, type: string, event: Record<string, unknown>) {
  dom.fire(type, event);
}
