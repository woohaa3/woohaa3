/**
 * Scene IR V2：局部读取工具与 material/shape/animation reader
 * （自 `scene-ir-v2.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R14）。
 *
 * 只做局部字段校验；全局层级/ID/累计资源预算在 validator。
 */
import { lengthVec3, subVec3, type Vec3 } from "../model-transform.js";
import {
  ALPHA_MODES,
  AXES,
  CAPSULE_EPSILON,
  HEX_COLOR,
  MODES,
  SCENE_IR_V2_COORD_LIMIT,
  SCENE_IR_V2_MAX_EMISSIVE_STRENGTH,
  SCENE_IR_V2_MAX_MESH_FACES,
  SCENE_IR_V2_MAX_MESH_VERTICES,
  SCENE_IR_V2_MIN_SEGMENT_LENGTH,
  SEGMENT_SHAPES,
  fail,
  type ReadResult,
  type SceneV2AnimationOp,
  type SceneV2MaterialAlphaMode,
  type SceneV2MaterialOp,
  type SceneV2SegmentOp,
  type SceneV2ShapeBase,
  type SceneV2ShapeOp
} from "./types.js";

export function readMaterial(
  raw: Record<string, unknown>,
  index: number,
  existing: Set<string>
): ReadResult<SceneV2MaterialOp> {
  const id = readId(raw.id);
  if (!id) return fail("invalid-material", `第 ${index} 个 material 缺少合法 id`);
  if (existing.has(id)) return fail("duplicate-material", `重复的 material id：${id}`);
  for (const key of Object.keys(raw)) {
    if (!["t", "id", "baseColor", "roughness", "metallic", "emissive", "emissiveStrength", "alphaMode", "doubleSided", "unlit", "opacity", "baseColorTexture"].includes(key)) {
      return fail("invalid-material", `material ${id} 含未知字段 ${key}`);
    }
  }

  const baseColor = readRequiredColor(raw.baseColor, "#ffffff", id, "baseColor");
  if (!baseColor.ok) return baseColor;
  const emissive = readRequiredColor(raw.emissive, "#000000", id, "emissive");
  if (!emissive.ok) return emissive;
  const roughness = readUnit(raw.roughness, 0.5, id, "roughness");
  if (!roughness.ok) return roughness;
  const metallic = readUnit(raw.metallic, 0, id, "metallic");
  if (!metallic.ok) return metallic;
  const strength = readNumber(raw.emissiveStrength, 0);
  if (strength === null || strength < 0 || strength > SCENE_IR_V2_MAX_EMISSIVE_STRENGTH) {
    return fail("invalid-material", `material ${id} 的 emissiveStrength 非法`);
  }
  const alphaMode = raw.alphaMode ?? "opaque";
  if (typeof alphaMode !== "string" || !ALPHA_MODES.has(alphaMode)) {
    return fail("invalid-material", `material ${id} 的 alphaMode 非法`);
  }
  if (raw.doubleSided !== undefined && typeof raw.doubleSided !== "boolean") {
    return fail("invalid-material", `material ${id} 的 doubleSided 必须是布尔值`);
  }
  if (raw.unlit !== undefined && typeof raw.unlit !== "boolean") {
    return fail("invalid-material", `material ${id} 的 unlit 必须是布尔值`);
  }
  // opacity 只在 blend 下有意义：其它模式出现即拒绝，避免「看起来半透明却按不透明绘制」。
  const blend = alphaMode === "blend";
  let opacity: number | undefined;
  if (raw.opacity !== undefined && raw.opacity !== null) {
    if (!blend) {
      return fail("invalid-material", `material ${id} 的 opacity 只用于 alphaMode=blend`);
    }
    const value = readNumber(raw.opacity, null);
    if (value === null || value < 0 || value > 1) {
      return fail("invalid-material", `material ${id} 的 opacity 必须在 0..1`);
    }
    opacity = value;
  }
  let baseColorTexture: string | undefined;
  if (raw.baseColorTexture !== undefined && raw.baseColorTexture !== null) {
    const textureId = readTextureId(raw.baseColorTexture);
    if (textureId === null) {
      return fail("invalid-material", `material ${id} 的 baseColorTexture 非法`);
    }
    baseColorTexture = textureId;
  }
  return {
    ok: true,
    value: {
      t: "material",
      id,
      baseColor: baseColor.value,
      roughness: roughness.value,
      metallic: metallic.value,
      emissive: emissive.value,
      emissiveStrength: strength,
      alphaMode: alphaMode as SceneV2MaterialAlphaMode,
      doubleSided: raw.doubleSided === true,
      // 只在显式声明时写入规范 op：旧场景的 Scene IR 与内容身份逐字节不变（D4）。
      ...(raw.unlit === true ? { unlit: true } : {}),
      ...(opacity === undefined ? {} : { opacity }),
      ...(baseColorTexture === undefined ? {} : { baseColorTexture })
    }
  };
}

