/**
 * 镜头镜头类型派生（change: 2026-11-05-camera-shot-as-video）。
 *
 * 镜头卡片代表的内容由**动画上下文**决定，而不是手动开关：锚点位于带
 * `animationScript` 的导演区内、或被任一导演区脚本的 camera/instance 轨道驱动时，
 * 该镜头代表一段随时间变化的取景（`dynamic`）；否则代表静态图片（`static`）。
 *
 * 这里只做纯派生：
 * - 不写规范文档、不新增持久字段；`captureMode` 仍被读取方兼容使用但不参与判定。
 * - 首版接受「动画区内即动态」的过度分类（design D2）；不做视锥可见性。
 * - 动画脚本以 `revision` + `sourceHash` 标识版本，供动态取景冻结与失效判断。
 */
import type { GroundPoint, WorldCameraData, WorldId } from "./shared-world.js";
import type { ServerCanvas } from "./domain/types.js";
import { decodeWorldCamera } from "./world-camera-codec.js";
import { decodeSceneAreaData } from "./creation-scope-codec.js";
import {
  executeWorldAnimationScript,
  type WorldAnimationIr,
  type WorldAnimationScript
} from "./world-animation-script.js";
import { sceneAreaAnimationOrigin } from "./shared-world.js";

export type WorldCameraShotKind = "static" | "dynamic";

/** 为什么这个镜头被派生成当前类型；用于诊断与测试，不进入规范文档。 */
export type WorldCameraShotReason =
  | "anchor-in-animated-area"
  | "camera-track"
  | "bound-instance-track"
  | "no-animation";

export type WorldCameraShotAnimation = {
  readonly areaId: WorldId;
  readonly areaNodeId: WorldId;
  readonly scriptRevision: number;
  readonly sourceHash: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly origin: GroundPoint;
};

export type WorldCameraShotContext = {
  readonly kind: WorldCameraShotKind;
  readonly cameraId: WorldId;
  readonly cameraNodeId: WorldId;
  readonly reason: WorldCameraShotReason;
  /** 动态镜头关联的动画；静态镜头为 null。 */
  readonly animation: WorldCameraShotAnimation | null;
};

/** 卡片呈现状态；`preview` 永不可下载或提交。 */
export type WorldCameraShotPhase = "preview" | "ready" | "stale" | "failed";

export type WorldCameraShotState = {
  readonly kind: WorldCameraShotKind;
  readonly phase: WorldCameraShotPhase;
  readonly durationSeconds: number | null;
  /** 实时取景画面只是预览；只有 ready 的冻结视频可以作为媒体下载/提交。 */
  readonly downloadable: boolean;
  readonly playable: boolean;
  readonly label: string;
};

const compiledScripts = new Map<string, WorldAnimationIr | null>();

