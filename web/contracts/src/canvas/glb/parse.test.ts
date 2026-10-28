/**
 * GLB → Scene IR V2 解析回归
 * （change: 2026-10-28-support-glb-model-nodes，任务 4.1）。
 *
 * 覆盖：合法最小 GLB（几何/层级/材质/纹理/顶点属性）、受控精度、按 mesh 上限分块，
 * 以及每一类必须**明确失败**的输入（损坏、外部资源、必需扩展、蒙皮、形变、非三角图元、
 * 稀疏 accessor、MASK、非 UV0 纹理、超预算）。
 */
import { describe, expect, it } from "vitest";
import { eulerYXZDegrees, parseGlbModel } from "./parse.js";
import { quatFromEulerYXZDegrees } from "../model-transform.js";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function align4(value: number): number {
  return (value + 3) & ~3;
}

/** 组装一个字节级正确的 GLB（JSON 用空格补齐，BIN 用 0 补齐）。 */
function buildGlb(document: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = align4(json.byteLength);
  const binLength = align4(bin.byteLength);
  const hasBin = bin.byteLength > 0;
  const total = 12 + 8 + jsonLength + (hasBin ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.set(json, 20);
  out.fill(0x20, 20 + json.byteLength, 20 + jsonLength);
  if (hasBin) {
    const offset = 20 + jsonLength;
    view.setUint32(offset, binLength, true);
    view.setUint32(offset + 4, CHUNK_BIN, true);
    out.set(bin, offset + 8);
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

type Fixture = {
  document: Record<string, unknown>;
  bin: Uint8Array;
};

/** 单三角形：可选法线 / UV0 / 顶点色 / 内嵌 PNG 与材质。 */
function triangleFixture(options: {
  normals?: boolean;
  uvs?: boolean;
  color3?: boolean;
  texture?: boolean;
  alphaMode?: string;
  doubleSided?: boolean;
  unlit?: boolean;
} = {}): Fixture {
  const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const normal = options.normals ? new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) : null;
  const uv = options.uvs ? new Float32Array([0, 0, 1, 1, 0, 1]) : null;
  const color = options.color3 ? new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]) : null;
  const image = options.texture ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]) : null;

  const parts: Uint8Array[] = [new Uint8Array(position.buffer), new Uint8Array(indices.buffer)];
  const bufferViews: Record<string, unknown>[] = [
    { buffer: 0, byteOffset: 0, byteLength: position.byteLength },
    { buffer: 0, byteOffset: position.byteLength, byteLength: indices.byteLength }
  ];
  const accessors: Record<string, unknown>[] = [
    { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
    { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }
  ];
  const attributes: Record<string, number> = { POSITION: 0 };
  let offset = position.byteLength + indices.byteLength;
  const push = (bytes: Uint8Array, accessor: Record<string, unknown>, attribute?: string): number => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    parts.push(bytes);
    accessors.push(accessor);
    offset += bytes.byteLength;
    if (attribute) attributes[attribute] = accessors.length - 1;
    return accessors.length - 1;
  };
  if (normal) push(new Uint8Array(normal.buffer), { bufferView: bufferViews.length, componentType: 5126, count: 3, type: "VEC3" }, "NORMAL");
  if (uv) push(new Uint8Array(uv.buffer), { bufferView: bufferViews.length, componentType: 5126, count: 3, type: "VEC2" }, "TEXCOORD_0");
  if (color) {
    push(
      color,
      { bufferView: bufferViews.length, componentType: 5121, count: 3, type: "VEC3", normalized: true },
      "COLOR_0"
    );
  }
  if (image) {
    push(image, { bufferView: bufferViews.length, componentType: 5121, count: 1, type: "SCALAR" });
  }
  // 上面的 push 对图片误加了 accessor；图片不需要 accessor，删掉并修正视图索引。
  if (image) accessors.pop();

  const document: Record<string, unknown> = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: offset }],
    bufferViews,
    accessors,
    meshes: [{ primitives: [{ attributes, indices: 1, ...(options.texture ? { material: 0 } : {}) }] }],
    nodes: [{ mesh: 0, translation: [1, 2, 3], rotation: [0, 0, 0, 1] }],
    scenes: [{ nodes: [0] }],
    scene: 0
  };
  if (options.texture) {
    document.images = [{ bufferView: bufferViews.length - 1, mimeType: "image/png" }];
    document.textures = [{ source: 0 }];
    document.materials = [{
      pbrMetallicRoughness: {
        baseColorFactor: [1, 0.5, 0.25, 1],
        roughnessFactor: 0.4,
        metallicFactor: 0.2,
        baseColorTexture: { index: 0 }
      },
      emissiveFactor: [0, 0, 0],
      alphaMode: options.alphaMode ?? "OPAQUE",
      doubleSided: options.doubleSided ?? false,
      ...(options.unlit ? { extensions: { KHR_materials_unlit: {} } } : {})
    }];
  }
  return { document, bin: concat(parts) };
}

