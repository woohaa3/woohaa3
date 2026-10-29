/**
 * 静态 GLB（glTF 2.0 binary）→ Scene IR V2 转换
 * （change: 2026-10-28-support-glb-model-nodes，design「渲染」）。
 *
 * 只做**无损静态子集**：
 * - 三角网格（POSITION / NORMAL / TEXCOORD_0 / COLOR_0）与节点层级、TRS 变换；
 * - 基础 metallic-roughness PBR、内嵌 PNG/JPEG baseColor 纹理、alphaMode blend、doubleSided、
 *   `KHR_materials_unlit` 与 `KHR_materials_emissive_strength`。
 *
 * 明确拒绝（而不是静默显示错误结果）：外部 uri、压缩/量化扩展、蒙皮、形变、alphaMode MASK、
 * 非三角图元、未知必需扩展与超出预算的输入。动画不播放，但静态基姿态仍可正确显示，因此允许。
 *
 * 纯函数、无 I/O：纹理只返回原始图片字节，解码/上传由浏览器侧完成。
 */
import { fnv1a64HexBytes } from "../content-hash.js";
import { normalizeHex } from "../scene-ir-v2/reader.js";
import type { SceneV2MaterialOp, SceneV2Op, SceneV2ShapeOp } from "../scene-ir-v2/types.js";
import type { Vec3 } from "../model-transform.js";

/** 原始 GLB 文件上限（与服务端媒体上限独立；超出时先于上传失败）。 */
export const GLB_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** 整个模型累计顶点上限（Scene IR 单 mesh 上限之外的应用预算，避免阻塞画布）。 */
export const GLB_MAX_VERTICES = 100_000;
/** 整个模型累计三角面上限。 */
export const GLB_MAX_FACES = 160_000;
/** 单个 mesh op 的顶点上限（与 Scene IR 16 位索引宽度一致）。 */
const GLB_MAX_MESH_VERTICES = 65_000;
/** 单个 mesh op 的面上限。 */
const GLB_MAX_MESH_FACES = 130_000;
/** 节点数量上限。 */
export const GLB_MAX_NODES = 4_096;
/** 纹理数量上限（每种材质至多一张 baseColor 纹理）。 */
export const GLB_MAX_TEXTURES = 8;
/** 解码后纹理单边上限（前端解码时按此缩放）。 */
export const GLB_MAX_TEXTURE_EDGE = 1_024;

/** 支持的扩展；`extensionsUsed` 出现其它扩展一律明确拒绝。 */
const SUPPORTED_EXTENSIONS = new Set(["KHR_materials_unlit", "KHR_materials_emissive_strength"]);
/** 材质级扩展白名单（与全局 extensionsUsed 检查互为补充，防止未声明的扩展被静默忽略）。 */
const SUPPORTED_MATERIAL_EXTENSIONS = SUPPORTED_EXTENSIONS;

export type GlbErrorCode =
  | "not-glb"
  | "unsupported-version"
  | "malformed"
  | "unsupported-extension"
  | "external-resource"
  | "unsupported-feature"
  | "unsupported-material"
  | "budget-exceeded"
  | "no-geometry";

export type GlbTexture = {
  /** 稳定纹理 id（内容寻址）；同一图片在多次解析中保持一致。 */
  id: string;
  mimeType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
};

export type GlbModelStats = {
  nodes: number;
  primitives: number;
  vertices: number;
  faces: number;
  materials: number;
  textures: number;
};

export type GlbParseResult =
  | { ok: true; ops: SceneV2Op[]; textures: GlbTexture[]; stats: GlbModelStats }
  | { ok: false; code: GlbErrorCode; message: string };

type Json = Record<string, unknown>;
type Fail = { ok: false; code: GlbErrorCode; message: string };
type Ok<T> = { ok: true } & T;
type Result<T = object> = Ok<T> | Fail;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4
};

function fail(code: GlbErrorCode, message: string): Fail {
  return { ok: false, code, message };
}

