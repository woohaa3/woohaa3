import { describe, expect, it } from "vitest";
import { decodeFrozenImageDirectorSource, decodeImageDirectorSceneFailure, decodeImageDirectorSceneReceipt, decodeImageDirectorSceneRequest, decodeImageDirectorSceneStage } from "./image-director-scene.js";

const request = { requestId: "request", sourceNodeId: "image", connectionId: "connection", model: "model", variant: null, instructions: "重建场景" };
const source = { sourceNodeId: "image", assetId: "asset", contentVersion: "v", checksum: "a".repeat(64), mimeType: "image/png", width: 4, height: 3 };

describe("image director scene contract", () => {
  it("decodes a strict request and source", () => {
    expect(decodeImageDirectorSceneRequest(request).ok).toBe(true);
    expect(decodeImageDirectorSceneRequest({ ...request, owner: "forged" }).ok).toBe(false);
    expect(decodeImageDirectorSceneRequest({ ...request, variant: "invalid" }).ok).toBe(false);
    expect(decodeFrozenImageDirectorSource(source)).toEqual(source);
  });

  it("decodes the finalize stage and receipt", () => {
    expect(decodeImageDirectorSceneStage("finalizing")).toBe("finalizing");
    expect(decodeImageDirectorSceneStage("placing")).toBeNull();
    expect(decodeImageDirectorSceneFailure({ code: "finalize-failed", message: "failed" })).toEqual({ code: "finalize-failed", message: "failed" });
    expect(decodeImageDirectorSceneReceipt({ operationId: "operation", source, areaNodeId: "area", modelNodeIds: ["model"] })).toEqual({ operationId: "operation", source, areaNodeId: "area", modelNodeIds: ["model"] });
    expect(decodeImageDirectorSceneReceipt({ operationId: "operation", source, areaNodeId: "area", modelNodeIds: ["model"], cameraNodeId: "camera" })).toMatchObject({ cameraNodeId: "camera" });
    expect(decodeImageDirectorSceneReceipt({ operationId: "operation", source, areaNodeId: "area", modelNodeIds: ["model"], cameraNodeId: "" })).toBeNull();
  });
});