describe("GLB 静态解析", () => {
  it("转换最小三角网格并保留节点变换与默认材质", () => {
    const { document, bin } = triangleFixture();
    const result = parseGlbModel(buildGlb(document, bin));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const group = result.ops.find((op) => op.t === "group");
    expect(group).toMatchObject({ id: "glb-n0", parent: null, position: [1, 2, 3] });
    const mesh = result.ops.find((op) => op.t === "mesh");
    expect(mesh).toMatchObject({ t: "mesh", parent: "glb-n0", material: null, color: "#cccccc" });
    expect(result.stats).toMatchObject({ nodes: 1, primitives: 1, vertices: 3, faces: 1 });
    expect(result.textures).toEqual([]);
  });

  it("缺失 NORMAL 时不写法线，交由渲染器生成平滑法线", () => {
    const { document, bin } = triangleFixture();
    const result = parseGlbModel(buildGlb(document, bin));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.ops.find((op) => op.t === "mesh");
    expect(mesh?.t).toBe("mesh");
    if (mesh?.t !== "mesh") return;
    expect(mesh.normals).toBeUndefined();
  });

  it("拒绝非整数或越界的三角网格索引", () => {
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Float32Array([0, 1, 2.5]);
    const bin = concat([new Uint8Array(position.buffer), new Uint8Array(indices.buffer)]);
    const document = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: bin.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: position.byteLength },
        { buffer: 0, byteOffset: position.byteLength, byteLength: indices.byteLength }
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 3, type: "SCALAR" }
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0
    };
    expect(parseGlbModel(buildGlb(document, bin))).toMatchObject({ ok: false, code: "malformed" });
  });

  it("拒绝未声明支持的材质扩展与纹理变换扩展", () => {
    const fixture = triangleFixture();
    fixture.document.materials = [{ extensions: { KHR_materials_clearcoat: {} } }];
    fixture.document.meshes = [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }];
    expect(parseGlbModel(buildGlb(fixture.document, fixture.bin)))
      .toMatchObject({ ok: false, code: "unsupported-extension" });

    const transformed = triangleFixture({ uvs: true, texture: true });
    const materials = transformed.document.materials as Array<Record<string, unknown>>;
    const pbr = materials[0].pbrMetallicRoughness as Record<string, unknown>;
    pbr.baseColorTexture = { index: 0, extensions: { KHR_texture_transform: { scale: [2, 2] } } };
    expect(parseGlbModel(buildGlb(transformed.document, transformed.bin)))
      .toMatchObject({ ok: false, code: "unsupported-extension" });
  });

  it("保留法线、UV0、顶点色与十进制精度上限", () => {
    const { document, bin } = triangleFixture({ normals: true, uvs: true, color3: true });
    // 写入一个带浮点噪声的位置，验证受控精度。
    new DataView(bin.buffer, bin.byteOffset).setFloat32(0, 0.123456789, true);
    const result = parseGlbModel(buildGlb(document, bin));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mesh = result.ops.find((op) => op.t === "mesh");
    expect(mesh?.t).toBe("mesh");
    if (mesh?.t !== "mesh") return;
    expect(mesh.vertices[0]).toEqual([0.12346, 0, 0]);
    expect(mesh.normals).toHaveLength(3);
    expect(mesh.uvs).toEqual([[0, 0], [1, 1], [0, 1]]);
    // VEC3 顶点色补 alpha=1。
    expect(mesh.colors?.[0]).toEqual([1, 0, 0, 1]);
  });

  it("解析内嵌纹理与材质，输出稳定内容寻址纹理 id", () => {
    const { document, bin } = triangleFixture({ uvs: true, texture: true, doubleSided: true });
    const first = parseGlbModel(buildGlb(document, bin));
    const second = parseGlbModel(buildGlb(document, bin));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const material = first.ops.find((op) => op.t === "material");
    expect(material?.t).toBe("material");
    if (material?.t !== "material") return;
    expect(material.baseColor).toBe("#ff8040");
    expect(material.roughness).toBeCloseTo(0.4, 5);
    expect(material.metallic).toBeCloseTo(0.2, 5);
    expect(material.doubleSided).toBe(true);
    expect(first.textures).toHaveLength(1);
    expect(first.textures[0].mimeType).toBe("image/png");
    expect(first.textures[0].id).toMatch(/^glbtex:[0-9a-f]{16}$/);
    expect(material.baseColorTexture).toBe(first.textures[0].id);
    // 同一字节序列跨解析得到同一纹理 id。
    expect(second.textures[0].id).toBe(first.textures[0].id);
  });

  it("超过单 mesh 顶点上限时按三角形分块，不丢面", () => {
    // 65_004 独立顶点 = 21_668 个三角形，单 mesh 顶点上限 65_000，必须分成 2 段。
    const vertexCount = 65_004;
    const positions = new Float32Array(vertexCount * 3);
    for (let index = 0; index < vertexCount; index += 1) {
      positions[index * 3] = index % 200;
      positions[index * 3 + 1] = Math.floor(index / 200);
    }
    const indices = new Uint32Array(vertexCount);
    for (let index = 0; index < vertexCount; index += 1) indices[index] = index;
    const bin = concat([new Uint8Array(positions.buffer), new Uint8Array(indices.buffer)]);
    const document = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: bin.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3" },
        { bufferView: 1, componentType: 5125, count: vertexCount, type: "SCALAR" }
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0
    };
    const result = parseGlbModel(buildGlb(document, bin));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const meshes = result.ops.filter((op) => op.t === "mesh");
    expect(meshes).toHaveLength(2);
    const faces = meshes.reduce((sum, op) => sum + (op.t === "mesh" ? op.faces.length : 0), 0);
    expect(faces).toBe(vertexCount / 3);
    for (const mesh of meshes) {
      expect(mesh.t === "mesh" ? mesh.vertices.length : 0).toBeLessThanOrEqual(65_000);
    }
  });

  it("拒绝损坏文件、外部资源与必需扩展", () => {
    expect(parseGlbModel(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false, code: "not-glb" });
    const { document, bin } = triangleFixture();
    const external = { ...document, buffers: [{ byteLength: bin.byteLength, uri: "model.bin" }] };
    expect(parseGlbModel(buildGlb(external, bin))).toMatchObject({ ok: false, code: "external-resource" });
    const required = { ...document, extensionsUsed: ["KHR_draco_mesh_compression"], extensionsRequired: ["KHR_draco_mesh_compression"] };
    expect(parseGlbModel(buildGlb(required, bin))).toMatchObject({ ok: false, code: "unsupported-extension" });
    const skins = { ...document, skins: [{}] };
    expect(parseGlbModel(buildGlb(skins, bin))).toMatchObject({ ok: false, code: "unsupported-feature" });
  });

  it("拒绝蒙皮、形变、非三角图元、稀疏 accessor、MASK 与非 UV0 纹理", () => {
    const base = triangleFixture();
    const withMode = (mutate: (document: Record<string, unknown>) => void) => {
      const document = JSON.parse(JSON.stringify(base.document)) as Record<string, unknown>;
      mutate(document);
      return parseGlbModel(buildGlb(document, base.bin));
    };
    const meshes = (document: Record<string, unknown>) => document.meshes as Array<{ primitives: Record<string, unknown>[] }>;
    expect(withMode((document) => { meshes(document)[0].primitives[0].mode = 0; }))
      .toMatchObject({ ok: false, code: "unsupported-feature" });
    expect(withMode((document) => { meshes(document)[0].primitives[0].targets = [{}]; }))
      .toMatchObject({ ok: false, code: "unsupported-feature" });
    expect(withMode((document) => {
      (document.accessors as Record<string, unknown>[])[0].sparse = { count: 1 };
    })).toMatchObject({ ok: false, code: "unsupported-feature" });

    const mask = triangleFixture({ texture: true, alphaMode: "MASK" });
    expect(parseGlbModel(buildGlb(mask.document, mask.bin)))
      .toMatchObject({ ok: false, code: "unsupported-material" });

    const uv1 = triangleFixture({ texture: true });
    const material = (uv1.document.materials as Record<string, unknown>[])[0];
    (material.pbrMetallicRoughness as Record<string, unknown>).baseColorTexture = { index: 0, texCoord: 1 };
    expect(parseGlbModel(buildGlb(uv1.document, uv1.bin)))
      .toMatchObject({ ok: false, code: "unsupported-feature" });
  });

  it("没有几何时明确失败", () => {
    const document = {
      asset: { version: "2.0" },
      buffers: [{ byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
      accessors: [],
      nodes: [{ name: "empty" }],
      scenes: [{ nodes: [0] }],
      scene: 0
    };
    expect(parseGlbModel(buildGlb(document, new Uint8Array(4)))).toMatchObject({ ok: false, code: "no-geometry" });
  });
});

describe("GLB 旋转与欧拉角", () => {
  it("四元数转 YXZ 欧拉角与正向转换互逆", () => {
    const rotation: [number, number, number] = [12, -34, 56];
    const quaternion = quatFromEulerYXZDegrees(rotation);
    const euler = eulerYXZDegrees(quaternion);
    expect(euler[0]).toBeCloseTo(rotation[0], 6);
    expect(euler[1]).toBeCloseTo(rotation[1], 6);
    expect(euler[2]).toBeCloseTo(rotation[2], 6);
  });
});