function ok<T>(value: T): Ok<T> {
  return { ok: true, ...value };
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asIndex(value: unknown, limit: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < limit ? value : null;
}

/** 解析 GLB 二进制并转换为 Scene IR V2。 */
export function parseGlbModel(input: Uint8Array): GlbParseResult {
  if (!(input instanceof Uint8Array)) return fail("not-glb", "文件内容不可读取");
  if (input.byteLength > GLB_MAX_FILE_BYTES) {
    return fail("budget-exceeded", `GLB 文件超过 ${Math.round(GLB_MAX_FILE_BYTES / 1024 / 1024)}MB 上限`);
  }
  if (input.byteLength < 20) return fail("not-glb", "文件过小，不是合法的 GLB");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return fail("not-glb", "文件不是 GLB（缺少 glTF 标识）");
  if (view.getUint32(4, true) !== 2) return fail("unsupported-version", "只支持 glTF 2.0 GLB");
  if (view.getUint32(8, true) !== input.byteLength) {
    return fail("malformed", "GLB 头长度与文件实际长度不一致");
  }

  let offset = 12;
  let jsonText: string | null = null;
  let bin: Uint8Array | null = null;
  while (offset + 8 <= input.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > input.byteLength) return fail("malformed", "GLB 分块长度超出文件");
    const chunk = input.subarray(start, start + length);
    if (type === CHUNK_JSON) {
      if (jsonText !== null) return fail("malformed", "GLB 含多个 JSON 分块");
      jsonText = new TextDecoder().decode(chunk).replace(/\u0000+$/g, "").trimEnd();
    } else if (type === CHUNK_BIN) {
      if (bin !== null) return fail("malformed", "GLB 含多个二进制分块");
      bin = chunk;
    }
    offset = (start + length + 3) & ~3;
  }
  if (jsonText === null) return fail("malformed", "GLB 缺少 JSON 分块");

  let document: unknown;
  try {
    document = JSON.parse(jsonText);
  } catch {
    return fail("malformed", "GLB JSON 分块无法解析");
  }
  if (!isObject(document)) return fail("malformed", "GLB JSON 根必须是对象");
  if (isObject(document.asset) && typeof document.asset.version === "string"
    && document.asset.version !== "2.0") {
    return fail("unsupported-version", `只支持 glTF 2.0（文件声明 ${document.asset.version}）`);
  }
  return buildScene(document, bin);
}

