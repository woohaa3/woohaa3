/**
 * Canonical snapshot projection for T10 world capture.
 *
 * Everything here derives immutable capture input from a committed `ServerCanvas`:
 * camera settings, binding, static output pixels and exact pinned model content. No
 * browser-reported key, current-scene fallback or second world model is read.
 */
import {
  createWorldCaptureInstanceContents,
  createWorldCaptureModelContent,
  createWorldCaptureRequest,
  createWorldCaptureDynamicRequest,
  decodeWorldCamera,
  decodeWorldInstanceData,
  isGlbModelNodeData,
  worldCaptureContentFingerprint,
  worldCaptureModelContentHash,
  worldCameraShotContext,
  WORLD_CAPTURE_DYNAMIC_CONTAINER,
  WORLD_CAPTURE_DYNAMIC_DEFAULT_FPS,
  WORLD_CAPTURE_DYNAMIC_MAX_DURATION_SECONDS,
  WORLD_CAPTURE_DYNAMIC_OUTPUT_LONG_EDGE,
  WORLD_CAPTURE_DYNAMIC_REQUEST_VERSION,
  type ServerCanvas,
  type WorldCameraData,
  type WorldCameraShotContext,
  type WorldCaptureDynamicOutput,
  type WorldCaptureDynamicRequest,
  type WorldCaptureDynamicVersionKey,
  type WorldCaptureInstanceContent,
  type WorldCaptureModelContent,
  type WorldCaptureRequest,
  type WorldCaptureSubject,
  type WorldCaptureTimeRange,
  type WorldCaptureVersionKey,
  type WorldInstanceData,
  type WorldId
} from "@woohaa3/contracts";
import { decodeModelDefinition, decodeGlbModelReference } from "@woohaa3/contracts";
import { stableAuthorityVersion } from "./authority.js";

export const DEFAULT_OUTPUT_LONG_EDGE = 2048;

export type Observation = {
  canvasId: string;
  cameraId: string;
  camera: WorldCameraData;
  key: WorldCaptureVersionKey;
  request: WorldCaptureRequest;
};

export type SnapshotResult =
  | { ok: true; observation: Observation }
  | {
      ok: false;
      code: "camera-not-found" | "unsupported-capture-mode" | "invalid-data";
      message: string;
      key?: WorldCaptureVersionKey;
    };

