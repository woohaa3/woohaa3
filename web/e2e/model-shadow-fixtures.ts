import { parseGlbModel } from "../contracts/src/canvas/glb/parse.js";

/** A real GLB through the production parser, with a double-sided horizontal sheet. */
export function shadowGlbFixture() {
  const positions = new Float32Array([-2, 2, -1, 0, 2, -1, 0, 2, 1, -2, 2, 1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const binary = new Uint8Array(positions.byteLength + indices.byteLength);
  binary.set(new Uint8Array(positions.buffer));
  binary.set(new Uint8Array(indices.buffer), positions.byteLength);
  const document = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-2, 2, -1], max: [0, 2, 1] },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [.8, .8, .8, 1], metallicFactor: 0, roughnessFactor: .8 } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
  };
  const json = new TextEncoder().encode(JSON.stringify(document));
  const padded = (json.length + 3) & ~3;
  const bytes = new Uint8Array(28 + padded + binary.length);
  const view = new DataView(bytes.buffer);
  [0x46546c67, 2, bytes.length, padded, 0x4e4f534a].forEach((value, i) => view.setUint32(i * 4, value, true));
  bytes.fill(32, 20, 20 + padded);
  bytes.set(json, 20);
  view.setUint32(20 + padded, binary.length, true);
  view.setUint32(24 + padded, 0x004e4942, true);
  bytes.set(binary, 28 + padded);
  const parsed = parseGlbModel(bytes);
  if (!parsed.ok) throw new Error(`GLB shadow fixture: ${parsed.code}: ${parsed.message}`);
  return parsed;
}
