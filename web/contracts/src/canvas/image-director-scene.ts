import { modelApiGuide } from "./model-api-descriptor.js";
import { decodeWorldTransform, hasOnlyKeys, isJsonRecord, isNonEmptyWorldId } from "./shared-world-codec.js";
import { SHARED_WORLD_VERSION, type WorldCameraData, type WorldTransform } from "./shared-world.js";
import { decodeWorldCamera } from "./world-camera-codec.js";
import { isAgentReasoningEffort } from "../extension/assistant/conversation.js";
import { decodeEditApplyCommand } from "./edit-command.js";

export const IMAGE_DIRECTOR_SCENE_VERSION = "image-director-scene-v1" as const;
export const IMAGE_DIRECTOR_SCENE_DEFAULT_PROMPT = "根据图片创建可编辑的 3D 场景，尽量还原主体、比例、空间布局和构图，将主要对象分别建模，并创建与原图画幅一致的默认镜头。";

const pointSchema = { type: "object", additionalProperties: false, required: ["u", "v", "h"], properties: { u: { type: "number" }, v: { type: "number" }, h: { type: "number" } } } as const;
const rotationSchema = { type: "array", items: { type: "number" } } as const;
export const imageDirectorSceneCandidateSchema = {
  type: "object", additionalProperties: false, required: ["version", "models", "camera", "qualityNotes"], properties: {
    version: { type: "string", enum: [IMAGE_DIRECTOR_SCENE_VERSION] },
    models: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "name", "script", "transform"], properties: {
      key: { type: "string" }, name: { type: "string" }, script: { type: "string" }, transform: { type: "object", additionalProperties: false, required: ["version", "position", "rotation", "scale"], properties: { version: { type: "string", enum: [SHARED_WORLD_VERSION] }, position: pointSchema, rotation: rotationSchema, scale: { type: "number" } } }
    } } },
    camera: { type: "object", additionalProperties: false, required: ["position", "rotation", "projection"], properties: { position: pointSchema, rotation: rotationSchema, projection: { anyOf: [
      { type: "object", additionalProperties: false, required: ["kind", "verticalSizeMeters", "nearMeters", "farMeters"], properties: { kind: { type: "string", enum: ["isometric"] }, verticalSizeMeters: { type: "number" }, nearMeters: { type: "number" }, farMeters: { type: "number" } } },
      { type: "object", additionalProperties: false, required: ["kind", "verticalFovRadians", "nearMeters", "farMeters"], properties: { kind: { type: "string", enum: ["perspective"] }, verticalFovRadians: { type: "number" }, nearMeters: { type: "number" }, farMeters: { type: "number" } } }
    ] } } },
    qualityNotes: { type: ["string", "null"] }
  }
} as const;

export interface ImageDirectorSceneRequest {
  requestId: string;
  sourceNodeId: string;
  connectionId: string;
  model: string;
  variant: string | null;
  instructions: string;
}

export interface FrozenImageDirectorSource {
  sourceNodeId: string;
  assetId: string;
  contentVersion: string;
  checksum: string;
  mimeType: string;
  width: number;
  height: number;
}

export type ImageDirectorSceneFailureCode = "invalid-request" | "source-unavailable" | "connection-unavailable" | "candidate-invalid" | "placement-conflict" | "save-unconfirmed" | "cancelled";
export type ImageDirectorSceneFailure = { code: ImageDirectorSceneFailureCode; message: string };
export function decodeImageDirectorSceneFailure(input: unknown): ImageDirectorSceneFailure | null {
  const codes: readonly string[] = ["invalid-request", "source-unavailable", "connection-unavailable", "candidate-invalid", "placement-conflict", "save-unconfirmed", "cancelled"];
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ["code", "message"]) || typeof input.code !== "string" || !codes.includes(input.code) || !isNonEmptyWorldId(input.message)) return null;
  return { code: input.code as ImageDirectorSceneFailureCode, message: input.message };
}
export function decodeImageDirectorSceneRequest(input: unknown): { ok: true; value: ImageDirectorSceneRequest } | { ok: false; failure: ImageDirectorSceneFailure } {
  const failure = { code: "invalid-request" as const, message: "图片场景请求无效" };
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ["requestId", "sourceNodeId", "connectionId", "model", "variant", "instructions"]) || !isNonEmptyWorldId(input.requestId) || !isNonEmptyWorldId(input.sourceNodeId) || !isNonEmptyWorldId(input.connectionId) || !isNonEmptyWorldId(input.model) || !(input.variant === null || isAgentReasoningEffort(input.variant)) || typeof input.instructions !== "string" || !input.instructions.trim()) return { ok: false, failure };
  return { ok: true, value: { requestId: input.requestId, sourceNodeId: input.sourceNodeId, connectionId: input.connectionId, model: input.model, variant: input.variant, instructions: input.instructions } };
}

