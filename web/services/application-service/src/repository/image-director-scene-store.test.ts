import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ImageDirectorSceneStore, type ImageDirectorSceneRecord } from "./image-director-scene-store.js";

describe("image director ledger", () => {
  it("persists a request and rejects the same identity with different input", () => {
    const dir = mkdtempSync(join(tmpdir(), "image-director-"));
    const path = join(dir, "state.sqlite");
    const record: ImageDirectorSceneRecord = { owner: "owner", canvasId: "canvas", request: { requestId: "request", sourceNodeId: "image", connectionId: "connection", model: "model", variant: null, instructions: "" }, inputHash: "hash", source: { sourceNodeId: "image", assetId: "asset", contentVersion: "version", checksum: "checksum", mimeType: "image/png", width: 1, height: 1 }, imageBase64: "AA==", connectionVersion: "v1", stage: "preparing", attempts: [] };
    try {
      const store = new ImageDirectorSceneStore(path);
      expect(store.insert(record).reused).toBe(false);
      expect(store.insert(record).reused).toBe(true);
      expect(() => store.insert({ ...record, inputHash: "different" })).toThrow("request-id-conflict");
      store.save({ ...record, stage: "generating" });
      store.close();
      const reopened = new ImageDirectorSceneStore(path);
      expect(reopened.get("owner", "canvas", "request")?.stage).toBe("generating");
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