/** 纹理 id：内容寻址或上传时分配，字母数字与少量分隔符，长度受限。 */
const TEXTURE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function readTextureId(input: unknown): string | null {
  return typeof input === "string" && TEXTURE_ID.test(input) ? input : null;
}

function readRequiredColor(
  raw: unknown,
  fallback: string,
  materialId: string,
  field: string
): ReadResult<string> {
  if (raw === undefined || raw === null) return { ok: true, value: fallback };
  const color = readColor(raw);
  if (!color) return fail("invalid-material", `material ${materialId} 的 ${field} 非法`);
  return { ok: true, value: color };
}

function readUnit(raw: unknown, fallback: number, materialId: string, field: string): ReadResult<number> {
  if (raw === undefined || raw === null) return { ok: true, value: fallback };
  const value = readNumber(raw, null);
  if (value === null || value < 0 || value > 1) {
    return fail("invalid-material", `material ${materialId} 的 ${field} 必须在 0..1`);
  }
  return { ok: true, value };
}

export function readShape(
  raw: Record<string, unknown>,
  index: number,
  t: string,
  shapeIds: Set<string>,
  materialIds: Set<string>,
  parentOf: Map<string, string | null>
): ReadResult<SceneV2ShapeOp> {
  void parentOf;
  const id = readId(raw.id);
  if (!id) return fail("invalid-id", `第 ${index} 个 op 缺少合法 id`);
  if (shapeIds.has(id)) return fail("duplicate-id", `重复的对象 id：${id}`);

  let parent: string | null;
  if (raw.parent === undefined || raw.parent === null) {
    parent = null;
  } else if (typeof raw.parent === "string" && raw.parent !== "") {
    if (!shapeIds.has(raw.parent)) {
      return fail("invalid-parent", `对象 ${id} 的 parent ${raw.parent} 未定义或后置`);
    }
    parent = raw.parent;
  } else {
    return fail("invalid-parent", `对象 ${id} 的 parent 必须是字符串或 null`);
  }

  const position = readVec3(raw.position, [0, 0, 0]);
  if (!position) return fail("invalid-vector", `对象 ${id} 的 position 非法`);
  const rotation = readVec3(raw.rotation, [0, 0, 0]);
  if (!rotation) return fail("invalid-vector", `对象 ${id} 的 rotation 非法`);
  const scale = readVec3(raw.scale, [1, 1, 1]);
  if (!scale) return fail("invalid-vector", `对象 ${id} 的 scale 非法`);

  // material 与 color 互斥（spec「同一 shape 同时提供 material 与 color MUST 被拒绝」）。
  let material: string | null = null;
  let color: string | null = null;
  if (raw.material !== undefined && raw.material !== null) {
    if (typeof raw.material !== "string" || raw.material === "") {
      return fail("missing-material", `对象 ${id} 的 material 必须是 material ID 字符串`);
    }
    if (!materialIds.has(raw.material)) {
      return fail("missing-material", `对象 ${id} 引用了未声明或后置的 material ${raw.material}`);
    }
    material = raw.material;
  }
  if (raw.color !== undefined && raw.color !== null) {
    const parsed = readColor(raw.color);
    if (!parsed) return fail("invalid-color", `对象 ${id} 的 color 非法`);
    color = parsed;
  }
  if (material !== null && color !== null) {
    return fail("invalid-material", `对象 ${id} 不得同时提供 material 与 color`);
  }

  const base = { id, parent, position, rotation, scale, material, color: color ?? (material === null ? "#cccccc" : null) };

  if (t === "group") return { ok: true, value: { t: "group", ...base } };
  if (t === "box") {
    const size = readVec3(raw.size, [1, 1, 1]);
    if (!size || size.some((value) => value <= 0)) return fail("invalid-primitive", `对象 ${id} 的 size 非法`);
    return { ok: true, value: { t: "box", ...base, size } };
  }
  if (t === "cylinder") {
    const radius = readPositive(raw.radius, 1);
    const height = readPositive(raw.height, 1);
    if (radius === null || height === null) return fail("invalid-primitive", `对象 ${id} 的 cylinder 半径/高度非法`);
    return { ok: true, value: { t: "cylinder", ...base, radius, height } };
  }
  if (t === "sphere") {
    const radius = readPositive(raw.radius, null);
    if (radius === null) return fail("invalid-primitive", `对象 ${id} 的 sphere 半径非法`);
    return { ok: true, value: { t: "sphere", ...base, radius } };
  }
  if (t === "capsule") {
    const radius = readPositive(raw.radius, null);
    const height = readPositive(raw.height, null);
    if (radius === null || height === null) return fail("invalid-primitive", `对象 ${id} 的 capsule 尺寸非法`);
    if (height + CAPSULE_EPSILON < radius * 2) {
      return fail("invalid-primitive", `对象 ${id} 的 capsule 总高度不得小于直径`);
    }
    return { ok: true, value: { t: "capsule", ...base, radius, height } };
  }
  if (t === "segment") {
    return readSegment(raw, id, base);
  }
  // mesh
  const vertices = readVertices(raw.vertices);
  if (!vertices) return fail("invalid-mesh", `对象 ${id} 的 vertices 非法`);
  if (vertices.length === 0) return fail("invalid-mesh", `对象 ${id} 的 mesh 需要至少一个顶点`);
  const faces = readFaces(raw.faces, vertices.length);
  if (!faces) return fail("invalid-mesh", `对象 ${id} 的 faces 非法`);
  if (faces.length === 0) return fail("invalid-mesh", `对象 ${id} 的 mesh 需要至少一个面`);
  if (vertices.length > SCENE_IR_V2_MAX_MESH_VERTICES) {
    return fail("mesh-too-large", `mesh ${id} 顶点数 ${vertices.length} 超过上限`);
  }
  if (faces.length > SCENE_IR_V2_MAX_MESH_FACES) {
    return fail("mesh-too-large", `mesh ${id} 面数 ${faces.length} 超过上限`);
  }
  const attributes = readMeshAttributes(raw, id, vertices.length);
  if (!attributes.ok) return attributes;
  return { ok: true, value: { t: "mesh", ...base, vertices, faces, ...attributes.value } };
}