function buildScene(document: Json, bin: Uint8Array | null): GlbParseResult {
  const named = (value: unknown): string[] =>
    asArray(value).filter((entry): entry is string => typeof entry === "string");
  for (const extension of named(document.extensionsUsed)) {
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return fail("unsupported-extension", `不支持的 glTF 扩展：${extension}`);
    }
  }
  for (const extension of named(document.extensionsRequired)) {
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return fail("unsupported-extension", `文件要求不支持的 glTF 扩展：${extension}`);
    }
  }

  const buffers = asArray(document.buffers);
  for (const raw of buffers) {
    if (!isObject(raw)) return fail("malformed", "buffers 条目必须是对象");
    if (raw.uri !== undefined) return fail("external-resource", "不支持外部 buffer uri（只接受 GLB 内嵌二进制）");
  }
  if (!isObject(buffers[0])) return fail("malformed", "GLB 缺少 buffer");
  const bufferLength = typeof buffers[0].byteLength === "number" ? buffers[0].byteLength : 0;
  if (!(bufferLength > 0)) return fail("malformed", "GLB buffer.byteLength 非法");
  const binBytes = bin ?? new Uint8Array(0);
  if (bufferLength > binBytes.byteLength) return fail("malformed", "GLB 二进制分块短于 buffer.byteLength");

  const bufferViews = asArray(document.bufferViews);
  for (const raw of bufferViews) {
    if (!isObject(raw)) return fail("malformed", "bufferViews 条目必须是对象");
    if (raw.buffer !== 0) return fail("malformed", "bufferView 必须引用内嵌 buffer 0");
    const start = typeof raw.byteOffset === "number" ? raw.byteOffset : 0;
    const length = typeof raw.byteLength === "number" ? raw.byteLength : -1;
    if (!(start >= 0) || !(length > 0) || start + length > bufferLength) {
      return fail("malformed", "bufferView 越界");
    }
  }

  const accessors = asArray(document.accessors);
  for (const raw of accessors) {
    if (!isObject(raw)) return fail("malformed", "accessors 条目必须是对象");
    if (raw.sparse !== undefined) return fail("unsupported-feature", "不支持稀疏 accessor");
    if (typeof raw.bufferView !== "number") return fail("unsupported-feature", "不支持无 bufferView 的 accessor");
    if (typeof raw.count !== "number" || !Number.isInteger(raw.count) || raw.count < 0) {
      return fail("malformed", "accessor.count 非法");
    }
    const componentType = raw.componentType;
    if (typeof componentType !== "number" || COMPONENT_BYTES[componentType] === undefined) {
      return fail("malformed", "accessor.componentType 非法");
    }
  }

  if (asArray(document.skins).length > 0) return fail("unsupported-feature", "不支持蒙皮模型");

  const images = asArray(document.images);
  const textures: GlbTexture[] = [];
  const textureIdByImage = new Map<number, string>();
  const textureIdByIndex = new Map<number, string>();
  const gltfTextures = asArray(document.textures);
  for (let index = 0; index < gltfTextures.length; index += 1) {
    const raw = gltfTextures[index];
    if (!isObject(raw)) return fail("malformed", "textures 条目必须是对象");
    if (isObject(raw.extensions)) return fail("unsupported-extension", "不支持纹理扩展");
    const source = asIndex(raw.source, images.length);
    if (source === null) return fail("malformed", "texture 缺少有效 image 索引");
    const id = ensureTexture(source, images, bufferViews, binBytes, textures, textureIdByImage);
    if (!id.ok) return id;
    textureIdByIndex.set(index, id.id);
  }

  const gltfMaterials = asArray(document.materials);
  const materials: SceneV2MaterialOp[] = [];
  for (let index = 0; index < gltfMaterials.length; index += 1) {
    const raw = gltfMaterials[index];
    if (!isObject(raw)) return fail("malformed", "materials 条目必须是对象");
    const material = readMaterial(raw, index, textureIdByIndex);
    if (!material.ok) return material;
    materials.push(material.id);
  }

  const gltfMeshes = asArray(document.meshes);
  const gltfNodes = asArray(document.nodes);
  if (gltfNodes.length > GLB_MAX_NODES) {
    return fail("budget-exceeded", `GLB 节点数超过 ${GLB_MAX_NODES} 上限`);
  }
  const gltfScenes = asArray(document.scenes);

  let roots: number[] = [];
  if (gltfScenes.length > 0) {
    const requested = document.scene === undefined ? 0 : document.scene;
    const sceneIndex = asIndex(requested, gltfScenes.length);
    if (sceneIndex === null) return fail("malformed", "默认场景索引非法");
    const scene = gltfScenes[sceneIndex];
    if (!isObject(scene)) return fail("malformed", "scenes 条目必须是对象");
    roots = asArray(scene.nodes)
      .map((value) => asIndex(value, gltfNodes.length))
      .filter((value): value is number => value !== null);
  } else {
    // 无 scenes：按 glTF 规则把全部无父节点当作根。
    const children = new Set<number>();
    for (const raw of gltfNodes) {
      if (!isObject(raw)) continue;
      for (const child of asArray(raw.children)) {
        const value = asIndex(child, gltfNodes.length);
        if (value !== null) children.add(value);
      }
    }
    roots = gltfNodes.map((_, index) => index).filter((index) => !children.has(index));
  }

  const ops: SceneV2Op[] = [...materials];
  const stats = {
    nodes: 0,
    primitives: 0,
    vertices: 0,
    faces: 0,
    materials: materials.length,
    textures: textures.length
  };
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (nodeIndex: number, parent: string | null, depth: number): Result => {
    if (depth > GLB_MAX_NODES) return fail("malformed", "GLB 节点层级异常");
    if (visiting.has(nodeIndex)) return fail("malformed", "GLB 节点层级存在环");
    if (visited.has(nodeIndex)) return fail("malformed", "GLB 节点被多个父节点引用");
    const raw = gltfNodes[nodeIndex];
    if (!isObject(raw)) return fail("malformed", "nodes 条目必须是对象");
    visiting.add(nodeIndex);
    stats.nodes += 1;
    const transform = readNodeTransform(raw);
    if (!transform.ok) return transform;
    const id = `glb-n${nodeIndex}`;
    ops.push({
      t: "group",
      id,
      parent,
      position: transform.position,
      rotation: transform.rotation,
      scale: transform.scale,
      material: null,
      color: null
    });
    if (raw.mesh !== undefined) {
      const meshIndex = asIndex(raw.mesh, gltfMeshes.length);
      if (meshIndex === null) return fail("malformed", "node.mesh 索引非法");
      const mesh = gltfMeshes[meshIndex];
      if (!isObject(mesh)) return fail("malformed", "meshes 条目必须是对象");
      const primitives = asArray(mesh.primitives);
      for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex += 1) {
        const primitive = primitives[primitiveIndex];
        if (!isObject(primitive)) return fail("malformed", "primitive 必须是对象");
        const built = buildPrimitive(
          primitive,
          id,
          `glb-n${nodeIndex}p${primitiveIndex}`,
          accessors,
          bufferViews,
          binBytes,
          materials,
          gltfMaterials.length
        );
        if (!built.ok) return built;
        ops.push(...built.ops);
        stats.primitives += 1;
        stats.vertices += built.vertices;
        stats.faces += built.faces;
        if (stats.vertices > GLB_MAX_VERTICES) {
          return fail("budget-exceeded", `模型顶点数超过 ${GLB_MAX_VERTICES} 上限`);
        }
        if (stats.faces > GLB_MAX_FACES) {
          return fail("budget-exceeded", `模型面数超过 ${GLB_MAX_FACES} 上限`);
        }
      }
    }
    for (const child of asArray(raw.children)) {
      const childIndex = asIndex(child, gltfNodes.length);
      if (childIndex === null) return fail("malformed", "node.children 索引非法");
      const result = visit(childIndex, id, depth + 1);
      if (!result.ok) return result;
    }
    visiting.delete(nodeIndex);
    visited.add(nodeIndex);
    return ok({});
  };

  for (const root of roots) {
    const result = visit(root, null, 0);
    if (!result.ok) return fail(result.code, result.message);
  }

  if (stats.faces === 0) return fail("no-geometry", "GLB 没有可显示的三角网格");
  return ok({ ops, textures, stats });
}

