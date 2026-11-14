import { SOMA77_JOINTS } from "../soma-humanoid/skeleton.js";
import type { SomaArray } from "./index.js";
const LIMIT = 128 * 1024 * 1024;
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`SOMA: ${message}`);
}
function crc32(raw: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of raw) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Deterministic stored ZIP/NPY encoding, without pickle or runtime-specific dependencies. */
export function encodeSomaNpz(
  arrays: Record<
    string,
    { shape: number[]; values: ArrayLike<number>; boolean?: boolean }
  >,
): Uint8Array {
  const entries = Object.entries(arrays);
  requireValue(entries.length <= 64, "too many output arrays");
  let totalBytes = 22;
  const files = entries.map(([key, a]) => {
    requireValue(/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key), "unsafe array name");
    const count = a.shape.reduce((x, y) => x * y, 1);
    requireValue(
      a.shape.every((n) => Number.isInteger(n) && n > 0) &&
        count === a.values.length &&
        count <= 16_000_000,
      "invalid output dimensions",
    );
    const text = `{'descr': '${a.boolean ? "|b1" : "<f4"}', 'fortran_order': False, 'shape': (${a.shape.join(", ")}${a.shape.length === 1 ? "," : ""}), }`;
    const padding = (64 - ((10 + text.length + 1) % 64)) % 64;
    const header = new TextEncoder().encode(text + " ".repeat(padding) + "\n");
    totalBytes +=
      76 +
      2 * (key.length + 4) +
      10 +
      header.length +
      count * (a.boolean ? 1 : 4);
    requireValue(totalBytes <= LIMIT, "output ZIP too large");
    const raw = new Uint8Array(
      10 + header.length + count * (a.boolean ? 1 : 4),
    );
    requireValue(raw.length <= LIMIT, "output array too large");
    raw.set([147, 78, 85, 77, 80, 89, 1, 0]);
    const view = new DataView(raw.buffer);
    view.setUint16(8, header.length, true);
    raw.set(header, 10);
    for (let i = 0; i < count; i++) {
      requireValue(Number.isFinite(a.values[i]), "nonfinite output");
      if (a.boolean) raw[10 + header.length + i] = a.values[i] ? 1 : 0;
      else view.setFloat32(10 + header.length + 4 * i, a.values[i], true);
    }
    return {
      name: new TextEncoder().encode(key + ".npy"),
      raw,
      crc: crc32(raw),
      offset: 0,
    };
  });
  const size =
    22 + files.reduce((n, f) => n + 76 + 2 * f.name.length + f.raw.length, 0);
  requireValue(size <= LIMIT && files.length <= 64, "output ZIP too large");
  const out = new Uint8Array(size),
    v = new DataView(out.buffer);
  let at = 0;
  for (const f of files) {
    f.offset = at;
    v.setUint32(at, 0x04034b50, true);
    v.setUint16(at + 4, 20, true);
    v.setUint32(at + 14, f.crc, true);
    v.setUint32(at + 18, f.raw.length, true);
    v.setUint32(at + 22, f.raw.length, true);
    v.setUint16(at + 26, f.name.length, true);
    out.set(f.name, at + 30);
    out.set(f.raw, at + 30 + f.name.length);
    at += 30 + f.name.length + f.raw.length;
  }
  const directory = at;
  for (const f of files) {
    v.setUint32(at, 0x02014b50, true);
    v.setUint16(at + 4, 20, true);
    v.setUint16(at + 6, 20, true);
    v.setUint32(at + 16, f.crc, true);
    v.setUint32(at + 20, f.raw.length, true);
    v.setUint32(at + 24, f.raw.length, true);
    v.setUint16(at + 28, f.name.length, true);
    v.setUint32(at + 42, f.offset, true);
    out.set(f.name, at + 46);
    at += 46 + f.name.length;
  }
  v.setUint32(at, 0x06054b50, true);
  v.setUint16(at + 8, files.length, true);
  v.setUint16(at + 10, files.length, true);
  v.setUint32(at + 12, at - directory, true);
  v.setUint32(at + 16, directory, true);
  return out;
}
function quaternion(m: ArrayLike<number>, a: number): number[] {
  const trace = m[a] + m[a + 4] + m[a + 8];
  let q: number[];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [
      (m[a + 7] - m[a + 5]) / s,
      (m[a + 2] - m[a + 6]) / s,
      (m[a + 3] - m[a + 1]) / s,
      s / 4,
    ];
  } else {
    let i = 0;
    if (m[a + 4] > m[a]) i = 1;
    if (m[a + 8] > m[a + i * 3 + i]) i = 2;
    const j = (i + 1) % 3,
      k = (i + 2) % 3,
      s =
        2 *
        Math.sqrt(1 + m[a + i * 3 + i] - m[a + j * 3 + j] - m[a + k * 3 + k]);
    q = [0, 0, 0, 0];
    q[i] = s / 4;
    q[j] = (m[a + j * 3 + i] + m[a + i * 3 + j]) / s;
    q[k] = (m[a + k * 3 + i] + m[a + i * 3 + k]) / s;
    q[3] = (m[a + k * 3 + j] - m[a + j * 3 + k]) / s;
  }
  const n = Math.hypot(...q);
  return q.map((x) => x / n);
}
function interpolate(m: number[], a: number, b: number, t: number): number[] {
  const p = quaternion(m, a),
    q = quaternion(m, b);
  let dot = p.reduce((s, x, i) => s + x * q[i], 0);
  if (dot < 0) {
    for (let i = 0; i < 4; i++) q[i] = -q[i];
    dot = -dot;
  }
  let u = 1 - t,
    w = t;
  if (dot < 0.9995) {
    const angle = Math.acos(Math.min(1, dot)),
      sin = Math.sin(angle);
    u = Math.sin((1 - t) * angle) / sin;
    w = Math.sin(t * angle) / sin;
  }
  const r = p.map((x, i) => u * x + w * q[i]),
    n = Math.hypot(...r);
  const [x, y, z, h] = r.map((x) => x / n);
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * h),
    2 * (x * z + y * h),
    2 * (x * y + z * h),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * h),
    2 * (x * z - y * h),
    2 * (y * z + x * h),
    1 - 2 * (x * x + y * y),
  ];
}
export async function composeWalkingWave(
  walkBytes: Uint8Array,
  waveBytes: Uint8Array,
  fps: number,
  unzip: (
    bytes: Uint8Array,
    wanted: string[],
  ) => Promise<Record<string, SomaArray>>,
  numeric: (a: SomaArray, shape: number[]) => number[],
  rotation: (r: ArrayLike<number>, at: number) => void,
) {
  requireValue(
    Number.isFinite(fps) && fps > 0 && fps <= 240,
    "invalid composition fps",
  );
  const walk = await unzip(walkBytes, ["root_positions", "local_rot_mats"]),
    wave = await unzip(waveBytes, ["posed_joints", "local_rot_mats"]);
  const frames = walk.local_rot_mats.shape[0],
    wf = wave.local_rot_mats.shape[0];
  requireValue(
    Number.isInteger(frames) &&
      frames > 0 &&
      frames <= 6000 &&
      Number.isInteger(wf) &&
      wf > 0 &&
      wf <= 18000,
    "invalid composition frames",
  );
  const roots = numeric(walk.root_positions, [frames, 3]),
    wl = numeric(walk.local_rot_mats, [frames, 77, 3, 3]),
    vl = numeric(wave.local_rot_mats, [wf, 77, 3, 3]),
    vp = numeric(wave.posed_joints, [wf, 77, 3]);
  for (let a = 0; a < wl.length; a += 9) rotation(wl, a);
  for (let a = 0; a < vl.length; a += 9) rotation(vl, a);
  // Translation alone cannot establish a walking source. Require articulation on each leg.
  for (const side of [
    [67, 68],
    [72, 73],
  ]) {
    const articulated = side.some((joint) => {
      const first = quaternion(wl, joint * 9);
      for (let frame = 1; frame < frames; frame++) {
        const current = quaternion(wl, (frame * 77 + joint) * 9);
        const dot = Math.abs(
          first.reduce((sum, value, axis) => sum + value * current[axis], 0),
        );
        if (2 * Math.acos(Math.min(1, dot)) > 0.12) return true;
      }
      return false;
    });
    requireValue(
      articulated,
      "walking source needs articulated motion in both legs",
    );
  }
  let start = 0,
    end = -1,
    run = 0;
  for (let f = 0; f <= wf; f++) {
    const raised =
      f < wf &&
      (vp[(f * 77 + 14) * 3 + 1] > vp[(f * 77 + 12) * 3 + 1] + 0.1 ||
        vp[(f * 77 + 42) * 3 + 1] > vp[(f * 77 + 40) * 3 + 1] + 0.1);
    if (raised) {
      if (f === 0 || run < 0) run = f;
    } else {
      if (run >= 0 && f - run > end - start + 1) {
        start = run;
        end = f - 1;
      }
      run = -1;
    }
  }
  requireValue(
    end - start + 1 >= 8,
    "wave needs at least eight consecutive raised-wrist frames",
  );
  const local = new Float32Array(wl),
    global = new Float32Array(local.length),
    posed = new Float32Array(frames * 77 * 3),
    smooth = new Float32Array(roots.length),
    heading = new Float32Array(frames * 2),
    contacts = new Uint8Array(frames * 6),
    reduced = new Float32Array(frames * 30 * 3);
  const selected = [
      0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 18, 27, 39, 40, 41, 42, 46,
      51, 67, 68, 69, 70, 72, 73, 74, 75,
    ],
    feet = [69, 70, 71, 74, 75, 76],
    period = Math.max(1, Math.min(4, (2 * (end - start)) / fps));
  for (let f = 0; f < frames; f++) {
    const phase = (1 - Math.cos((2 * Math.PI * f) / fps / period)) / 2,
      source = start + phase * (end - start),
      lo = Math.floor(source),
      hi = Math.min(end, lo + 1);
    for (let j = 1; j <= 66; j++)
      local.set(
        interpolate(vl, (lo * 77 + j) * 9, (hi * 77 + j) * 9, source - lo),
        (f * 77 + j) * 9,
      );
    for (let j = 0; j < 77; j++) {
      const parent = SOMA77_JOINTS[j].parent,
        a = (f * 77 + j) * 9,
        p = (f * 77 + parent) * 9,
        pos = (f * 77 + j) * 3,
        pp = (f * 77 + parent) * 3,
        offset = SOMA77_JOINTS[j].position;
      for (let r = 0; r < 3; r++) {
        posed[pos + r] =
          parent < 0
            ? roots[f * 3 + r]
            : posed[pp + r] +
              global[p + r * 3] * offset[0] +
              global[p + r * 3 + 1] * offset[1] +
              global[p + r * 3 + 2] * offset[2];
        for (let c = 0; c < 3; c++)
          global[a + r * 3 + c] =
            parent < 0
              ? local[a + r * 3 + c]
              : global[p + r * 3] * local[a + c] +
                global[p + r * 3 + 1] * local[a + 3 + c] +
                global[p + r * 3 + 2] * local[a + 6 + c];
      }
    }
    for (let k = 0; k < 3; k++) {
      let sum = 0,
        n = 0;
      for (let t = Math.max(0, f - 2); t <= Math.min(frames - 1, f + 2); t++) {
        sum += roots[t * 3 + k];
        n++;
      }
      smooth[f * 3 + k] = sum / n;
    }
    const a = f * 77 * 9,
      n = Math.hypot(global[a], global[a + 6]);
    requireValue(n > 1e-8, "undefined root heading");
    heading[f * 2] = global[a] / n;
    heading[f * 2 + 1] = global[a + 6] / n;
    feet.forEach(
      (j, k) =>
        (contacts[f * 6 + k] = posed[(f * 77 + j) * 3 + 1] < 0.045 ? 1 : 0),
    );
    selected.forEach((j, k) => {
      for (let axis = 0; axis < 3; axis++)
        reduced[(f * 30 + k) * 3 + axis] =
          posed[(f * 77 + j) * 3 + axis] - roots[f * 3 + axis];
    });
  }
  let distance = 0;
  for (let f = 1; f < frames; f++)
    distance += Math.hypot(
      roots[f * 3] - roots[(f - 1) * 3],
      roots[f * 3 + 2] - roots[(f - 1) * 3 + 2],
    );
  const bytes = encodeSomaNpz({
    local_rot_mats: { shape: [frames, 77, 3, 3], values: local },
    global_rot_mats: { shape: [frames, 77, 3, 3], values: global },
    posed_joints: { shape: [frames, 77, 3], values: posed },
    root_positions: { shape: [frames, 3], values: roots },
    smooth_root_pos: { shape: [frames, 3], values: smooth },
    posed_joints_norootpos: { shape: [frames, 30, 3], values: reduced },
    foot_contacts: { shape: [frames, 6], values: contacts, boolean: true },
    global_root_heading: { shape: [frames, 2], values: heading },
  });
  return {
    bytes,
    frameCount: frames,
    fps,
    walkDistance: distance,
    raisedWindow: { start, end },
  };
}