type PinnedInstance = {
  instanceId: WorldId;
  instance: WorldInstanceData;
  content: WorldCaptureModelContent;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nodeFields(canvas: ServerCanvas, nodeId: string): Record<string, unknown> | null {
  return record(canvas.nodeData[nodeId]);
}

export function findCamera(
  canvas: ServerCanvas,
  cameraId: string
): { nodeId: string; camera: WorldCameraData } | null {
  for (const node of canvas.document.nodes) {
    const fields = nodeFields(canvas, node.id);
    if (!fields) continue;
    const decoded = decodeWorldCamera(fields.worldCamera);
    if (decoded.ok && decoded.value.cameraId === cameraId) {
      return { nodeId: node.id, camera: decoded.value };
    }
  }
  return null;
}

/** Camera ids in document order; used to observe committed canonical changes. */
export function listCameraIds(canvas: ServerCanvas): string[] {
  const ids: string[] = [];
  for (const node of canvas.document.nodes) {
    const fields = nodeFields(canvas, node.id);
    if (!fields) continue;
    const decoded = decodeWorldCamera(fields.worldCamera);
    if (decoded.ok) ids.push(decoded.value.cameraId);
  }
  return ids;
}

function readPinnedInstance(canvas: ServerCanvas, nodeId: string): PinnedInstance | null {
  const fields = nodeFields(canvas, nodeId);
  if (!fields) return null;
  const instance = decodeWorldInstanceData(fields.sharedWorldInstance);
  if (!instance.ok) return null;
  if (isGlbModelNodeData(fields)) {
    const reference = decodeGlbModelReference(fields);
    if (!reference.ok) return null;
    const content = createWorldCaptureModelContent({
      version: "world-capture-model-content-v1",
      kind: "glb",
      reference: reference.value
    });
    if (!content.ok) return null;
    return { instanceId: instance.value.instanceId, instance: instance.value, content: content.value };
  }
  const definition = decodeModelDefinition({
    modelScript: fields.modelScript,
    modelScriptLanguage: fields.modelScriptLanguage,
    modelScriptVersion: fields.modelScriptVersion,
    modelContentVersion: fields.modelContentVersion,
    modelPlacement: fields.modelPlacement
  });
  if (!definition.ok) return null;
  const content = createWorldCaptureModelContent({
    version: "world-capture-model-content-v1",
    kind: "script",
    definition: definition.value
  });
  if (!content.ok) return null;
  return { instanceId: instance.value.instanceId, instance: instance.value, content: content.value };
}

function collectInstances(canvas: ServerCanvas): PinnedInstance[] | null {
  const instances: PinnedInstance[] = [];
  const seen = new Set<string>();
  for (const node of canvas.document.nodes) {
    const fields = nodeFields(canvas, node.id);
    if (!fields || fields.sharedWorldInstance === undefined) continue;
    const instance = readPinnedInstance(canvas, node.id);
    if (!instance || seen.has(instance.instanceId)) return null;
    seen.add(instance.instanceId);
    instances.push(instance);
  }
  return instances;
}

function outputFor(camera: WorldCameraData, longEdge: number): {
  width: number;
  height: number;
  contentType: "image/png";
  outputVersion: string;
} | null {
  // `captureMode` 只保留给旧读取方；镜头类型由动画上下文派生（design D1）。
  const ratio = camera.aspect.width / camera.aspect.height;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const width = ratio >= 1 ? longEdge : Math.max(1, Math.round(longEdge * ratio));
  const height = ratio >= 1 ? Math.max(1, Math.round(longEdge / ratio)) : longEdge;
  return {
    width,
    height,
    contentType: "image/png",
    outputVersion: stableAuthorityVersion("world-capture-output", { width, height, contentType: "image/png" })
  };
}

function worldContentVersionFor(camera: WorldCameraData, instances: readonly PinnedInstance[]): string {
  const selected = camera.boundInstanceId === null
    ? instances
    : instances.filter(instance => instance.instanceId === camera.boundInstanceId);
  return stableAuthorityVersion("world-capture-world-content", {
    instances: selected.map(instance => ({
      instanceId: instance.instanceId,
      transform: instance.instance.transform,
      contentHash: worldCaptureModelContentHash(instance.content)
    })).sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  });
}

function bindingVersionFor(camera: WorldCameraData): string {
  return stableAuthorityVersion("world-capture-binding", {
    cameraId: camera.cameraId,
    boundInstanceId: camera.boundInstanceId
  });
}

function subjectContents(subject: WorldCaptureSubject): readonly WorldCaptureInstanceContent[] {
  switch (subject.kind) {
    case "world":
      return subject.contents;
    case "instance":
      return [{ instanceId: subject.instanceId, content: subject.content }];
    case "bound-missing":
      return [];
  }
}

type SubjectBuild =
  | {
      ok: true;
      subject: WorldCaptureSubject;
      contentFingerprint: string;
      worldContentVersion: string;
      bindingVersion: string;
    }
  | { ok: false; code: "invalid-data"; message: string };

/** 冻结镜头取景涉及的世界内容（未绑定=全部实例，绑定=恰好一个或缺失）。 */
function buildCaptureSubject(canvas: ServerCanvas, camera: WorldCameraData): SubjectBuild {
  const instances = collectInstances(canvas);
  if (!instances) {
    return { ok: false, code: "invalid-data", message: "共享世界模型内容不完整，无法固定取景输入" };
  }

  let subject: WorldCaptureSubject;
  if (camera.boundInstanceId === null) {
    const contents = createWorldCaptureInstanceContents(
      instances.map(instance => ({ instanceId: instance.instanceId, content: instance.content }))
    );
    if (!contents.ok) {
      return { ok: false, code: "invalid-data", message: "共享世界模型内容不完整，无法固定取景输入" };
    }
    subject = {
      kind: "world",
      instances: instances.map(instance => instance.instance),
      contents: contents.value
    };
  } else {
    const target = instances.find(instance => instance.instanceId === camera.boundInstanceId);
    subject = target
      ? {
          kind: "instance",
          instanceId: target.instanceId,
          instance: target.instance,
          content: target.content
        }
      : { kind: "bound-missing", instanceId: camera.boundInstanceId };
  }

  return {
    ok: true,
    subject,
    contentFingerprint: worldCaptureContentFingerprint(subjectContents(subject)),
    worldContentVersion: worldContentVersionFor(camera, instances),
    bindingVersion: bindingVersionFor(camera)
  };
}

export function buildWorldCaptureObservation(input: {
  canvasId: string;
  canvas: ServerCanvas;
  cameraId: string;
  outputLongEdge: number;
  attemptCounter: number;
}): SnapshotResult {
  const found = findCamera(input.canvas, input.cameraId);
  if (!found) return { ok: false, code: "camera-not-found", message: "世界镜头不存在" };
  const camera = found.camera;
  const output = outputFor(camera, input.outputLongEdge);
  if (!output) {
    return {
      ok: false,
      code: "unsupported-capture-mode",
      message: "镜头画幅无效，无法固定静态取景输出"
    };
  }

  const built = buildCaptureSubject(input.canvas, camera);
  if (!built.ok) return { ok: false, code: built.code, message: built.message };
  const { subject, contentFingerprint, worldContentVersion, bindingVersion } = built;
  const key: WorldCaptureVersionKey = {
    canvasId: input.canvasId,
    cameraId: camera.cameraId,
    worldContentVersion,
    cameraSettingsVersion: camera.settingsVersion,
    bindingVersion,
    outputVersion: output.outputVersion
  };
  const requestId = stableAuthorityVersion("world-capture-request", {
    key,
    attempt: input.attemptCounter
  });
  const requestBuilt = createWorldCaptureRequest({
    requestId,
    key,
    worldContentVersion,
    bindingVersion,
    camera,
    subject,
    output,
    contentFingerprint
  });
  if (!requestBuilt.ok) {
    return { ok: false, code: "invalid-data", message: "无法构建不可变取景请求" };
  }
  return {
    ok: true,
    observation: {
      canvasId: input.canvasId,
      cameraId: camera.cameraId,
      camera,
      key,
      request: requestBuilt.value
    }
  };
}

/* ------------------------------------------------------------------------- */
/* 动态（视频）取景：镜头类型由动画上下文派生，静态路径保持完全不变。       */
/* ------------------------------------------------------------------------- */

export type StaticCameraObservation = Observation & {
  readonly kind: "static";
  readonly shot: WorldCameraShotContext;
};

export type DynamicCameraObservation = {
  readonly kind: "dynamic";
  readonly canvasId: string;
  readonly cameraId: string;
  readonly camera: WorldCameraData;
  readonly shot: WorldCameraShotContext;
  readonly key: WorldCaptureDynamicVersionKey;
  readonly request: WorldCaptureDynamicRequest;
  readonly durationSeconds: number;
};

export type CameraObservation = StaticCameraObservation | DynamicCameraObservation;

export type CameraObservationResult =
  | { ok: true; observation: CameraObservation }
  | {
      ok: false;
      code: "camera-not-found" | "unsupported-capture-mode" | "invalid-data" | "duration-exceeded" | "fps-out-of-range";
      message: string;
      key?: WorldCaptureVersionKey | WorldCaptureDynamicVersionKey;
    };

export type WorldCameraObservationOptions = {
  canvasId: string;
  canvas: ServerCanvas;
  cameraId: string;
  /** 静态输出长边（像素）。 */
  outputLongEdge: number;
  attemptCounter: number;
  /** 动态输出长边；默认 1024。 */
  dynamicOutputLongEdge?: number;
  /** 显式时间区间；缺省为 [0, 动画时长]。 */
  timeRange?: WorldCaptureTimeRange;
  /** 动态帧率；默认 24。 */
  fps?: number;
};

function dynamicOutputFor(
  camera: WorldCameraData,
  longEdge: number,
  fps: number,
  timeRange: WorldCaptureTimeRange,
  animation: NonNullable<WorldCameraShotContext["animation"]>
): WorldCaptureDynamicOutput | null {
  const ratio = camera.aspect.width / camera.aspect.height;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  // 视频编码按 4:2:0 宏块处理，输出尺寸保持偶数，避免编码器取整后与请求/媒体元数据不一致。
  const even = (value: number) => Math.max(2, value % 2 === 0 ? value : value - 1);
  const width = even(ratio >= 1 ? longEdge : Math.round(longEdge * ratio));
  const height = even(ratio >= 1 ? Math.round(longEdge / ratio) : longEdge);
  const outputVersion = stableAuthorityVersion("world-capture-dynamic-output", {
    width,
    height,
    container: WORLD_CAPTURE_DYNAMIC_CONTAINER,
    fps,
    startSeconds: timeRange.startSeconds,
    endSeconds: timeRange.endSeconds,
    areaId: animation.areaId,
    scriptRevision: animation.scriptRevision,
    sourceHash: animation.sourceHash,
    durationSeconds: animation.duration
  });
  return { outputVersion, width, height, container: WORLD_CAPTURE_DYNAMIC_CONTAINER };
}

/**
 * 观察一个镜头并给出静态或动态取景计划。
 *
 * 动态镜头缺省区间是整段动画；超过单次上限必须由调用方显式缩短，绝不静默截断。
 */
export function buildWorldCameraObservation(
  input: WorldCameraObservationOptions
): CameraObservationResult {
  const found = findCamera(input.canvas, input.cameraId);
  if (!found) return { ok: false, code: "camera-not-found", message: "世界镜头不存在" };
  const camera = found.camera;
  const shot = worldCameraShotContext(input.canvas, camera);
  if (!shot) return { ok: false, code: "camera-not-found", message: "世界镜头不存在" };

  if (shot.kind === "static" || !shot.animation) {
    const staticResult = buildWorldCaptureObservation({
      canvasId: input.canvasId,
      canvas: input.canvas,
      cameraId: input.cameraId,
      outputLongEdge: input.outputLongEdge,
      attemptCounter: input.attemptCounter
    });
    if (!staticResult.ok) return staticResult;
    return { ok: true, observation: { ...staticResult.observation, kind: "static", shot } };
  }

  const animation = shot.animation;
  const timeRange: WorldCaptureTimeRange = input.timeRange ?? {
    startSeconds: 0,
    endSeconds: animation.duration
  };
  if (timeRange.startSeconds < 0 || timeRange.endSeconds <= timeRange.startSeconds) {
    return { ok: false, code: "invalid-data", message: "动态取景时间区间无效" };
  }
  if (timeRange.endSeconds > animation.duration + 1e-9) {
    return { ok: false, code: "invalid-data", message: "动态取景时间区间超出动画时长" };
  }
  if (timeRange.endSeconds - timeRange.startSeconds > WORLD_CAPTURE_DYNAMIC_MAX_DURATION_SECONDS) {
    return {
      ok: false,
      code: "duration-exceeded",
      message: `单次动态取景最多 ${WORLD_CAPTURE_DYNAMIC_MAX_DURATION_SECONDS} 秒，请显式缩短时间区间`
    };
  }
  const fps = input.fps ?? WORLD_CAPTURE_DYNAMIC_DEFAULT_FPS;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    return { ok: false, code: "fps-out-of-range", message: "动态取景帧率必须在 1–60 fps" };
  }
  const output = dynamicOutputFor(
    camera,
    input.dynamicOutputLongEdge ?? WORLD_CAPTURE_DYNAMIC_OUTPUT_LONG_EDGE,
    fps,
    timeRange,
    animation
  );
  if (!output) return { ok: false, code: "unsupported-capture-mode", message: "镜头画幅无效，无法固定动态取景输出" };

  const built = buildCaptureSubject(input.canvas, camera);
  if (!built.ok) return { ok: false, code: built.code, message: built.message };

  const key: WorldCaptureDynamicVersionKey = {
    canvasId: input.canvasId,
    cameraId: camera.cameraId,
    worldContentVersion: built.worldContentVersion,
    cameraSettingsVersion: camera.settingsVersion,
    bindingVersion: built.bindingVersion,
    outputVersion: output.outputVersion,
    animation: {
      areaId: animation.areaId,
      scriptRevision: animation.scriptRevision,
      sourceHash: animation.sourceHash,
      durationSeconds: animation.duration
    },
    timeRange,
    fps
  };
  const requestId = stableAuthorityVersion("world-capture-dynamic-request", { key });
  const requestBuilt = createWorldCaptureDynamicRequest({
    version: WORLD_CAPTURE_DYNAMIC_REQUEST_VERSION,
    requestId,
    key,
    camera,
    subject: built.subject,
    output,
    contentFingerprint: built.contentFingerprint
  });
  if (!requestBuilt.ok) {
    return { ok: false, code: "invalid-data", message: "无法构建不可变动态取景请求" };
  }
  return {
    ok: true,
    observation: {
      kind: "dynamic",
      canvasId: input.canvasId,
      cameraId: camera.cameraId,
      camera,
      shot,
      key,
      request: requestBuilt.value,
      durationSeconds: animation.duration
    }
  };
}

/** 动态取景单次上限（测试与 UI 共用同一常量）。 */
export { WORLD_CAPTURE_DYNAMIC_MAX_DURATION_SECONDS } from "@woohaa3/contracts";