function ensureTexture(
  imageIndex: number,
  images: unknown[],
  bufferViews: unknown[],
  bin: Uint8Array,
  textures: GlbTexture[],
  byImage: Map<number, string>
): Result<{ id: string }> {
  const existing = byImage.get(imageIndex);
  if (existing) return ok({ id: existing });
  if (textures.length >= GLB_MAX_TEXTURES) {
    return fail("budget-exceeded", `模型纹理数超过 ${GLB_MAX_TEXTURES} 上限`);
  }
  const raw = images[imageIndex];
  if (!isObject(raw)) return fail("malformed", "images 条目必须是对象");
  if (raw.uri !== undefined) return fail("external-resource", "不支持外部图像 uri（只接受内嵌纹理）");
  const mimeType = raw.mimeType;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    return fail("unsupported-feature", `不支持的纹理格式：${String(mimeType)}`);
  }
  const viewIndex = asIndex(raw.bufferView, bufferViews.length);
  if (viewIndex === null) return fail("malformed", "image.bufferView 非法");
  const imageView = bufferViews[viewIndex];
  if (!isObject(imageView)) return fail("malformed", "bufferView 非法");
  const offset = typeof imageView.byteOffset === "number" ? imageView.byteOffset : 0;
  const length = typeof imageView.byteLength === "number" ? imageView.byteLength : 0;
  if (!(length > 0) || offset + length > bin.byteLength) return fail("malformed", "内嵌图像越界");
  const bytes = bin.subarray(offset, offset + length);
  const id = `glbtex:${fnv1a64HexBytes(bytes)}`;
  textures.push({ id, mimeType, bytes });
  byImage.set(imageIndex, id);
  return ok({ id });
}

