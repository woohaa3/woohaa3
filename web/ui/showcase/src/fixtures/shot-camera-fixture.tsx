/**
 * Shot Camera Showcase fixture（真实 Bevy WASM）
 * （change: add-reusable-bevy-shot-camera，任务 6.1–6.3 / design D8）。
 *
 * 启动**真实** Bevy WASM 运行时（与生产同构的 `bevy-runtime` 与 `set_scene` 边界），注册确定性
 * 程序化模型 fixture，并通过生产 `modelEditor` 投影驱动可复用 shot camera rig。页面不复制生产
 * gizmo markup、不使用静态预览图、不引入第二套 renderer。
 *
 * 诊断镜像（`window.__shotCameraShowcase`）只暴露公开命令的结果，不提供隐藏 ECS 写入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MODEL_CAMERA_ASPECT,
  MODEL_EDITOR_VERSION,
  MODEL_FOCUS_FOV,
  MODEL_FOCUS_VERSION,
  MODEL_SCRIPT_SCENE_IR_V2_VERSION,
  SHOT_CAMERA_FIT_MAX_FACTOR,
  SHOT_CAMERA_FIT_MIN_FLOOR_FACTOR,
  aabbCenterRadius,
  autoFrameDistance,
  buildCanvasRenderScene,
  defaultAppTheme,
  modelAnchor,
  modelCameraAspectRatio,
  modelWorldAabbRelative,
  prepareModelResource,
  resolveShotCamera,
  shotFitDistance,
  type Aabb,
  type BevyModelEditor,
  type BevyModelPlacement,
  type BevyShotCamera,
  type ModelCameraAspect,
  type ModelCameraFocusOffset,
  type PreparedModelResource,
  type SceneV2Op,
  type ServerCanvas,
  type Vec3
} from "@woohaa3/contracts";
import {
  loadBevyRuntime,
  type BevyRuntime
} from "../../../../frontend/src/cordis/plugins/canvas-runtime/bevy-runtime.js";

/** 确定性程序化模型：base + tower box + orb sphere。 */
const SHOWCASE_MODEL_OPS = [
  { t: "box", id: "base", parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#5b8def", size: [2, 0.6, 2] },
  { t: "box", id: "tower", parent: null, position: [0, 1.1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#f2a154", size: [0.9, 1.6, 0.9] },
  { t: "sphere", id: "orb", parent: null, position: [0.9, 0.9, 0.7], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#3fbf9f", radius: 0.45 }
] as unknown as readonly SceneV2Op[];

const MODEL_NODE_ID = "shot-model";
/** 画布视口：固定为 0 平移、zoom=1，节点居中，与取景锚点公式一致。 */
const SHOWCASE_VIEWPORT = { x: 0, y: 0, zoom: 1 } as const;
const SHOWCASE_NODE = { id: MODEL_NODE_ID, x: 0, y: 0, width: 224, height: 116 } as const;
/** 舞台初始 CSS 尺寸（挂载后由 ResizeObserver 覆盖为容器实测值）。 */
const DEFAULT_SURFACE = { width: 960, height: 540 } as const;

export type ShowcaseCamera = {
  id: string;
  name: string;
  azimuth: number;
  distance: number;
  focusOffset: ModelCameraFocusOffset;
  aspect: ModelCameraAspect;
};

export type ShowcaseDiagnostics = {
  rigs: number;
  previewImages: number;
  gizmoEntities: number;
  capturesInFlight: number;
  capturesQueued: number;
};

export type ShotCameraShowcase = {
  status: "loading" | "ready" | "error";
  error: string | null;
  cameras: ShowcaseCamera[];
  selectedId: string | null;
  selected: ShowcaseCamera | null;
  shot: BevyShotCamera | null;
  diagnostics: ShowcaseDiagnostics;
  capturePhase: "idle" | "rendering" | "done" | "failed";
  captureResult: { width: number; height: number; bytes: number } | null;
  /** 主观察相机缩放倍率（>1 推近，<1 拉远）；用于“看全/看清”整个场景。 */
  viewZoom: number;
  setViewZoom: (zoom: number) => void;
  /** 当前镜头的合法 distance 范围（由 fit distance 派生，与 Godot clamp 一致）。 */
  distanceBounds: { min: number; max: number };
  select: (id: string) => void;
  addCamera: () => void;
  removeCamera: (id: string) => void;
  setAzimuth: (id: string, azimuth: number) => void;
  setDistance: (id: string, distance: number) => void;
  setFocusY: (id: string, y: number) => void;
  setAspect: (id: string, aspect: ModelCameraAspect) => void;
  reset: (id: string) => void;
  capture: () => Promise<void>;
};

let cameraSeq = 1;

/**
 * 页面级单例 canvas。
 *
 * Bevy App（winit 窗口）在 `start()` 时按 id 绑定 `#bevy-canvas` 且只绑定一次；切换 story 时
 * React 会卸载旧 story 的 DOM，如果每次都新建 canvas，窗口仍指向已脱离文档的旧元素，导致
 * “只有第一次渲染出内容”。这里维护一个单例 canvas：每帧把它重新挂进当前 story 的舞台容器，
 * 卸载时移入 body 下的停放节点，保证 winit 绑定始终有效。
 */
let persistentCanvas: HTMLCanvasElement | null = null;
let parkingHost: HTMLDivElement | null = null;

function takeCanvas(container: HTMLElement): HTMLCanvasElement {
  if (!persistentCanvas) {
    persistentCanvas = document.createElement("canvas");
    persistentCanvas.id = "bevy-canvas";
    persistentCanvas.className = "shot-camera__canvas";
  }
  if (persistentCanvas.parentElement !== container) {
    container.appendChild(persistentCanvas);
  }
  return persistentCanvas;
}

function parkCanvas(): void {
  if (!persistentCanvas) return;
  if (!parkingHost) {
    parkingHost = document.createElement("div");
    parkingHost.style.position = "absolute";
    parkingHost.style.width = "0";
    parkingHost.style.height = "0";
    parkingHost.style.overflow = "hidden";
    parkingHost.style.pointerEvents = "none";
    parkingHost.setAttribute("aria-hidden", "true");
    document.body.appendChild(parkingHost);
  }
  if (persistentCanvas.parentElement !== parkingHost) {
    parkingHost.appendChild(persistentCanvas);
  }
}

/** 把单例 canvas 挂进给定舞台容器；返回卸载函数（移入停放节点，不销毁 winit 绑定）。 */
export function attachShotCanvas(container: HTMLElement): () => void {
  takeCanvas(container);
  return () => parkCanvas();
}

/**
 * 模型在世界空间的包围球（与生产 `shotModelForNode` 同源；固定世界，不读取 viewport/surface
 * ——change: make-shot-framing-zoom-invariant，design D1/D2）。
 */
function worldBounds(resource: PreparedModelResource): WorldBounds {
  const placement: BevyModelPlacement = { scale: 1, yaw: 0, offset: { x: 0, y: 0, z: 0 } };
  const relative = modelWorldAabbRelative({
    sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION,
    ops: SHOWCASE_MODEL_OPS,
    extent: resource.extent,
    aabb: resource.aabb
  });
  if (!relative) {
    return { aabb: { min: [0, 0, 0], max: [0, 0, 0] }, center: [0, 0, 0], radius: 1 };
  }
  const anchor = modelAnchor({
    nodeX: SHOWCASE_NODE.x,
    nodeY: SHOWCASE_NODE.y,
    nodeWidth: SHOWCASE_NODE.width,
    nodeHeight: SHOWCASE_NODE.height,
    relativeAabb: relative,
    offset: placement.offset
  });
  const aabb: Aabb = {
    min: [relative.min[0] + anchor[0], relative.min[1] + anchor[1], relative.min[2] + anchor[2]],
    max: [relative.max[0] + anchor[0], relative.max[1] + anchor[1], relative.max[2] + anchor[2]]
  };
  const { center, radius } = aabbCenterRadius(aabb);
  return { aabb, center, radius };
}

/** 装载真实 Bevy WASM 并维护 showcase 镜头列表（只经生产 `set_scene` 边界驱动 rig）。 */
export function useShotCameraShowcase(containerRef: { current: HTMLElement | null }): ShotCameraShowcase {
  const runtimeRef = useRef<BevyRuntime | null>(null);
  const resource = useMemo<PreparedModelResource>(
    () => prepareModelResource({ sceneVersion: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops: SHOWCASE_MODEL_OPS }),
    []
  );
  const [surface, setSurface] = useState<{ width: number; height: number }>({ ...DEFAULT_SURFACE });
  const bounds = useMemo(() => worldBounds(resource), [resource]);
  const radius = bounds.radius;
  const defaultDistance = useMemo(
    () => shotFitDistance(radius, modelCameraAspectRatio(DEFAULT_MODEL_CAMERA_ASPECT)),
    [radius]
  );
  const distanceBounds = useMemo(() => {
    const fit = defaultDistance;
    return {
      min: Math.max(fit * SHOT_CAMERA_FIT_MIN_FLOOR_FACTOR, 0.01),
      max: Math.max(fit * SHOT_CAMERA_FIT_MAX_FACTOR, 2.4)
    };
  }, [defaultDistance]);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<ShowcaseCamera[]>([
    { id: "cam-1", name: "镜头 1", azimuth: 0, distance: defaultDistance, focusOffset: { x: 0, y: 0, z: 0 }, aspect: DEFAULT_MODEL_CAMERA_ASPECT }
  ]);
  const [selectedId, setSelectedId] = useState<string | null>("cam-1");
  const [diagnostics, setDiagnostics] = useState<ShowcaseDiagnostics>({
    rigs: 0,
    previewImages: 0,
    gizmoEntities: 0,
    capturesInFlight: 0,
    capturesQueued: 0
  });
  const [capturePhase, setCapturePhase] = useState<"idle" | "rendering" | "done" | "failed">("idle");
  const [captureResult, setCaptureResult] = useState<{ width: number; height: number; bytes: number } | null>(null);
  const [viewZoom, setViewZoom] = useState(1);

  const selected = cameras.find((camera) => camera.id === selectedId) ?? cameras[0] ?? null;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const viewZoomRef = useRef(viewZoom);
  viewZoomRef.current = viewZoom;

  // 挂载单例 canvas 到舞台，并按容器实测尺寸驱动 surface（含 DPR）。
  // Bevy 的 winit 会给 canvas 打固定内联宽高，因此必须在容器尺寸变化时同步舞台尺寸，
  // 否则渲染分辨率与容器不一致会裁切/看不全。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const detach = attachShotCanvas(container);
    const measure = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      setSurface((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => {
      observer.disconnect();
      detach();
    };
  }, [containerRef]);

  // 装载运行时（页面级单例）。Bevy App 本身是单例：切换 story 只重建 DOM，不重启 WASM。
  // `loadBevyRuntime` 复用同一 Promise，因此 bind 到 `#bevy-canvas` 的窗口在 story 间保持有效。
  useEffect(() => {
    let disposed = false;
    loadBevyRuntime()
      .then((runtime) => {
        if (disposed) return;
        runtimeRef.current = runtime;
        submit(runtime, resource, selectedRef.current, bounds, radius, surface, viewZoomRef.current);
        setStatus("ready");
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
    };
  }, [resource, bounds, radius, surface]);

  // 镜头、选择或舞台尺寸变化：重新提交场景（modelEditor.shot 变化即驱动 rig）。
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !selected) return;
    submit(runtime, resource, selected, bounds, radius, surface, viewZoom);
  }, [cameras, selected, resource, bounds, radius, surface]);

  // 轮询公开诊断。
  useEffect(() => {
    if (status !== "ready") return;
    const handle = window.setInterval(() => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      const next = runtime.shotDiagnostics();
      setDiagnostics((previous) =>
        previous.rigs === next.rigs &&
        previous.previewImages === next.previewImages &&
        previous.gizmoEntities === next.gizmoEntities &&
        previous.capturesInFlight === next.capturesInFlight &&
        previous.capturesQueued === next.capturesQueued
          ? previous
          : next
      );
    }, 200);
    return () => window.clearInterval(handle);
  }, [status]);

  const shot = useMemo<BevyShotCamera | null>(
    () => (selected ? resolveShotBevy(bounds, selected) : null),
    [bounds, selected]
  );

  const patch = useCallback((id: string, changes: Partial<ShowcaseCamera>) => {
    setCameras((previous) => previous.map((camera) => (camera.id === id ? { ...camera, ...changes } : camera)));
  }, []);

  const addCamera = useCallback(() => {
    cameraSeq += 1;
    const camera: ShowcaseCamera = {
      id: `cam-${cameraSeq}`,
      name: `镜头 ${cameraSeq}`,
      azimuth: cameraSeq % 2 === 0 ? 0 : Math.PI / 2,
      distance: defaultDistance,
      focusOffset: { x: 0, y: 0, z: 0 },
      aspect: DEFAULT_MODEL_CAMERA_ASPECT
    };
    setCameras((previous) => [...previous, camera]);
    setSelectedId(camera.id);
  }, [defaultDistance]);

  const removeCamera = useCallback((id: string) => {
    setCameras((previous) => {
      const next = previous.filter((camera) => camera.id !== id);
      setSelectedId((current) => (current === id ? next[0]?.id ?? null : current));
      return next;
    });
  }, []);

  const capture = useCallback(async () => {
    const runtime = runtimeRef.current;
    const camera = selectedRef.current;
    if (!runtime || !camera) return;
    // 相机 pose 由当前 rig 提供；这里只做可解析性前置检查。
    if (!resolveShotBevy(bounds, camera)) {
      setCapturePhase("failed");
      return;
    }
    setCapturePhase("rendering");
    setCaptureResult(null);
    const size = aspectSize(camera.aspect);
    // 直接 Shot Camera 边界：相机 pose 由当前 rig 提供（场景已按 modelEditor.shot 提交）。
    const result = await runtime.requestCapture({
      generation: runtime.generation() + 1,
      nodeId: MODEL_NODE_ID,
      width: size.width,
      height: size.height
    });
    if (!result) {
      setCapturePhase("failed");
      return;
    }
    setCaptureResult({ width: result.width, height: result.height, bytes: result.rgba.length });
    setCapturePhase("done");
  }, [bounds]);

  return {
    status,
    error,
    cameras,
    selectedId,
    selected,
    shot,
    diagnostics,
    capturePhase,
    captureResult,
    viewZoom,
    setViewZoom,
    distanceBounds,
    select: setSelectedId,
    addCamera,
    removeCamera,
    setAzimuth: (id, azimuth) => patch(id, { azimuth }),
    setDistance: (id, distance) => patch(id, { distance }),
    setFocusY: (id, y) => {
      const camera = cameras.find((entry) => entry.id === id);
      patch(id, { focusOffset: { x: camera?.focusOffset.x ?? 0, y, z: camera?.focusOffset.z ?? 0 } });
    },
    setAspect: (id, aspect) => patch(id, { aspect }),
    reset: (id) => patch(id, { azimuth: 0, distance: defaultDistance, focusOffset: { x: 0, y: 0, z: 0 } }),
    capture
  };
}

function aspectSize(aspect: ModelCameraAspect) {
  const width = 1280;
  return { width, height: Math.max(1, Math.round(width / modelCameraAspectRatio(aspect))) };
}

type WorldBounds = { aabb: Aabb; center: Vec3; radius: number };

/**
 * 协议 `modelFocus.distance` 的合法区间（与 Rust `ModelFocus::validate` 的 `0.4..=400` 一致）。
 *
 * 视图缩放（`viewZoom`）会把自动取景距离按倍率缩放，往远拉时可能超出上限；越界会让
 * `set_scene` 校验拒绝并抛错。这里统一钳制，保证任何 viewZoom 都产生合法快照。
 */
const FOCUS_MIN_DISTANCE = 0.4;
const FOCUS_MAX_DISTANCE = 400;

function clampFocusDistance(distance: number): number {
  if (!Number.isFinite(distance)) return FOCUS_MAX_DISTANCE;
  return Math.min(FOCUS_MAX_DISTANCE, Math.max(FOCUS_MIN_DISTANCE, distance));
}

function resolveShotBevy(bounds: WorldBounds, camera: ShowcaseCamera): BevyShotCamera | null {
  const shot = resolveShotCamera(bounds.aabb, {
    azimuth: camera.azimuth,
    distance: camera.distance,
    aspect: camera.aspect,
    focusOffset: camera.focusOffset
  });
  if (!shot) return null;
  return {
    position: shot.position,
    focus: shot.focus,
    fov: shot.fov,
    azimuth: shot.azimuth,
    elevation: shot.elevation,
    distance: shot.distance,
    aspect: camera.aspect
  };
}

function showcaseCanvas(): ServerCanvas {
  return {
    version: "woohaa-server-canvas-v1",
    document: {
      version: "woohaa-canvas-document-v1",
      nodes: [
        {
          id: MODEL_NODE_ID,
          type: "model3d",
          position: { x: SHOWCASE_NODE.x, y: SHOWCASE_NODE.y },
          width: SHOWCASE_NODE.width,
          height: SHOWCASE_NODE.height,
          data: {}
        }
      ],
      edges: []
    },
    revision: 1,
    assets: [],
    nodeData: {}
  } as unknown as ServerCanvas;
}

/** 提交一帧真实场景：`modelEditor.shot` 驱动可复用 rig；诊断镜像公开命令结果。 */
function submit(
  runtime: BevyRuntime,
  resource: PreparedModelResource,
  camera: ShowcaseCamera | null,
  bounds: WorldBounds,
  radius: number,
  surface: { width: number; height: number },
  viewZoom: number
) {
  // `buildCanvasRenderScene` 的 `modelResources` 按 **nodeId** 取用；
  // `BevyRuntime.setScene` 的第二个参数按 **resourceKey** 校验/注册。两者语义不同，分别构造。
  const byNode = new Map<string, PreparedModelResource>([[MODEL_NODE_ID, resource]]);
  const byKey = new Map<string, PreparedModelResource>([[resource.resourceKey, resource]]);
  runtime.registerModelResource(resource);
  const shot = camera ? resolveShotBevy(bounds, camera) : null;
  const editor: BevyModelEditor | null = shot
    ? {
        version: MODEL_EDITOR_VERSION,
        nodeId: MODEL_NODE_ID,
        toolMode: "camera",
        cameraTool: "orbit",
        cameraId: camera!.id,
        focus: bounds.center,
        radius,
        shot
      }
    : null;
  const scene = buildCanvasRenderScene({
    canvas: showcaseCanvas(),
    modelResources: byNode,
    viewportOverride: SHOWCASE_VIEWPORT,
    surface: { width: surface.width, height: surface.height, pixelRatio: 1 },
    theme: defaultAppTheme(),
    modelFocus: {
      version: MODEL_FOCUS_VERSION,
      nodeId: MODEL_NODE_ID,
      target: bounds.center,
      yaw: 0,
      pitch: -0.35,
      distance: clampFocusDistance(
        autoFrameDistance(radius, MODEL_FOCUS_FOV, surface.width / surface.height) / Math.max(viewZoom, 0.05)
      ),
      fov: MODEL_FOCUS_FOV,
      radius
    },
    modelEditor: editor
  });
  // 单帧被拒（例如边界校验失败）不得让整个 story 崩溃：捕获后记录到诊断镜像，下一帧重试。
  try {
    runtime.setScene(scene, byKey);
    lastSubmitError = null;
  } catch (error) {
    lastSubmitError = error instanceof Error ? error.message : String(error);
  }
  const target = globalThis as unknown as { __shotCameraShowcase?: unknown };
  target.__shotCameraShowcase = {
    cameraId: camera?.id ?? null,
    shot: shot ?? null,
    editor,
    lastSubmitError
  };
}

/** 最近一次 `set_scene` 被拒的原因（诊断；成功时为 null）。 */
let lastSubmitError: string | null = null;