export function decodeFrozenImageDirectorSource(input: unknown): FrozenImageDirectorSource | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ["sourceNodeId", "assetId", "contentVersion", "checksum", "mimeType", "width", "height"]) || !isNonEmptyWorldId(input.sourceNodeId) || !isNonEmptyWorldId(input.assetId) || !isNonEmptyWorldId(input.contentVersion) || typeof input.checksum !== "string" || !/^[0-9a-f]{64}$/.test(input.checksum) || !["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(String(input.mimeType)) || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || (input.width as number) <= 0 || (input.height as number) <= 0) return null;
  return { sourceNodeId: input.sourceNodeId, assetId: input.assetId, contentVersion: input.contentVersion, checksum: input.checksum, mimeType: input.mimeType as string, width: input.width as number, height: input.height as number };
}

export interface ImageDirectorModelCandidate {
  key: string;
  name: string;
  script: string;
  transform: WorldTransform;
}

export interface ImageDirectorSceneCandidate {
  version: typeof IMAGE_DIRECTOR_SCENE_VERSION;
  models: ImageDirectorModelCandidate[];
  camera: Pick<WorldCameraData, "position" | "rotation" | "projection">;
  qualityNotes?: string;
}

export const IMAGE_DIRECTOR_SCENE_STAGES = ["preparing", "generating", "repairing", "validating", "placing", "saving", "delivered", "failed", "cancelled"] as const;
export type ImageDirectorSceneStage = (typeof IMAGE_DIRECTOR_SCENE_STAGES)[number];
export function decodeImageDirectorSceneStage(input: unknown): ImageDirectorSceneStage | null {
  return typeof input === "string" && (IMAGE_DIRECTOR_SCENE_STAGES as readonly string[]).includes(input) ? input as ImageDirectorSceneStage : null;
}
export interface ImageDirectorSceneReceipt {
  operationId: string;
  source: FrozenImageDirectorSource;
  modelNodeIds: string[];
  areaNodeId: string;
  cameraNodeId: string;
  forward: import("./edit-plan.js").EditPlan["forward"];
  inverse: import("./edit-plan.js").EditPlan["inverse"];
}

export interface ImageDirectorSceneReservation {
  nodeId: string;
  areaId: string;
  scopeVersion: string;
  bounds: import("./shared-world.js").GroundAabb;
}

export function decodeImageDirectorSceneReceipt(input: unknown): ImageDirectorSceneReceipt | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ["operationId", "source", "modelNodeIds", "areaNodeId", "cameraNodeId", "forward", "inverse"]) || !isNonEmptyWorldId(input.operationId) || !isNonEmptyWorldId(input.areaNodeId) || !isNonEmptyWorldId(input.cameraNodeId) || !Array.isArray(input.modelNodeIds) || !input.modelNodeIds.length || !input.modelNodeIds.every(isNonEmptyWorldId)) return null;
  const ids = [...input.modelNodeIds, input.areaNodeId, input.cameraNodeId];
  if (new Set(ids).size !== ids.length || !isJsonRecord(input.forward) || !hasOnlyKeys(input.forward, ["preconditions", "operations"]) || !isJsonRecord(input.inverse) || !hasOnlyKeys(input.inverse, ["preconditions", "operations"])) return null;
  const source = decodeFrozenImageDirectorSource(input.source);
  const forward = decodeEditApplyCommand({ type: "edit.apply", ...input.forward });
  const inverse = decodeEditApplyCommand({ type: "edit.apply", ...input.inverse });
  if (!source || !forward || !inverse) return null;
  return { operationId: input.operationId, source, modelNodeIds: [...input.modelNodeIds], areaNodeId: input.areaNodeId, cameraNodeId: input.cameraNodeId, forward: { preconditions: [...forward.preconditions], operations: [...forward.operations] }, inverse: { preconditions: [...inverse.preconditions], operations: [...inverse.operations] } };
}

