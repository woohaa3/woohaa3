import { composeWalkingWave } from "./compose.js";
/** Bounded, pickle-free SOMA array codec. Matrices use NumPy row-major order. */
const MAX_BYTES = 128 * 1024 * 1024;
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`SOMA: ${message}`);
}
export interface SomaArray {
  shape: number[];
  values: number[] | string[];
}
export function decodeSomaNpy(bytes: Uint8Array): SomaArray {
  check(
    bytes.length >= 10 &&
      bytes.length <= MAX_BYTES &&
      bytes[0] === 147 &&
      new TextDecoder().decode(bytes.subarray(1, 6)) === "NUMPY",
    "invalid NPY",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    major = bytes[6];
  check(major === 1 || major === 2 || major === 3, "unsupported NPY version");
  const start = major === 1 ? 10 : 12;
  check(bytes.length >= start, "truncated header");
  const length =
    major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  check(
    length <= 65536 && start + length <= bytes.length,
    "invalid header size",
  );
  const header = new TextDecoder().decode(
    bytes.subarray(start, start + length),
  );
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  check(
    /'fortran_order'\s*:\s*False/.test(header),
    "Fortran arrays unsupported",
  );
  const dims = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  check(descr && dims !== undefined, "invalid header");
  const shape = dims
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      check(/^\d+$/.test(s), "invalid shape");
      return Number(s);
    });
  const count = shape.reduce((a, b) => a * b, 1);
  check(
    shape.length <= 4 && Number.isSafeInteger(count) && count <= 16_000_000,
    "array too large",
  );
  const match = /^([<>=|])([fiuUb])(\d+)$/.exec(descr);
  check(match, "unsafe or unsupported dtype");
  const [, endian, kind, sizeText] = match,
    size = Number(sizeText),
    width = kind === "U" ? size * 4 : size;
  check(
    (kind === "U" && size <= 256 && size > 0) || (kind === "b" && size === 1) ||
      ((kind === "f" || kind === "i") && (size === 4 || size === 8)),
    "unsupported dtype",
  );
  check(start + length + count * width === bytes.length, "array size mismatch");
  const little = endian !== ">";
  const values: number[] | string[] = kind === "U" ? [] : [];
  for (let i = 0; i < count; i++) {
    const at = start + length + i * width;
    if (kind === "U") {
      let s = "";
      for (let c = 0; c < size; c++) {
        const cp = view.getUint32(at + c * 4, little);
        check(
          cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff),
          "invalid Unicode",
        );
        if (cp) s += String.fromCodePoint(cp);
      }
      (values as string[]).push(s);
    } else {
      const n =
        kind === "b" ? view.getUint8(at) : kind === "f"
          ? size === 4
            ? view.getFloat32(at, little)
            : view.getFloat64(at, little)
          : size === 4
            ? view.getInt32(at, little)
            : Number(view.getBigInt64(at, little));
      check(
        Number.isFinite(n) && (kind === "f" || Number.isSafeInteger(n)),
        "nonfinite or unsafe number",
      );
      (values as number[]).push(n);
    }
  }
  return { shape, values };
}
async function unzip(
  bytes: Uint8Array,
  wanted: string[],
): Promise<Record<string, SomaArray>> {
  check(bytes.length >= 22 && bytes.length <= MAX_BYTES, "invalid ZIP size");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--)
    if (
      v.getUint32(p, true) === 0x06054b50 &&
      p + 22 + v.getUint16(p + 20, true) === bytes.length
    ) {
      end = p;
      break;
    }
  check(end >= 0, "missing ZIP directory");
  check(
    v.getUint16(end + 4, true) === 0 && v.getUint16(end + 6, true) === 0,
    "multi-disk ZIP unsupported",
  );
  const count = v.getUint16(end + 10, true);
  check(
    count <= 64 && count === v.getUint16(end + 8, true),
    "too many ZIP members",
  );
  let at = v.getUint32(end + 16, true),
    total = 0;
  const result: Record<string, SomaArray> = {},
    seen = new Set<string>();
  check(at + v.getUint32(end + 12, true) === end, "invalid ZIP directory");
  for (let i = 0; i < count; i++) {
    check(
      at + 46 <= end && v.getUint32(at, true) === 0x02014b50,
      "invalid ZIP member",
    );
    const crc = v.getUint32(at + 16, true);
    const flags = v.getUint16(at + 8, true),
      method = v.getUint16(at + 10, true),
      compressed = v.getUint32(at + 20, true),
      size = v.getUint32(at + 24, true),
      n = v.getUint16(at + 28, true),
      extra = v.getUint16(at + 30, true),
      comment = v.getUint16(at + 32, true),
      local = v.getUint32(at + 42, true);
    check(at + 46 + n + extra + comment <= end, "invalid member header");
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + n));
    at += 46 + n + extra + comment;
    check(
      !seen.has(name) && /^[a-zA-Z_][a-zA-Z_0-9]*\.npy$/.test(name),
      "unsafe or duplicate member",
    );
    seen.add(name);
    total += size;
    check(
      total <= MAX_BYTES && !(flags & 1) && (method === 0 || method === 8),
      "unsupported ZIP or resource limit",
    );
    if (!wanted.includes(name.slice(0, -4))) continue;
    check(
      local + 30 <= bytes.length && v.getUint32(local, true) === 0x04034b50,
      "invalid local header",
    );
    const offset =
      local +
      30 +
      v.getUint16(local + 26, true) +
      v.getUint16(local + 28, true);
    check(
      offset + compressed <= v.getUint32(end + 16, true),
      "truncated member",
    );
    let raw = bytes.subarray(offset, offset + compressed);
    if (method === 8) {
      const stream = new Blob([raw.slice()])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let actual = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          actual += item.value.length;
          check(actual <= size && actual <= MAX_BYTES, "inflation limit");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
      }
      check(actual === size, "inflated size mismatch");
      raw = new Uint8Array(actual);
      let p = 0;
      for (const c of chunks) {
        raw.set(c, p);
        p += c.length;
      }
    }
    check(raw.length === size, "member size mismatch");
    let actualCrc = 0xffffffff;
    for (const byte of raw) {
      actualCrc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        actualCrc = (actualCrc >>> 1) ^ (actualCrc & 1 ? 0xedb88320 : 0);
    }
    check((actualCrc ^ 0xffffffff) >>> 0 === crc, "CRC mismatch");
    result[name.slice(0, -4)] = decodeSomaNpy(raw);
  }
  check(
    wanted.every((k) => result[k]),
    "missing required array",
  );
  return result;
}
export interface PreparedSomaMotion {
  fps: number;
  frameCount: number;
  durationSeconds: number;
  jointNames: string[];
  faces: Uint32Array;
  bindVertices: Float32Array;
  /** Internal validated row-major buffers; callers must treat prepared data as immutable. */
  globalRotations: Float32Array;
  posedJoints: Float32Array;
  bindTransforms: Float64Array;
  localRotations: Float64Array;
  rootPositions: Float64Array;
  parents: Int32Array;
  order: number[];
  indices: Uint32Array;
  weights: Float32Array;
  restOffsets: Float64Array;
}
function numeric(a: SomaArray, shape: number[]): number[] {
  check(
    a.shape.length === shape.length &&
      shape.every((n, i) => n === a.shape[i]) &&
      a.values.every((v) => typeof v === "number"),
    "array shape/type mismatch",
  );
  return a.values as number[];
}
function rotation(r: ArrayLike<number>, at: number, stride = 3) {
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let dot = 0;
      for (let k = 0; k < 3; k++)
        dot += r[at + i * stride + k] * r[at + j * stride + k];
      check(Math.abs(dot - (i === j ? 1 : 0)) < 0.002, "invalid rotation");
    }
  const a = at,
    s = stride;
  const det =
    r[a] * (r[a + s + 1] * r[a + 2 * s + 2] - r[a + s + 2] * r[a + 2 * s + 1]) -
    r[a + 1] * (r[a + s] * r[a + 2 * s + 2] - r[a + s + 2] * r[a + 2 * s]) +
    r[a + 2] * (r[a + s] * r[a + 2 * s + 1] - r[a + s + 1] * r[a + 2 * s]);
  check(Math.abs(det - 1) < 0.002, "reflected rotation");
}
/** Decode only bounded root travel for authoritative path checks; no skin or client pose is trusted. */
export async function decodeSomaRootPositions(bytes: Uint8Array): Promise<Float64Array> {
  const arrays = await unzip(bytes, ["root_positions"]);
  const roots = arrays.root_positions;
  const frames = roots.shape[0];
  check(Number.isInteger(frames) && frames > 0 && frames <= 18_000, "invalid root frame count");
  return Float64Array.from(numeric(roots, [frames, 3]));
}
/** Decode official 77-joint Y-up positions for trusted gesture prerequisites. */
export async function decodeSomaPosedJoints(bytes: Uint8Array): Promise<Float64Array> {
  const arrays = await unzip(bytes, ["posed_joints"]);
  const posed = arrays.posed_joints;
  const frames = posed.shape[0];
  check(Number.isInteger(frames) && frames > 0 && frames <= 18_000, "invalid posed joint frame count");
  return Float64Array.from(numeric(posed, [frames, 77, 3]));
}
export async function prepareSomaMotion(
  skinBytes: Uint8Array,
  motionBytes: Uint8Array,
  options: { fps?: number } = {},
): Promise<PreparedSomaMotion> {
  const s = await unzip(skinBytes, [
    "bind_vertices",
    "faces",
    "bind_rig_transform",
    "rig_joint_names",
    "lbs_indices",
    "lbs_weights",
    "rig_joint_connections",
  ]);
  const m = await unzip(motionBytes, [
    "local_rot_mats",
    "global_rot_mats",
    "posed_joints",
    "root_positions",
  ]);
  const j = s.rig_joint_names.shape[0],
    v = s.bind_vertices.shape[0],
    f = m.local_rot_mats.shape[0],
    tri = s.faces.shape[0],
    fps = options.fps ?? 30;
  check(
    j > 0 &&
      j <= 256 &&
      v > 0 &&
      v <= 100_000 &&
      f > 0 &&
      f <= 18_000 &&
      tri > 0 &&
      tri <= 200_000 &&
      Number.isFinite(fps) &&
      fps > 0 &&
      fps <= 240,
    "invalid resource dimensions",
  );
  const names = s.rig_joint_names.values;
  check(
    s.rig_joint_names.shape.length === 1 &&
      names.every((n) => typeof n === "string" && n.length > 0) &&
      new Set<string | number>(names).size === j,
    "invalid joint names",
  );
  const bind = numeric(s.bind_rig_transform, [j, 4, 4]),
    verts = numeric(s.bind_vertices, [v, 3]),
    faces = numeric(s.faces, [tri, 3]),
    indices = numeric(s.lbs_indices, [v, 8]),
    weights = numeric(s.lbs_weights, [v, 8]),
    edges = numeric(s.rig_joint_connections, [j - 1, 2]);
  const local = numeric(m.local_rot_mats, [f, j, 3, 3]),
    global = numeric(m.global_rot_mats, [f, j, 3, 3]),
    posed = numeric(m.posed_joints, [f, j, 3]),
    roots = numeric(m.root_positions, [f, 3]);
  const parents = new Int32Array(j).fill(-1);
  for (let i = 0; i < edges.length; i += 2) {
    const p = edges[i],
      c = edges[i + 1];
    check(
      Number.isInteger(p) &&
        Number.isInteger(c) &&
        p >= 0 &&
        p < j &&
        c > 0 &&
        c < j &&
        c !== p &&
        parents[c] === -1,
      "invalid topology",
    );
    parents[c] = p;
  }
  const order = [0];
  for (let i = 0; i < order.length; i++)
    for (let c = 1; c < j; c++) if (parents[c] === order[i]) order.push(c);
  check(order.length === j, "disconnected or cyclic topology");
  const rest = new Float64Array(j * 3);
  for (let n = 0; n < j; n++) {
    rotation(bind, n * 16, 4);
    check(
      Math.abs(bind[n * 16 + 12]) +
        Math.abs(bind[n * 16 + 13]) +
        Math.abs(bind[n * 16 + 14]) +
        Math.abs(bind[n * 16 + 15] - 1) <
        0.001,
      "invalid bind transform",
    );
    if (n) {
      const p = parents[n];
      for (let k = 0; k < 3; k++)
        for (let h = 0; h < 3; h++)
          rest[n * 3 + k] +=
            bind[p * 16 + h * 4 + k] *
            (bind[n * 16 + h * 4 + 3] - bind[p * 16 + h * 4 + 3]);
    }
  }
  check(
    faces.every((n) => Number.isInteger(n) && n >= 0 && n < v) &&
      indices.every((n) => Number.isInteger(n) && n >= 0 && n < j),
    "invalid mesh index",
  );
  for (let n = 0; n < v; n++) {
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      check(
        weights[n * 8 + k] >= 0 && weights[n * 8 + k] <= 1.001,
        "invalid skin weight",
      );
      sum += weights[n * 8 + k];
    }
    check(Math.abs(sum - 1) < 0.002, "unnormalized skin weights");
  }
  for (let t = 0; t < f; t++)
    for (const n of order) {
      const a = (t * j + n) * 9;
      rotation(local, a);
      rotation(global, a);
      for (let row = 0; row < 3; row++) {
        let position = roots[t * 3 + row];
        if (n) {
          position = posed[(t * j + parents[n]) * 3 + row];
          for (let k = 0; k < 3; k++)
            position +=
              global[(t * j + parents[n]) * 9 + row * 3 + k] * rest[n * 3 + k];
        }
        check(
          Math.abs(position - posed[(t * j + n) * 3 + row]) < 0.003,
          "FK/rest mismatch",
        );
        for (let col = 0; col < 3; col++) {
          let expected = local[a + row * 3 + col];
          if (n) {
            expected = 0;
            for (let k = 0; k < 3; k++)
              expected +=
                global[(t * j + parents[n]) * 9 + row * 3 + k] *
                local[a + k * 3 + col];
          }
          check(
            Math.abs(expected - global[a + row * 3 + col]) < 0.002,
            "global/local rotation mismatch",
          );
        }
      }
    }
  return {
    globalRotations: Float32Array.from(global),
    posedJoints: Float32Array.from(posed),
    fps,
    frameCount: f,
    durationSeconds: f / fps,
    jointNames: names as string[],
    faces: Uint32Array.from(faces),
    bindVertices: Float32Array.from(verts),
    bindTransforms: Float64Array.from(bind),
    localRotations: Float64Array.from(local),
    rootPositions: Float64Array.from(roots),
    parents,
    order,
    indices: Uint32Array.from(indices),
    weights: Float32Array.from(weights),
    restOffsets: rest,
  };
}
/** Frame-exact deterministic sampling; time clamps at the last frame unless loop=true. */
export function sampleSomaMotion(
  p: PreparedSomaMotion,
  timeSeconds: number,
  options: { loop?: boolean } = {},
): { positions: Float32Array; jointPositions: Float32Array; frame: number } {
  check(Number.isFinite(timeSeconds), "invalid time");
  const frame = options.loop
    ? ((Math.floor(timeSeconds * p.fps) % p.frameCount) + p.frameCount) %
      p.frameCount
    : Math.min(p.frameCount - 1, Math.max(0, Math.floor(timeSeconds * p.fps)));
  const j = p.jointNames.length,
    rot = new Float64Array(j * 9),
    jointPositions = new Float32Array(j * 3),
    positions = new Float32Array(p.bindVertices.length);
  for (const n of p.order) {
    const a = (frame * j + n) * 9,
      parent = p.parents[n];
    for (let row = 0; row < 3; row++) {
      let pos = p.rootPositions[frame * 3 + row];
      if (parent >= 0) {
        pos = jointPositions[parent * 3 + row];
        for (let k = 0; k < 3; k++)
          pos += rot[parent * 9 + row * 3 + k] * p.restOffsets[n * 3 + k];
      }
      jointPositions[n * 3 + row] = pos;
      for (let col = 0; col < 3; col++) {
        let value = p.localRotations[a + row * 3 + col];
        if (parent >= 0) {
          value = 0;
          for (let k = 0; k < 3; k++)
            value +=
              rot[parent * 9 + row * 3 + k] * p.localRotations[a + k * 3 + col];
        }
        rot[n * 9 + row * 3 + col] = value;
      }
    }
  }
  for (let v = 0; v < positions.length / 3; v++)
    for (let w = 0; w < 8; w++) {
      const weight = p.weights[v * 8 + w];
      if (!weight) continue;
      const n = p.indices[v * 8 + w],
        b = n * 16;
      const local = [0, 0, 0];
      for (let k = 0; k < 3; k++)
        for (let h = 0; h < 3; h++)
          local[k] +=
            p.bindTransforms[b + h * 4 + k] *
            (p.bindVertices[v * 3 + h] - p.bindTransforms[b + h * 4 + 3]);
      for (let row = 0; row < 3; row++) {
        let value = jointPositions[n * 3 + row];
        for (let k = 0; k < 3; k++)
          value += rot[n * 9 + row * 3 + k] * local[k];
        positions[v * 3 + row] += weight * value;
      }
    }
  return { positions, jointPositions, frame };
}