function readMaterial(
  raw: Json,
  index: number,
  textureIds: ReadonlyMap<number, string>
): Result<{ id: SceneV2MaterialOp }> {
  const pbr = isObject(raw.pbrMetallicRoughness) ? raw.pbrMetallicRoughness : {};
  const baseColor = asArray(pbr.baseColorFactor);
  const alpha = typeof baseColor[3] === "number" ? clampUnit(baseColor[3]) : 1;
  const alphaMode = typeof raw.alphaMode === "string" ? raw.alphaMode : "OPAQUE";
  if (alphaMode === "MASK") {
    return fail("unsupported-material", `material ${index} 使用 alphaMode=MASK，当前版本不支持`);
  }
  if (alphaMode !== "OPAQUE" && alphaMode !== "BLEND") {
    return fail("unsupported-material", `material ${index} 的 alphaMode 非法`);
  }
  const extensions = isObject(raw.extensions) ? raw.extensions : {};
  for (const key of Object.keys(extensions)) {
    if (!SUPPORTED_MATERIAL_EXTENSIONS.has(key)) {
      return fail("unsupported-extension", `不支持材质扩展：${key}`);
    }
  }
  const unlit = isObject(extensions.KHR_materials_unlit);
  const emissive = asArray(raw.emissiveFactor);
  let emissiveStrength = 1;
  if (isObject(extensions.KHR_materials_emissive_strength)) {
    const value = extensions.KHR_materials_emissive_strength.emissiveStrength;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 32) {
      return fail("unsupported-material", `material ${index} 的 emissiveStrength 非法`);
    }
    emissiveStrength = value;
  }
  let baseColorTexture: string | undefined;
  if (isObject(pbr.baseColorTexture)) {
    if (isObject(pbr.baseColorTexture.extensions)) {
      return fail("unsupported-extension", `material ${index} 使用了不支持的纹理变换扩展`);
    }
    if (pbr.baseColorTexture.texCoord !== undefined && pbr.baseColorTexture.texCoord !== 0) {
      return fail("unsupported-feature", `material ${index} 使用了 TEXCOORD_${String(pbr.baseColorTexture.texCoord)}，当前只支持 UV0`);
    }
    const textureIndex = pbr.baseColorTexture.index;
    if (typeof textureIndex !== "number" || !Number.isInteger(textureIndex)) {
      return fail("malformed", `material ${index} 的 baseColorTexture 索引非法`);
    }
    const id = textureIds.get(textureIndex);
    if (!id) return fail("malformed", `material ${index} 引用了未声明纹理`);
    baseColorTexture = id;
  }
  const emissiveLit = emissive.some((value) => typeof value === "number" && value > 0);
  const material: SceneV2MaterialOp = {
    t: "material",
    id: `glb-m${index}`,
    baseColor: rgbHex(baseColor),
    roughness: clampUnit(typeof pbr.roughnessFactor === "number" ? pbr.roughnessFactor : 1),
    metallic: clampUnit(typeof pbr.metallicFactor === "number" ? pbr.metallicFactor : 1),
    emissive: emissiveLit ? rgbHex(emissive) : "#000000",
    emissiveStrength: emissiveLit ? emissiveStrength : 0,
    alphaMode: alphaMode === "BLEND" ? "blend" : "opaque",
    doubleSided: raw.doubleSided === true,
    ...(unlit ? { unlit: true } : {}),
    ...(alphaMode === "BLEND" && alpha < 1 ? { opacity: alpha } : {}),
    ...(baseColorTexture === undefined ? {} : { baseColorTexture })
  };
  return ok({ id: material });
}

