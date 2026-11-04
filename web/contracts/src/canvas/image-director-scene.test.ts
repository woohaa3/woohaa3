import { describe, expect, it } from "vitest";
import { decodeFrozenImageDirectorSource, decodeImageDirectorSceneCandidate, decodeImageDirectorSceneFailure, decodeImageDirectorSceneReceipt, decodeImageDirectorSceneRequest, decodeImageDirectorSceneStage, IMAGE_DIRECTOR_SCENE_VERSION, imageDirectorSceneCandidateSchema, imageDirectorSceneModelGuide } from "./image-director-scene.js";
import { SHARED_WORLD_VERSION } from "./shared-world.js";

const candidate = () => ({
  version: IMAGE_DIRECTOR_SCENE_VERSION,
  models: [{ key: "subject", name: "Subject", script: "scene.box({})", transform: { version: SHARED_WORLD_VERSION, position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } }],
  camera: { position: { u: 0, v: 2, h: 1 }, rotation: [0, 0, 0, 1], projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 } }
});
const aspect = { width: 1920, height: 1080 };

describe("image director scene candidate", () => {
  it("accepts a candidate with a valid world transform and camera", () => {
    expect(decodeImageDirectorSceneCandidate(candidate(), aspect).ok).toBe(true);
    expect(imageDirectorSceneModelGuide()).toContain("scene.box");
  });
  it("uses strict structured output with nullable optional notes", () => {
    expect(imageDirectorSceneCandidateSchema.properties.camera.properties.projection).toHaveProperty("anyOf");
    expect(imageDirectorSceneCandidateSchema.required).toContain("qualityNotes");
    expect(decodeImageDirectorSceneCandidate({ ...candidate(), qualityNotes: null }, aspect).ok).toBe(true);
  });
  it("rejects duplicate identities, invalid transforms and camera injection", () => {
    const duplicate = candidate();
    duplicate.models.push(duplicate.models[0]!);
    expect(decodeImageDirectorSceneCandidate(duplicate, aspect).ok).toBe(false);
    const invalid = candidate();
    invalid.models[0]!.transform.scale = Infinity;
    expect(decodeImageDirectorSceneCandidate(invalid, aspect).ok).toBe(false);
    expect(decodeImageDirectorSceneCandidate({ ...candidate(), camera: { ...candidate().camera, boundInstanceId: "other" } }, aspect).ok).toBe(false);
    expect(decodeImageDirectorSceneCandidate(candidate(), { width: 0, height: 1 }).ok).toBe(false);
  });
  it("rejects forged request fields and invalid frozen image facts", () => {
    const request = { requestId: "r", sourceNodeId: "n", connectionId: "c", model: "m", variant: null, instructions: "build" };
    expect(decodeImageDirectorSceneRequest(request).ok).toBe(true);
    expect(decodeImageDirectorSceneRequest({ ...request, owner: "forged" }).ok).toBe(false);
    expect(decodeImageDirectorSceneRequest({ ...request, variant: "invalid" }).ok).toBe(false);
    expect(decodeFrozenImageDirectorSource({ sourceNodeId: "n", assetId: "a", contentVersion: "v", checksum: "bad", mimeType: "image/png", width: 2, height: 2 })).toBeNull();
    expect(decodeImageDirectorSceneStage("placing")).toBe("placing");
    expect(decodeImageDirectorSceneStage("invented")).toBeNull();
    expect(decodeImageDirectorSceneFailure({ code: "cancelled", message: "stopped" })).toEqual({ code: "cancelled", message: "stopped" });
    const edit = { preconditions: [], operations: [{ kind: "node-remove", nodeIds: ["model"] }] };
    const receipt = { operationId: "op", source: { sourceNodeId: "n", assetId: "a", contentVersion: "v", checksum: "a".repeat(64), mimeType: "image/png", width: 1, height: 1 }, modelNodeIds: ["model"], areaNodeId: "area", cameraNodeId: "camera", forward: edit, inverse: edit };
    expect(decodeImageDirectorSceneReceipt(receipt)).not.toBeNull();
    expect(decodeImageDirectorSceneReceipt({ ...receipt, cameraNodeId: "area" })).toBeNull();
  });
});