/** 编译缓存：同一脚本（源码/时长/循环）只执行一次。失败返回 null。 */
export function compiledShotAnimation(script: WorldAnimationScript): WorldAnimationIr | null {
  const key = `${script.sourceHash}:${script.scriptVersion}:${script.duration}:${script.loop ? 1 : 0}`;
  if (compiledScripts.has(key)) return compiledScripts.get(key)!;
  const result = executeWorldAnimationScript(script.script, {
    duration: script.duration,
    loop: script.loop
  });
  const ir = result.ok ? result.ir : null;
  if (compiledScripts.size >= 64) {
    const first = compiledScripts.keys().next().value;
    if (first !== undefined) compiledScripts.delete(first);
  }
  compiledScripts.set(key, ir);
  return ir;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 镜头锚点是否落在导演区地面范围内（含边界）。 */
export function cameraAnchorInArea(camera: WorldCameraData, bounds: {
  min: GroundPoint;
  max: GroundPoint;
}): boolean {
  const { u, v } = camera.position;
  return (
    Number.isFinite(u) &&
    Number.isFinite(v) &&
    u >= bounds.min.u &&
    u <= bounds.max.u &&
    v >= bounds.min.v &&
    v <= bounds.max.v
  );
}

type CameraEntry = { nodeId: WorldId; camera: WorldCameraData };

function resolveCamera(
  canvas: ServerCanvas,
  cameraOrId: WorldCameraData | string
): CameraEntry | null {
  const nodeData = canvas.nodeData as Record<string, Record<string, unknown> | undefined>;
  if (typeof cameraOrId !== "string") {
    for (const node of canvas.document.nodes) {
      const decoded = decodeWorldCamera(nodeData[node.id]?.worldCamera);
      if (decoded.ok && decoded.value.cameraId === cameraOrId.cameraId) {
        return { nodeId: node.id, camera: decoded.value };
      }
    }
    // 调用方给了镜头数据但画布中没有对应节点：仍可按自身数据派生（锚点/绑定）。
    return { nodeId: "", camera: cameraOrId };
  }
  for (const node of canvas.document.nodes) {
    const decoded = decodeWorldCamera(nodeData[node.id]?.worldCamera);
    if (decoded.ok && decoded.value.cameraId === cameraOrId) {
      return { nodeId: node.id, camera: decoded.value };
    }
  }
  return null;
}

type AreaEntry = {
  nodeId: WorldId;
  areaId: WorldId;
  bounds: { min: GroundPoint; max: GroundPoint };
  origin: GroundPoint;
  script: WorldAnimationScript;
  ir: WorldAnimationIr;
};

function animatedAreas(canvas: ServerCanvas): AreaEntry[] {
  const nodeData = canvas.nodeData as Record<string, Record<string, unknown> | undefined>;
  const areas: AreaEntry[] = [];
  for (const node of canvas.document.nodes) {
    const decoded = decodeSceneAreaData(nodeData[node.id]?.sceneArea);
    if (!decoded.ok || !decoded.value.animationScript) continue;
    const ir = compiledShotAnimation(decoded.value.animationScript);
    if (!ir) continue;
    areas.push({
      nodeId: node.id,
      areaId: decoded.value.areaId,
      bounds: decoded.value.bounds,
      origin: sceneAreaAnimationOrigin(decoded.value),
      script: decoded.value.animationScript,
      ir
    });
  }
  return areas;
}

function animationOf(area: AreaEntry): WorldCameraShotAnimation {
  return {
    areaId: area.areaId,
    areaNodeId: area.nodeId,
    scriptRevision: area.script.revision,
    sourceHash: area.script.sourceHash,
    duration: area.script.duration,
    loop: area.script.loop,
    origin: { ...area.origin }
  };
}

/**
 * 派生镜头类型。判定顺序固定，保证同一画布在任意读取路径得到同一结果：
 * 1. 锚点位于动画导演区内（该区脚本不需要含镜头轨道）；
 * 2. 任一导演区脚本含该镜头的 camera 轨道；
 * 3. 该镜头绑定的实例被任一导演区脚本的 instance 轨道驱动。
 */
export function worldCameraShotContext(
  canvas: ServerCanvas,
  cameraOrId: WorldCameraData | string
): WorldCameraShotContext | null {
  const entry = resolveCamera(canvas, cameraOrId);
  if (!entry) return null;
  const camera = entry.camera;
  const areas = animatedAreas(canvas);

  const anchorArea = areas.find((area) => cameraAnchorInArea(camera, area.bounds));
  if (anchorArea) {
    return {
      kind: "dynamic",
      cameraId: camera.cameraId,
      cameraNodeId: entry.nodeId,
      reason: "anchor-in-animated-area",
      animation: animationOf(anchorArea)
    };
  }

  const cameraTrackArea = areas.find((area) =>
    area.ir.cameraTracks.some((track) => track.targetId === camera.cameraId)
  );
  if (cameraTrackArea) {
    return {
      kind: "dynamic",
      cameraId: camera.cameraId,
      cameraNodeId: entry.nodeId,
      reason: "camera-track",
      animation: animationOf(cameraTrackArea)
    };
  }

  const boundInstanceId = camera.boundInstanceId;
  if (boundInstanceId !== null) {
    const instanceTrackArea = areas.find((area) =>
      area.ir.instanceTracks.some((track) => track.targetId === boundInstanceId)
    );
    if (instanceTrackArea) {
      return {
        kind: "dynamic",
        cameraId: camera.cameraId,
        cameraNodeId: entry.nodeId,
        reason: "bound-instance-track",
        animation: animationOf(instanceTrackArea)
      };
    }
  }

  return {
    kind: "static",
    cameraId: camera.cameraId,
    cameraNodeId: entry.nodeId,
    reason: "no-animation",
    animation: null
  };
}

/** 纯派生入口：`dynamic` / `static`；镜头不存在时返回 null。 */
export function effectiveShotKind(
  canvas: ServerCanvas,
  camera: WorldCameraData | string
): WorldCameraShotKind | null {
  return worldCameraShotContext(canvas, camera)?.kind ?? null;
}

/** 镜头候选是否应当按视频处理；同一规则供面板候选与提交路径复用。 */
export function isDynamicCameraShot(canvas: ServerCanvas, camera: WorldCameraData | string): boolean {
  return effectiveShotKind(canvas, camera) === "dynamic";
}

/**
 * 卡片状态派生。调用方传入当前冻结版本是否与当前派生版本一致：
 * - `static`：普通图片卡片；
 * - `preview`：动态镜头但还没有任何冻结结果，实时画面只是预览；
 * - `ready`：冻结视频属于当前版本；
 * - `stale`：冻结视频属于旧版本，仍可查看但不能冒充当前；
 * - `failed`：准备失败。
 */
export function worldCameraShotState(input: {
  kind: WorldCameraShotKind;
  durationSeconds: number | null;
  capturedKeyMatchesCurrent: boolean | null;
  failed: boolean;
}): WorldCameraShotState {
  const { kind, durationSeconds } = input;
  if (kind === "static") {
    return {
      kind,
      phase: "ready",
      durationSeconds: null,
      downloadable: false,
      playable: false,
      label: ""
    };
  }
  const phase: WorldCameraShotPhase = input.failed
    ? "failed"
    : input.capturedKeyMatchesCurrent === null
      ? "preview"
      : input.capturedKeyMatchesCurrent
        ? "ready"
        : "stale";
  const duration = durationSeconds !== null && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : null;
  return {
    kind,
    phase,
    durationSeconds: duration,
    downloadable: phase === "ready",
    playable: phase === "ready",
    label: shotStateLabel(phase, duration)
  };
}

/**
 * 由派生上下文与当前取景阶段生成卡片呈现。静态镜头不显示视频标识；
 * 动态镜头在没有任何冻结结果时是 `preview`，绝不可下载。
 */
export function cameraShotPresentation(
  context: WorldCameraShotContext | null,
  phase: WorldCameraShotPhase | undefined
): WorldCameraShotState | null {
  if (!context) return null;
  const kind = context.kind;
  if (kind === "static") {
    return worldCameraShotState({ kind, durationSeconds: null, capturedKeyMatchesCurrent: null, failed: false });
  }
  return worldCameraShotState({
    kind,
    durationSeconds: context.animation?.duration ?? null,
    capturedKeyMatchesCurrent: phase === "ready" ? true : phase === "stale" ? false : null,
    failed: phase === "failed"
  });
}

function shotStateLabel(phase: WorldCameraShotPhase, durationSeconds: number | null): string {
  const duration = durationSeconds === null ? "" : `${formatSeconds(durationSeconds)}s`;
  switch (phase) {
    case "ready":
      return duration === "" ? "视频" : `视频 · ${duration}`;
    case "preview":
      return duration === "" ? "预览" : `预览 · ${duration}`;
    case "stale":
      return duration === "" ? "已过期" : `已过期 · ${duration}`;
    case "failed":
      return "准备失败";
  }
}

function formatSeconds(seconds: number): string {
  return (Math.round(seconds * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

/** 静态镜头也能查到动画时长（用于「导出当前帧」时间点与卡片提示）；无动画返回 null。 */
export function worldCameraAnimationDuration(
  canvas: ServerCanvas,
  camera: WorldCameraData | string
): number | null {
  const context = worldCameraShotContext(canvas, camera);
  return context?.animation ? context.animation.duration : null;
}

/** 测试与调用方避免直接依赖内部缓存。 */
export function clearShotAnimationCache(): void {
  compiledScripts.clear();
}

/** 诊断用：只返回可 JSON 化的关键字段。 */
export function describeCameraShot(context: WorldCameraShotContext | null): Record<string, unknown> | null {
  if (!context) return null;
  const payload = record(context);
  return payload ? { ...payload } : null;
}

/**
 * 「导出当前帧」计划：动态镜头中的独立静态图片动作。
 *
 * 只产出该时间点的静帧身份；不改变卡片主类型、动画区间或下游默认参考类型。
 * 身份包含镜头配置、世界内容、动画版本与时间点——时间点变化必然产生新身份，
 * 不能复用上一帧冒充当前时间。
 */
export type WorldCameraStillFramePlan = {
  readonly kind: WorldCameraShotKind;
  readonly cameraId: WorldId;
  readonly timeSeconds: number;
  readonly durationSeconds: number | null;
  /** 同一时间点重试可复用；不同时间点/动画版本必然不同。 */
  readonly identity: string;
  readonly animation: WorldCameraShotAnimation | null;
};

export function planWorldCameraStillFrame(input: {
  canvas: ServerCanvas;
  camera: WorldCameraData | string;
  timeSeconds: number;
  /** 世界内容版本（由调用方从权威快照读取）；缺省时只按镜头/动画/时间派生。 */
  worldContentVersion?: string;
}): WorldCameraStillFramePlan | null {
  const context = worldCameraShotContext(input.canvas, input.camera);
  if (!context) return null;
  const duration = context.animation?.duration ?? 0;
  const time = Number.isFinite(input.timeSeconds)
    ? Math.max(0, Math.min(input.timeSeconds, Math.max(0, duration)))
    : 0;
  const camera = resolveCamera(input.canvas, input.camera)?.camera;
  if (!camera) return null;
  const identity = [
    "world-camera-still-frame-v1",
    context.cameraId,
    camera.settingsVersion,
    input.worldContentVersion ?? "",
    context.animation?.areaId ?? "",
    context.animation?.scriptRevision ?? 0,
    context.animation?.sourceHash ?? "",
    time.toFixed(3)
  ].join("|");
  return {
    kind: context.kind,
    cameraId: context.cameraId,
    timeSeconds: time,
    durationSeconds: context.animation?.duration ?? null,
    identity,
    animation: context.animation
  };
}
