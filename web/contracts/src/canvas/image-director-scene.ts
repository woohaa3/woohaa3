import { hasOnlyKeys, isJsonRecord, isNonEmptyWorldId } from "./shared-world-codec.js";
import { isAgentReasoningEffort } from "../extension/assistant/conversation.js";

export const IMAGE_DIRECTOR_SCENE_VERSION = "image-director-scene-v1" as const;
export const IMAGE_DIRECTOR_SCENE_DEFAULT_PROMPT = "根据图片创建可编辑的 3D 场景，尽量还原主体、比例、空间布局和构图，将主要对象分别建模，并创建与原图画幅一致的默认镜头。";

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

export type ImageDirectorSceneFailureCode = "invalid-request" | "source-unavailable" | "connection-unavailable" | "role-unavailable" | "finalize-failed" | "cancelled";
export type ImageDirectorSceneFailure = { code: ImageDirectorSceneFailureCode; message: string };
export function decodeImageDirectorSceneFailure(input: unknown): ImageDirectorSceneFailure | null {
  const codes: readonly string[] = ["invalid-request", "source-unavailable", "connection-unavailable", "role-unavailable", "finalize-failed", "cancelled"];
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

export const IMAGE_DIRECTOR_SCENE_STAGES = ["preparing", "generating", "finalizing", "delivered", "failed", "cancelled"] as const;
export type ImageDirectorSceneStage = (typeof IMAGE_DIRECTOR_SCENE_STAGES)[number];
export function decodeImageDirectorSceneStage(input: unknown): ImageDirectorSceneStage | null {
  return typeof input === "string" && (IMAGE_DIRECTOR_SCENE_STAGES as readonly string[]).includes(input) ? input as ImageDirectorSceneStage : null;
}

export interface ImageDirectorSceneReceipt {
  operationId: string;
  source: FrozenImageDirectorSource;
  areaNodeId: string;
  modelNodeIds: string[];
  cameraNodeId?: string;
}

export interface ImageDirectorSceneReservation {
  nodeId: string;
  areaId: string;
  scopeVersion: string;
  bounds: import("./shared-world.js").GroundAabb;
}

export function decodeImageDirectorSceneReceipt(input: unknown): ImageDirectorSceneReceipt | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ["operationId", "source", "areaNodeId", "modelNodeIds", "cameraNodeId"]) || !isNonEmptyWorldId(input.operationId) || !isNonEmptyWorldId(input.areaNodeId) || !Array.isArray(input.modelNodeIds) || !input.modelNodeIds.every(isNonEmptyWorldId) || (input.cameraNodeId !== undefined && !isNonEmptyWorldId(input.cameraNodeId))) return null;
  const source = decodeFrozenImageDirectorSource(input.source);
  if (!source) return null;
  return { operationId: input.operationId, source, areaNodeId: input.areaNodeId, modelNodeIds: [...input.modelNodeIds], ...(input.cameraNodeId !== undefined ? { cameraNodeId: input.cameraNodeId } : {}) };
}

export interface ImageDirectorScenePort {
  prepare(input: { owner: string; canvasId: string; sourceNodeId: string }): Promise<{ source: FrozenImageDirectorSource; bytes: Uint8Array; nodeIds: string[] }>;
  reserve(input: { owner: string; canvasId: string; operationId: string; requestId?: string; source: FrozenImageDirectorSource }): Promise<ImageDirectorSceneReservation>;
  finalize(input: { owner: string; canvasId: string; operationId: string; commandId: string; reservation: ImageDirectorSceneReservation; source: FrozenImageDirectorSource; beforeNodeIds: readonly string[] }): Promise<{ ok: true; receipt: ImageDirectorSceneReceipt; revision: number; duplicate: boolean } | { ok: false; code: string; message: string }>;
  settleReservation(input: { owner: string; canvasId: string; reservation: ImageDirectorSceneReservation; status: "failed" | "cancelled" }): Promise<void>;
  lookup(input: { owner: string; canvasId: string; commandId: string }): Promise<{ ok: true; receipt: ImageDirectorSceneReceipt; revision: number } | { ok: false; code: string; message: string }>;
}
