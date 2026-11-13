import { describe, it, expect } from "vitest";
import { decodeSomaNpy, prepareSomaMotion, prepareSomaStandardMotion, sampleSomaMotion } from "./index";
function npy(descr: string, shape: number[], values: number[]) {
  const header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(",")}${shape.length === 1 ? "," : ""}), }\n`;
  const bytes = new Uint8Array(10 + header.length + values.length * 4);
  bytes.set([147, 78, 85, 77, 80, 89, 1, 0]);
  new DataView(bytes.buffer).setUint16(8, header.length, true);
  bytes.set(new TextEncoder().encode(header), 10);
  values.forEach((v, i) =>
    new DataView(bytes.buffer).setFloat32(10 + header.length + i * 4, v, true),
  );
  return bytes;
}
describe("SOMA safe arrays", () => {
  it("reads finite little-endian float arrays", () => {
    expect(decodeSomaNpy(npy("<f4", [2], [1, 2])).values).toEqual([1, 2]);
  });
  it("rejects executable object arrays and nonfinite data", () => {
    expect(() => decodeSomaNpy(npy("|O", [1], [0]))).toThrow();
    expect(() => decodeSomaNpy(npy("<f4", [1], [NaN]))).toThrow();
  });
  it("rejects invalid archives and time", async () => {
    await expect(
      prepareSomaMotion(new Uint8Array(), new Uint8Array()),
    ).rejects.toThrow();
    expect(() => sampleSomaMotion({} as never, NaN)).toThrow();
  });
});

import { readFileSync } from "node:fs";
import { somaMotionPayload } from "./index";
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}.npz`, import.meta.url)),
  );
it("preflights the full standard skeleton and refuses mismatched or malformed motion", async () => {
  const prepared = await prepareSomaStandardMotion(fixture("standard-body-motion"));
  expect(prepared.jointNames).toHaveLength(77);
  expect(prepared.frameCount).toBe(3);
  expect(Array.from(sampleSomaMotion(prepared, 2 / 30).positions).every(Number.isFinite)).toBe(true);
  await expect(prepareSomaStandardMotion(fixture("motion"))).rejects.toThrow();
  await expect(prepareSomaStandardMotion(new Uint8Array([1, 2, 3]))).rejects.toThrow();
});
it("decodes compressed Unicode/int64 skins and deterministically samples FK and LBS", async () => {
  const p = await prepareSomaMotion(fixture("skin"), fixture("motion"));
  expect(p.jointNames).toEqual(["Hips", "骨骼"]);
  expect(Array.from(sampleSomaMotion(p, 1 / 30).positions)).toEqual([
    2, 0, 0, 2, 1, 0, 3, 1, 0,
  ]);
  expect(sampleSomaMotion(p, 2 / 30, { loop: true }).frame).toBe(0);
  const payload = somaMotionPayload(p);
  expect(payload.skinMatrices.slice(32, 48)).toEqual([
    1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
});
it("rejects an archive with a forged CRC", async () => {
  const bytes = fixture("skin");
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 16, 0, true);
      break;
    }
  await expect(prepareSomaMotion(bytes, fixture("motion"))).rejects.toThrow(
    /CRC/,
  );
});
it("rejects invalid SO(3), FK/rest correspondence and joint topology", async () => {
  await expect(
    prepareSomaMotion(fixture("skin"), fixture("bad-rotation")),
  ).rejects.toThrow(/rotation/);
  await expect(
    prepareSomaMotion(fixture("skin"), fixture("bad-rest")),
  ).rejects.toThrow(/FK\/rest/);
  await expect(
    prepareSomaMotion(fixture("bad-topology"), fixture("motion")),
  ).rejects.toThrow(/topology/);
});