/**
 * 读取可选顶点属性（normals/uvs/colors）。
 *
 * 长度必须与位置数一致；非有限或有损值整条拒绝（不静默丢弃属性导致外观错误）。
 */
function readMeshAttributes(
  raw: Record<string, unknown>,
  id: string,
  vertexCount: number
): ReadResult<{ normals?: Vec3[]; uvs?: [number, number][]; colors?: [number, number, number, number][] }> {
  const result: { normals?: Vec3[]; uvs?: [number, number][]; colors?: [number, number, number, number][] } = {};
  if (raw.normals !== undefined && raw.normals !== null) {
    const normals = readNormals(raw.normals);
    if (!normals || normals.length !== vertexCount) {
      return fail("invalid-mesh", `对象 ${id} 的 normals 数量必须与顶点数一致`);
    }
    result.normals = normals;
  }
  if (raw.uvs !== undefined && raw.uvs !== null) {
    const uvs = readUvs(raw.uvs);
    if (!uvs || uvs.length !== vertexCount) {
      return fail("invalid-mesh", `对象 ${id} 的 uvs 数量必须与顶点数一致`);
    }
    result.uvs = uvs;
  }
  if (raw.colors !== undefined && raw.colors !== null) {
    const colors = readColors(raw.colors);
    if (!colors || colors.length !== vertexCount) {
      return fail("invalid-mesh", `对象 ${id} 的 colors 数量必须与顶点数一致`);
    }
    result.colors = colors;
  }
  return { ok: true, value: result };
}

function readNormals(input: unknown): Vec3[] | null {
  if (!Array.isArray(input)) return null;
  const normals: Vec3[] = [];
  for (const entry of input) {
    const vec = readVec3(entry, null);
    if (!vec || vec.some((value) => value < -1.0001 || value > 1.0001)) return null;
    normals.push(vec);
  }
  return normals;
}

function readUvs(input: unknown): [number, number][] | null {
  if (!Array.isArray(input)) return null;
  const uvs: [number, number][] = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const u = readNumber(entry[0], null);
    const v = readNumber(entry[1], null);
    if (u === null || v === null) return null;
    uvs.push([u, v]);
  }
  return uvs;
}

function readColors(input: unknown): [number, number, number, number][] | null {
  if (!Array.isArray(input)) return null;
  const colors: [number, number, number, number][] = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length < 4) return null;
    const values: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const value = readNumber(entry[index], null);
      if (value === null || value < 0 || value > 1) return null;
      values.push(value);
    }
    colors.push([values[0], values[1], values[2], values[3]]);
  }
  return colors;
}