function rgbHex(values: unknown[]): string {
  const channel = (index: number): number => {
    const value = values[index];
    return typeof value === "number" && Number.isFinite(value) ? Math.round(clampUnit(value) * 255) : 255;
  };
  const [r, g, b] = [channel(0), channel(1), channel(2)];
  return normalizeHex(`#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 固定小数位（去掉浮点噪声与无意义低位；`-0` 归一为 `0`）。 */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

type TransformValue = { position: Vec3; rotation: Vec3; scale: Vec3 };

function readNodeTransform(raw: Json): Result<TransformValue> {
  let position: Vec3 = [0, 0, 0];
  let rotation: [number, number, number, number] = [0, 0, 0, 1];
  let scale: Vec3 = [1, 1, 1];
  if (raw.matrix !== undefined) {
    const matrix = asArray(raw.matrix);
    if (matrix.length !== 16 || !matrix.every((value) => typeof value === "number" && Number.isFinite(value))) {
      return fail("malformed", "node.matrix 非法");
    }
    const decomposed = decomposeMatrix(matrix as number[]);
    if (!decomposed) return fail("malformed", "node.matrix 无法分解为 TRS");
    position = decomposed.position;
    rotation = decomposed.rotation;
    scale = decomposed.scale;
  }
  const readVec = (value: unknown, size: number): number[] | null => {
    if (value === undefined) return null;
    const array = asArray(value);
    if (array.length !== size || !array.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      return null;
    }
    return array as number[];
  };
  if (raw.translation !== undefined) {
    const value = readVec(raw.translation, 3);
    if (!value) return fail("malformed", "node.translation 非法");
    position = [value[0], value[1], value[2]];
  }
  if (raw.rotation !== undefined) {
    const value = readVec(raw.rotation, 4);
    if (!value) return fail("malformed", "node.rotation 非法");
    rotation = [value[0], value[1], value[2], value[3]];
  }
  if (raw.scale !== undefined) {
    const value = readVec(raw.scale, 3);
    if (!value) return fail("malformed", "node.scale 非法");
    scale = [value[0] === 0 ? 0.0001 : value[0], value[1] === 0 ? 0.0001 : value[1], value[2] === 0 ? 0.0001 : value[2]];
  }
  return ok({ position, rotation: eulerYXZDegrees(rotation), scale });
}

/** 四元数 `[x,y,z,w]` → 与 `quatFromEulerYXZDegrees` 互逆的 YXZ 欧拉角（度）。 */
export function eulerYXZDegrees(quaternion: [number, number, number, number]): Vec3 {
  const [x, y, z, w] = quaternion;
  const norm = Math.hypot(x, y, z, w) || 1;
  const qx = x / norm;
  const qy = y / norm;
  const qz = z / norm;
  const qw = w / norm;
  // R = Ry * Rx * Rz 的矩阵元素（与 `quatFromEulerYXZDegrees` 同一组合顺序）。
  const m10 = 2 * (qx * qy + qz * qw);
  const m11 = 1 - 2 * (qx * qx + qz * qz);
  const m12 = 2 * (qy * qz - qx * qw);
  const m02 = 2 * (qx * qz + qy * qw);
  const m22 = 1 - 2 * (qx * qx + qy * qy);
  const sinX = Math.max(-1, Math.min(1, -m12));
  const ex = Math.asin(sinX);
  let ey: number;
  let ez: number;
  if (Math.abs(sinX) > 0.999999) {
    ey = Math.atan2(-m02, m11);
    ez = 0;
  } else {
    ey = Math.atan2(m02, m22);
    ez = Math.atan2(m10, m11);
  }
  const toDegrees = (value: number): number => {
    const degrees = (value * 180) / Math.PI;
    return Math.abs(degrees) < 1e-9 ? 0 : degrees;
  };
  return [toDegrees(ex), toDegrees(ey), toDegrees(ez)];
}

/** 列主序 4x4 矩阵分解为位置 / 旋转 / 缩放（负行列式时把 x 缩放取负）。 */
function decomposeMatrix(
  matrix: number[]
): { position: Vec3; rotation: [number, number, number, number]; scale: Vec3 } | null {
  const c0: Vec3 = [matrix[0], matrix[1], matrix[2]];
  const c1: Vec3 = [matrix[4], matrix[5], matrix[6]];
  const c2: Vec3 = [matrix[8], matrix[9], matrix[10]];
  const position: Vec3 = [matrix[12], matrix[13], matrix[14]];
  let sx = Math.hypot(...c0);
  const sy = Math.hypot(...c1);
  const sz = Math.hypot(...c2);
  const determinant =
    c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
    c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
    c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
  if (determinant < 0) sx = -sx;
  if (sx === 0 || sy === 0 || sz === 0) return null;
  const r0: Vec3 = [c0[0] / sx, c0[1] / sx, c0[2] / sx];
  const r1: Vec3 = [c1[0] / sy, c1[1] / sy, c1[2] / sy];
  const r2: Vec3 = [c2[0] / sz, c2[1] / sz, c2[2] / sz];
  const m00 = r0[0], m01 = r1[0], m02 = r2[0];
  const m10 = r0[1], m11 = r1[1], m12 = r2[1];
  const m20 = r0[2], m21 = r1[2], m22 = r2[2];
  const trace = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    qw = s / 4;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s;
    qx = s / 4;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = s / 4;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = s / 4;
  }
  return { position, rotation: [qx, qy, qz, qw], scale: [sx, sy, sz] };
}

type PrimitiveResult = Result<{ ops: SceneV2ShapeOp[]; vertices: number; faces: number }>;

function buildPrimitive(
  primitive: Json,
  parent: string,
  baseId: string,
  accessors: unknown[],
  bufferViews: unknown[],
  bin: Uint8Array,
  materials: SceneV2MaterialOp[],
  materialCount: number
): PrimitiveResult {
  const mode = primitive.mode === undefined ? 4 : primitive.mode;
  if (mode !== 4) {
    return fail("unsupported-feature", `不支持图元模式 ${String(mode)}（只支持三角网格 TRIANGLES）`);
  }
  if (primitive.targets !== undefined) return fail("unsupported-feature", "不支持形变（morph target）");
  if (isObject(primitive.extensions)) return fail("unsupported-extension", "不支持图元扩展（含压缩数据）");
  const attributes = isObject(primitive.attributes) ? primitive.attributes : null;
  if (!attributes) return fail("malformed", "primitive 缺少 attributes");
  const positionIndex = asIndex(attributes.POSITION, accessors.length);
  if (positionIndex === null) return fail("malformed", "primitive 缺少 POSITION");
  const positions = readFloats(accessors, bufferViews, bin, positionIndex, "VEC3", false);
  if (!positions.ok) return positions;
  const vertexCount = positions.values.length / 3;
  if (vertexCount === 0) return fail("no-geometry", "primitive 没有顶点");

  const indices = primitive.indices === undefined
    ? ok({ values: Array.from({ length: vertexCount }, (_, index) => index) })
    : readFloats(accessors, bufferViews, bin, asIndex(primitive.indices, accessors.length), "SCALAR", false);
  if (!indices.ok) return indices;
  const indexData = indices.values;
  if (indexData.length % 3 !== 0) return fail("malformed", "三角网格索引数量不是 3 的倍数");
  if (indexData.some((value) => !Number.isInteger(value) || value < 0 || value >= vertexCount)) {
    return fail("malformed", "三角网格索引越界或不是整数");
  }

  const materialIndex = primitive.material === undefined ? null : asIndex(primitive.material, materialCount);
  if (primitive.material !== undefined && materialIndex === null) {
    return fail("malformed", "primitive.material 索引非法");
  }
  const material = materialIndex === null ? null : (materials[materialIndex]?.id ?? null);

  const normals = attributes.NORMAL === undefined
    ? null
    : readFloats(accessors, bufferViews, bin, asIndex(attributes.NORMAL, accessors.length), "VEC3", true);
  if (normals && !normals.ok) return normals;
  const uvs = attributes.TEXCOORD_0 === undefined
    ? null
    : readFloats(accessors, bufferViews, bin, asIndex(attributes.TEXCOORD_0, accessors.length), "VEC2", true);
  if (uvs && !uvs.ok) return uvs;
  const colors = attributes.COLOR_0 === undefined
    ? null
    : readColorFloats(accessors, bufferViews, bin, asIndex(attributes.COLOR_0, accessors.length));
  if (colors && !colors.ok) return colors;

  const normalData = normals?.values ?? null;
  const uvData = uvs?.values ?? null;
  const colorData = colors?.values ?? null;
  if (normalData && normalData.length !== vertexCount * 3) return fail("malformed", "NORMAL 数量与顶点数不一致");
  if (uvData && uvData.length !== vertexCount * 2) return fail("malformed", "TEXCOORD_0 数量与顶点数不一致");
  if (colorData && colorData.length !== vertexCount * 4) return fail("malformed", "COLOR_0 数量与顶点数不一致");

  const ops: SceneV2ShapeOp[] = [];
  let chunkVertices: Vec3[] = [];
  let chunkNormals: Vec3[] = [];
  let chunkUvs: [number, number][] = [];
  let chunkColors: [number, number, number, number][] = [];
  let chunkFaces: number[][] = [];
  let chunkMap = new Map<number, number>();

  const flush = (): void => {
    if (chunkFaces.length === 0) return;
    ops.push({
      t: "mesh",
      id: `${baseId}c${ops.length}`,
      parent,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material,
      color: material === null ? "#cccccc" : null,
      vertices: chunkVertices,
      ...(normalData ? { normals: chunkNormals } : {}),
      ...(uvData ? { uvs: chunkUvs } : {}),
      ...(colorData ? { colors: chunkColors } : {}),
      faces: chunkFaces
    });
    chunkVertices = [];
    chunkNormals = [];
    chunkUvs = [];
    chunkColors = [];
    chunkFaces = [];
    chunkMap = new Map();
  };

  for (let index = 0; index < indexData.length; index += 3) {
    const corners = [indexData[index], indexData[index + 1], indexData[index + 2]];
    const missing = corners.filter((corner) => !chunkMap.has(corner)).length;
    if (chunkVertices.length + missing > GLB_MAX_MESH_VERTICES || chunkFaces.length + 1 > GLB_MAX_MESH_FACES) {
      flush();
    }
    const face: number[] = [];
    for (const corner of corners) {
      let local = chunkMap.get(corner);
      if (local === undefined) {
        local = chunkVertices.length;
        chunkMap.set(corner, local);
        // 受控精度：去掉无意义低位既保持外观，又把跨边界 JSON 控制在预算内。
        chunkVertices.push([
          roundTo(positions.values[corner * 3], 5),
          roundTo(positions.values[corner * 3 + 1], 5),
          roundTo(positions.values[corner * 3 + 2], 5)
        ]);
        if (normalData) {
          chunkNormals.push([
            roundTo(normalData[corner * 3], 4),
            roundTo(normalData[corner * 3 + 1], 4),
            roundTo(normalData[corner * 3 + 2], 4)
          ]);
        }
        if (uvData) {
          chunkUvs.push([
            roundTo(uvData[corner * 2], 5),
            roundTo(uvData[corner * 2 + 1], 5)
          ]);
        }
        if (colorData) {
          chunkColors.push([
            roundTo(colorData[corner * 4], 4),
            roundTo(colorData[corner * 4 + 1], 4),
            roundTo(colorData[corner * 4 + 2], 4),
            roundTo(colorData[corner * 4 + 3], 4)
          ]);
        }
      }
      face.push(local);
    }
    chunkFaces.push(face);
  }
  flush();
  return ok({ ops, vertices: vertexCount, faces: indexData.length / 3 });
}

/** COLOR_0：接受 VEC4 或 VEC3（VEC3 补 alpha=1），与 glTF 常见导出保持兼容。 */
function readColorFloats(
  accessors: unknown[],
  bufferViews: unknown[],
  bin: Uint8Array,
  accessorIndex: number | null
): Result<{ values: number[] }> {
  if (accessorIndex === null) return fail("malformed", "accessor 索引非法");
  const accessor = accessors[accessorIndex];
  if (!isObject(accessor)) return fail("malformed", "accessor 不存在");
  if (accessor.type === "VEC3") {
    const read = readFloats(accessors, bufferViews, bin, accessorIndex, "VEC3", true);
    if (!read.ok) return read;
    const values: number[] = [];
    for (let index = 0; index < read.values.length; index += 3) {
      values.push(read.values[index], read.values[index + 1], read.values[index + 2], 1);
    }
    return ok({ values });
  }
  return readFloats(accessors, bufferViews, bin, accessorIndex, "VEC4", true);
}

const ACCESSOR_TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4
};

function readFloats(
  accessors: unknown[],
  bufferViews: unknown[],
  bin: Uint8Array,
  accessorIndex: number | null,
  expectedType: "SCALAR" | "VEC2" | "VEC3" | "VEC4",
  allowNormalized: boolean
): Result<{ values: number[] }> {
  if (accessorIndex === null) return fail("malformed", "accessor 索引非法");
  const accessor = accessors[accessorIndex];
  if (!isObject(accessor)) return fail("malformed", "accessor 不存在");
  if (accessor.type !== expectedType) {
    return fail("malformed", `accessor 类型 ${String(accessor.type)} 与属性 ${expectedType} 不符`);
  }
  const count = typeof accessor.count === "number" ? accessor.count : 0;
  const componentType = typeof accessor.componentType === "number" ? accessor.componentType : -1;
  const size = COMPONENT_BYTES[componentType];
  if (size === undefined) return fail("malformed", "accessor.componentType 非法");
  const normalized = accessor.normalized === true;
  if (normalized && !allowNormalized) return fail("malformed", "该属性不支持 normalized 数据");
  const viewIndex = typeof accessor.bufferView === "number" ? accessor.bufferView : -1;
  const view = bufferViews[viewIndex];
  if (!isObject(view)) return fail("malformed", "accessor.bufferView 非法");
  const viewOffset = typeof view.byteOffset === "number" ? view.byteOffset : 0;
  const viewLength = typeof view.byteLength === "number" ? view.byteLength : 0;
  const components = ACCESSOR_TYPE_COMPONENTS[expectedType] ?? 1;
  const stride = typeof view.byteStride === "number" && view.byteStride > 0 ? view.byteStride : size * components;
  const elementOffset = typeof accessor.byteOffset === "number" ? accessor.byteOffset : 0;
  const scale = normalized
    ? componentType === 5120 ? 1 / 127
      : componentType === 5121 ? 1 / 255
        : componentType === 5122 ? 1 / 32767
          : 1 / 65535
    : 1;
  const floats = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const readComponent = (at: number): number => {
    switch (componentType) {
      case 5120: return signed8(bin, at);
      case 5121: return bin[at] ?? 0;
      case 5122: return signed16(bin, at);
      case 5123: return (bin[at] ?? 0) | ((bin[at + 1] ?? 0) << 8);
      case 5125:
        return (bin[at] ?? 0) + (bin[at + 1] ?? 0) * 256 + (bin[at + 2] ?? 0) * 65536 + (bin[at + 3] ?? 0) * 16777216;
      default: return floats.getFloat32(at, true);
    }
  };
  const values: number[] = [];
  const base = viewOffset + elementOffset;
  for (let index = 0; index < count; index += 1) {
    const at = base + index * stride;
    if (at + components * size > viewOffset + viewLength) return fail("malformed", "accessor 数据越界");
    for (let component = 0; component < components; component += 1) {
      const value = readComponent(at + component * size) * scale;
      if (!Number.isFinite(value)) return fail("malformed", "accessor 含非法数值");
      values.push(value);
    }
  }
  return ok({ values });
}

function signed8(bytes: Uint8Array, at: number): number {
  const value = bytes[at] ?? 0;
  return value > 127 ? value - 256 : value;
}

function signed16(bytes: Uint8Array, at: number): number {
  const value = (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  return value > 32767 ? value - 65536 : value;
}