/** Compact transport: each row-major matrix is posed global × inverse bind. */
export interface SomaMotionPayload {
  version: "soma-motion-v1";
  fps: number;
  frameCount: number;
  jointCount: number;
  bindVertices: number[][];
  faces: number[][];
  jointIndices: number[][];
  jointWeights: number[][];
  skinMatrices: number[];
}
export function somaMotionPayload(p: PreparedSomaMotion): SomaMotionPayload {
  const j = p.jointNames.length;
  check(
    p.frameCount <= 600 && p.frameCount * j * 16 <= 2_500_000,
    "motion transport limit",
  );
  const skinMatrices: number[] = [];
  for (let frame = 0; frame < p.frameCount; frame++)
    for (let n = 0; n < j; n++) {
      const b = n * 16,
        r = (frame * j + n) * 9,
        mat = new Array<number>(16).fill(0);
      mat[15] = 1;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++)
          for (let k = 0; k < 3; k++)
            mat[row * 4 + col] +=
              p.globalRotations[r + row * 3 + k] *
              p.bindTransforms[b + col * 4 + k];
        mat[row * 4 + 3] = p.posedJoints[(frame * j + n) * 3 + row];
        for (let k = 0; k < 3; k++)
          mat[row * 4 + 3] -=
            mat[row * 4 + k] * p.bindTransforms[b + k * 4 + 3];
      }
      skinMatrices.push(...mat);
    }
  const rows = (a: ArrayLike<number>, width: number) =>
    Array.from({ length: a.length / width }, (_, i) =>
      Array.from({ length: width }, (_, k) => a[i * width + k]),
    );
  return {
    version: "soma-motion-v1",
    fps: p.fps,
    frameCount: p.frameCount,
    jointCount: j,
    bindVertices: rows(p.bindVertices, 3),
    faces: rows(p.faces, 3),
    jointIndices: rows(p.indices, 8),
    jointWeights: rows(p.weights, 8),
    skinMatrices,
  };
}

/** Trusted SOMA77 composition: walking pelvis/legs with a raised waving upper body. */
export function composeSomaWalkingWave(walkBytes: Uint8Array, waveBytes: Uint8Array, fps: number) {
 return composeWalkingWave(walkBytes, waveBytes, fps, unzip, numeric, rotation);
}
