import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  composeSomaWalkingWave,
  decodeSomaNpy,
  decodeSomaRootPositions,
  decodeSomaPosedJoints,
  prepareSomaMotion,
} from "./index.js";
import { encodeSomaNpz } from "./compose.js";
import { SOMA77_JOINTS } from "../soma-humanoid/skeleton.js";
function source(frames: number, waving: boolean) {
  const local = new Float32Array(frames * 77 * 9),
    posed = new Float32Array(frames * 77 * 3),
    roots = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f++) {
    roots[f * 3] = f * 0.1;
    roots[f * 3 + 1] = 1;
    for (let j = 0; j < 77; j++) {
      const a = (f * 77 + j) * 9;
      local[a] = local[a + 4] = local[a + 8] = 1;
    }
    if (!waving)
      for (const joint of [67, 68, 72, 73]) {
        const a = (f * 77 + joint) * 9,
          angle = 0.3 * Math.sin(f * 0.4 + (joint >= 72 ? Math.PI : 0));
        local[a + 4] = local[a + 8] = Math.cos(angle);
        local[a + 5] = -Math.sin(angle);
        local[a + 7] = Math.sin(angle);
      }
    if (waving) {
      const a = (f * 77 + 12) * 9,
        t = 0.2 + f * 0.02;
      local[a + 4] = local[a + 8] = Math.cos(t);
      local[a + 5] = -Math.sin(t);
      local[a + 7] = Math.sin(t);
      if (f >= 3 && f <= 14) posed[(f * 77 + 14) * 3 + 1] = 2;
    }
  }
  return {
    bytes: encodeSomaNpz({
      local_rot_mats: { shape: [frames, 77, 3, 3], values: local },
      root_positions: { shape: [frames, 3], values: roots },
      posed_joints: { shape: [frames, 77, 3], values: posed },
    }),
    local,
  };
}
describe("trusted walking wave composition", () => {
  it("decodes pickle-free boolean contact arrays", () => {
    const header = new TextEncoder().encode(
      "{'descr': '|b1', 'fortran_order': False, 'shape': (2,), }\n",
    );
    const bytes = new Uint8Array(10 + header.length + 2);
    bytes.set([147, 78, 85, 77, 80, 89, 1, 0]);
    new DataView(bytes.buffer).setUint16(8, header.length, true);
    bytes.set(header, 10);
    bytes[10 + header.length + 1] = 1;
    expect(decodeSomaNpy(bytes)).toEqual({ shape: [2], values: [0, 1] });
  });
  it("preserves travel and lower-body rotations and reconstructs official FK", async () => {
    const walk = source(40, false),
      wave = source(20, true),
      result = await composeSomaWalkingWave(walk.bytes, wave.bytes, 30);
    expect(result.raisedWindow).toEqual({ start: 3, end: 14 });
    expect(result.frameCount).toBe(40);
    expect(result.walkDistance).toBeCloseTo(3.9);
    const prepared = await prepareSomaMotion(
      new Uint8Array(
        readFileSync(
          new URL(
            "../../../../frontend/public/soma/skin_standard.npz",
            import.meta.url,
          ),
        ),
      ),
      result.bytes,
    );
    for (let f = 0; f < 40; f++)
      for (const j of [0, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76])
        for (let k = 0; k < 9; k++)
          expect(prepared.localRotations[(f * 77 + j) * 9 + k]).toBe(
            walk.local[(f * 77 + j) * 9 + k],
          );
    const roots = await decodeSomaRootPositions(result.bytes),
      posed = await decodeSomaPosedJoints(result.bytes);
    expect(roots[117]).toBeCloseTo(3.9);
    expect(posed.length).toBe(40 * 77 * 3);
    expect(posed[13 * 3 + 1]).not.toBeCloseTo(
      posed[12 * 3 + 1] + SOMA77_JOINTS[13].position[1],
      5,
    );
    expect(result.bytes).toEqual(
      (await composeSomaWalkingWave(walk.bytes, wave.bytes, 30)).bytes,
    );
  });
  it("rejects static legs even with translated roots", async () => {
    const still = source(20, true);
    await expect(
      composeSomaWalkingWave(still.bytes, still.bytes, 30),
    ).rejects.toThrow("both legs");
  });
  it("accepts articulated in-place walking", async () => {
    const walk = source(20, false),
      wave = source(20, true);
    const bytes = encodeSomaNpz({
      local_rot_mats: { shape: [20, 77, 3, 3], values: walk.local },
      root_positions: { shape: [20, 3], values: new Float32Array(60) },
    });
    expect(
      (await composeSomaWalkingWave(bytes, wave.bytes, 30)).walkDistance,
    ).toBe(0);
  });
  it("rejects missing raised interval, invalid fps, malformed source and reflections", async () => {
    const walk = source(10, false);
    await expect(
      composeSomaWalkingWave(walk.bytes, walk.bytes, 30),
    ).rejects.toThrow("eight consecutive");
    await expect(
      composeSomaWalkingWave(walk.bytes, walk.bytes, NaN),
    ).rejects.toThrow("fps");
    await expect(
      composeSomaWalkingWave(new Uint8Array(), walk.bytes, 30),
    ).rejects.toThrow();
    const bad = source(20, true);
    bad.local[0] = -1;
    const bytes = encodeSomaNpz({
      local_rot_mats: { shape: [20, 77, 3, 3], values: bad.local },
      root_positions: { shape: [20, 3], values: new Float32Array(60) },
    });
    await expect(composeSomaWalkingWave(bytes, bad.bytes, 30)).rejects.toThrow(
      "reflected",
    );
  });
});
