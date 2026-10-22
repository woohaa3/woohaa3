import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canvasPositionUpdateRequest, CANVAS_POSITION_UPDATE_VERSION, CANVAS_POSITION_MAX_BYTES, CANVAS_POSITION_MAX_UPDATES } from "./position-update.js";

describe("position preview wire", () => {
  it("encodes moved roots/descendants and optional viewport without unrelated data", () => {
    const parsed = JSON.parse(canvasPositionUpdateRequest({ baseSceneGeneration: 7,
      positions: [{ id: "group", x: 20, y: 40 }, { id: "child", x: 30, y: 50 }],
      viewport: { x: -10, y: 0, zoom: 0.5 }
    }));
    expect(parsed).toEqual({ version: CANVAS_POSITION_UPDATE_VERSION, baseSceneGeneration: 7,
      positions: [{ id: "group", x: 20, y: 40 }, { id: "child", x: 30, y: 50 }],
      viewport: { x: -10, y: 0, zoom: 0.5 } });
    expect(Object.keys(parsed)).not.toContain("nodes");
  });
  it("keeps Rust version and bounds identical", () => {
    const rust = readFileSync(fileURLToPath(new URL("../../../../bevy/src/protocol/position.rs", import.meta.url)), "utf8");
    expect(rust).toContain(`"${CANVAS_POSITION_UPDATE_VERSION}"`);
    expect(rust).toContain(`MAX_POSITION_UPDATES: usize = ${CANVAS_POSITION_MAX_UPDATES.toLocaleString("en-US").replaceAll(",", "_")}`);
    expect(CANVAS_POSITION_MAX_BYTES).toBe(1024 * 1024);
    expect(rust).toContain("MAX_POSITION_UPDATE_BYTES: usize = 1024 * 1024");
  });
  it("rejects stale identity shapes, duplicate IDs and invalid batches before encoding", () => {
    const good = { baseSceneGeneration: 1, positions: [{ id: "a", x: 0, y: 0 }] };
    for (const baseSceneGeneration of [0, -1, 1.5, NaN, Infinity, 2 ** 32]) {
      expect(() => canvasPositionUpdateRequest({ ...good, baseSceneGeneration })).toThrow("Invalid position base generation");
    }
    expect(() => canvasPositionUpdateRequest({ ...good, positions: [] })).toThrow("Invalid position update count");
    expect(() => canvasPositionUpdateRequest({ ...good, positions: [good.positions[0]!, good.positions[0]!] })).toThrow("Duplicate position node");
    expect(() => canvasPositionUpdateRequest({ ...good, positions: [{ id: "a", x: Infinity, y: 0 }] })).toThrow("Invalid position values");
    expect(() => canvasPositionUpdateRequest({ ...good, viewport: { x: 0, y: 0, zoom: 99 } })).toThrow("Invalid position viewport");
    expect(() => canvasPositionUpdateRequest({ ...good, positions: [{ id: "汉".repeat(CANVAS_POSITION_MAX_BYTES / 2), x: 0, y: 0 }] })).toThrow("Position payload too large");
  });
});
