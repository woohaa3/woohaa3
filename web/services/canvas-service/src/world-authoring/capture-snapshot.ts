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
  decodeWorldCamera,
  decodeWorldInstanceData,
  isGlbModelNodeData,
  worldCaptureContentFingerprint,
  worldCaptureModelContentHash,
  type ServerCanvas,
  type WorldCameraData,
  type WorldCaptureInstanceContent,
  type WorldCaptureModelContent,
  type WorldCaptureRequest,
  type WorldCaptureSubject,
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
  if (camera.captureMode.kind !== "static") return null;
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
      message: "动态取景属于后续契约，当前只支持静态取景"
    };
  }

  const instances = collectInstances(input.canvas);
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

  const contentFingerprint = worldCaptureContentFingerprint(subjectContents(subject));
  const worldContentVersion = worldContentVersionFor(camera, instances);
  const bindingVersion = bindingVersionFor(camera);
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
  const built = createWorldCaptureRequest({
    requestId,
    key,
    worldContentVersion,
    bindingVersion,
    camera,
    subject,
    output,
    contentFingerprint
  });
  if (!built.ok) {
    return { ok: false, code: "invalid-data", message: "无法构建不可变取景请求" };
  }
  return {
    ok: true,
    observation: {
      canvasId: input.canvasId,
      cameraId: camera.cameraId,
      camera,
      key,
      request: built.value
    }
  };
}