function readSegment(
  raw: Record<string, unknown>,
  id: string,
  base: Omit<SceneV2ShapeBase, "material" | "color"> & { material: string | null; color: string | null }
): ReadResult<SceneV2SegmentOp> {
  const from = readVec3(raw.from, null);
  const to = readVec3(raw.to, null);
  if (!from || !to) return fail("invalid-primitive", `segment ${id} 的 from/to 非法`);
  if (lengthVec3(subVec3(to, from)) < SCENE_IR_V2_MIN_SEGMENT_LENGTH) {
    return fail("degenerate-segment", `segment ${id} 的 from 与 to 相同或过近`);
  }
  const width = readPositive(raw.width, null);
  if (width === null) return fail("invalid-primitive", `segment ${id} 的 width 非法`);
  const depth = raw.depth === undefined || raw.depth === null ? width : readPositive(raw.depth, null);
  if (depth === null) return fail("invalid-primitive", `segment ${id} 的 depth 非法`);
  const shape = raw.shape ?? "capsule";
  if (typeof shape !== "string" || !SEGMENT_SHAPES.has(shape)) {
    return fail("invalid-primitive", `segment ${id} 的 shape 必须是 box 或 capsule`);
  }
  let overlap = 0;
  if (raw.overlap !== undefined && raw.overlap !== null) {
    const value = readNumber(raw.overlap, null);
    if (value === null || value < 0) return fail("invalid-primitive", `segment ${id} 的 overlap 非法`);
    overlap = value;
  }
  return { ok: true, value: { t: "segment", ...base, from, to, width, depth, shape: shape as "box" | "capsule", overlap } };
}

export function readAnimation(
  raw: Record<string, unknown>,
  index: number,
  shapeIds: Set<string>
): ReadResult<SceneV2AnimationOp> {
  const id = readId(raw.id);
  if (!id) return fail("invalid-id", `第 ${index} 个动画缺少合法目标 id`);
  if (!shapeIds.has(id)) {
    return fail("animation-before-target", `第 ${index} 个动画指向未定义或后置的对象 ${id}`);
  }
  const axis = raw.axis === undefined ? "y" : raw.axis;
  if (typeof axis !== "string" || !AXES.has(axis)) return fail("invalid-number", `动画 ${id} 的 axis 非法`);
  const op: SceneV2AnimationOp = { t: raw.t as SceneV2AnimationOp["t"], id, axis: axis as "x" | "y" | "z" };
  if (raw.mode !== undefined) {
    if (typeof raw.mode !== "string" || !MODES.has(raw.mode)) return fail("invalid-number", `动画 ${id} 的 mode 非法`);
    op.mode = raw.mode as SceneV2AnimationOp["mode"];
  }
  for (const key of ["amplitude", "speed", "phase"] as const) {
    if (raw[key] === undefined) continue;
    const value = readNumber(raw[key], 0);
    if (value === null) return fail("invalid-number", `动画 ${id} 的 ${key} 非法`);
    op[key] = value;
  }
  if (raw.range !== undefined) {
    if (!Array.isArray(raw.range) || raw.range.length !== 2) return fail("invalid-number", `动画 ${id} 的 range 非法`);
    const start = readNumber(raw.range[0], 0);
    const end = readNumber(raw.range[1], 0);
    if (start === null || end === null) return fail("invalid-number", `动画 ${id} 的 range 非法`);
    op.range = [start, end];
  }
  return { ok: true, value: op };
}

export function readId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  return value.length > 0 ? value : null;
}

export function readVec3(input: unknown, fallback: Vec3 | null): Vec3 | null {
  if (input === undefined || input === null) return fallback ? [...fallback] : null;
  if (!Array.isArray(input) || input.length < 3) return null;
  const values: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const value = readNumber(input[i], null);
    if (value === null) return null;
    values.push(value);
  }
  return [values[0], values[1], values[2]];
}

export function readVertices(input: unknown): Vec3[] | null {
  if (!Array.isArray(input)) return null;
  const vertices: Vec3[] = [];
  for (const entry of input) {
    const vec = readVec3(entry, null);
    if (!vec) return null;
    vertices.push(vec);
  }
  return vertices;
}

export function readFaces(input: unknown, vertexCount: number): number[][] | null {
  if (!Array.isArray(input)) return null;
  const faces: number[][] = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length < 3) return null;
    const face: number[] = [];
    for (const rawIndex of entry) {
      if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= vertexCount) {
        return null;
      }
      face.push(rawIndex);
    }
    faces.push(face);
  }
  return faces;
}

export function readNumber(input: unknown, fallback: number | null): number | null {
  if (input === undefined || input === null) return fallback;
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  if (Math.abs(input) > SCENE_IR_V2_COORD_LIMIT) return null;
  return input;
}

export function readPositive(input: unknown, fallback: number | null): number | null {
  const value = readNumber(input, fallback);
  return value === null || value <= 0 ? null : value;
}

export function readColor(input: unknown): string | null {
  if (typeof input !== "string" || !HEX_COLOR.test(input)) return null;
  return normalizeHex(input);
}

/** 颜色大小写与短写统一：`#rgb` → `#rrggbb`、字母小写（design D6 确定性比较）。 */
export function normalizeHex(value: string): string {
  const source = value.replace(/^#/, "").toLowerCase();
  const expanded =
    source.length === 3
      ? source
          .split("")
          .map((char) => char + char)
          .join("")
      : source;
  return `#${expanded}`;
}