export interface ImageDirectorScenePort {
  prepare(input: { owner: string; canvasId: string; sourceNodeId: string }): Promise<{ source: FrozenImageDirectorSource; bytes: Uint8Array }>;
  reserve(input: { owner: string; canvasId: string; operationId: string; requestId?: string; source: FrozenImageDirectorSource }): Promise<ImageDirectorSceneReservation>;
  validate(input: { owner: string; canvasId: string; candidate: unknown; source: FrozenImageDirectorSource; signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; diagnostic: string }>;
  plan(input: { owner: string; canvasId: string; source: FrozenImageDirectorSource; candidate: ImageDirectorSceneCandidate; reservation?: ImageDirectorSceneReservation; signal?: AbortSignal }): Promise<{ delta: import("./shared-world.js").GroundPoint; bounds: import("./shared-world.js").GroundAabb }>;
  commit(input: { owner: string; canvasId: string; operationId: string; commandId: string; source: FrozenImageDirectorSource; candidate: ImageDirectorSceneCandidate; reservation?: ImageDirectorSceneReservation; delta: import("./shared-world.js").GroundPoint; bounds: import("./shared-world.js").GroundAabb; signal?: AbortSignal }): Promise<{ ok: true; receipt: ImageDirectorSceneReceipt; revision: number; duplicate: boolean } | { ok: false; code: string; message: string }>;
  settleReservation(input: { owner: string; canvasId: string; reservation: ImageDirectorSceneReservation; status: "failed" | "cancelled" }): Promise<void>;
  lookup(input: { owner: string; canvasId: string; commandId: string }): Promise<{ ok: true; receipt: ImageDirectorSceneReceipt; revision: number } | { ok: false; code: string; message: string }>;
}

export type ImageDirectorCandidateDecode = { ok: true; value: ImageDirectorSceneCandidate } | { ok: false; diagnostic: string };

/** Shape validation is followed by isolated script execution and spatial validation. */
export function decodeImageDirectorSceneCandidate(input: unknown, aspect: { width: number; height: number }): ImageDirectorCandidateDecode {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ["version", "models", "camera", "qualityNotes"]) || input.version !== IMAGE_DIRECTOR_SCENE_VERSION) return { ok: false, diagnostic: "Invalid candidate envelope" };
  if (!Array.isArray(input.models) || input.models.length === 0) return { ok: false, diagnostic: "At least one model is required" };
  const models: ImageDirectorModelCandidate[] = [];
  const keys = new Set<string>();
  for (const model of input.models) {
    if (!isJsonRecord(model) || !hasOnlyKeys(model, ["key", "name", "script", "transform"]) || !isNonEmptyWorldId(model.key) || !isNonEmptyWorldId(model.name) || !isNonEmptyWorldId(model.script) || keys.has(model.key)) return { ok: false, diagnostic: "Invalid or duplicate model" };
    const transform = decodeWorldTransform(model.transform);
    if (!transform.ok) return { ok: false, diagnostic: `Invalid transform for ${model.key}` };
    keys.add(model.key);
    models.push({ key: model.key, name: model.name, script: model.script, transform: transform.value });
  }
  if (!isJsonRecord(input.camera) || !hasOnlyKeys(input.camera, ["position", "rotation", "projection"])) return { ok: false, diagnostic: "Invalid camera" };
  const camera = decodeWorldCamera({ kind: "world-camera", version: SHARED_WORLD_VERSION, cameraId: "candidate", settingsVersion: "candidate", ...input.camera, captureMode: { kind: "static" }, aspect, boundInstanceId: null });
  if (!camera.ok) return { ok: false, diagnostic: "Invalid camera or source aspect" };
  if (input.qualityNotes !== undefined && input.qualityNotes !== null && typeof input.qualityNotes !== "string") return { ok: false, diagnostic: "Invalid quality notes" };
  return { ok: true, value: { version: IMAGE_DIRECTOR_SCENE_VERSION, models, camera: { position: camera.value.position, rotation: camera.value.rotation, projection: camera.value.projection }, ...(typeof input.qualityNotes === "string" ? { qualityNotes: input.qualityNotes } : {}) } };
}

export function imageDirectorSceneModelGuide(): string {
  const guide = modelApiGuide();
  return JSON.stringify({ ...guide, methods: guide.methods.filter(method => !["oscillate", "move", "rotate"].includes(method.name)) });
}
