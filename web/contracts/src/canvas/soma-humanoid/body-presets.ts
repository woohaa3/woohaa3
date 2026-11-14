/** Immutable offline-generated bodies. The v1 catalog remains readable for old canvases. */
import { SOMA_BODY_PACKED as SOMA_BODY_PACKED_V1 } from './body-data.js';
import { SOMA_BODY_MANIFEST as SOMA_BODY_MANIFEST_V1 } from './body-manifest.js';
import { SOMA_BODY_PACKED as SOMA_BODY_PACKED_V2 } from './body-data-v2.js';
import { SOMA_BODY_MANIFEST_V2 } from './body-manifest-v2.js';
import type { Vec3 } from '../model-transform.js';

export const SOMA_BODY_CATALOG_VERSION = 'soma-body-v2';
export const SOMA_BODY_LEGACY_CATALOG_VERSION = 'soma-body-v1';
export type SomaBodySex = 'male' | 'female';
/** Kept for reading v1 metadata; the quick picker no longer exposes head ratios. */
export type SomaBodyHeads = 7 | 8 | 9 | 10;
export type SomaBodyAge = 'adult' | 'newborn' | 'child' | 'old';
export type SomaBodyPresetId =
  | `soma-body-v1/${SomaBodySex}-${SomaBodyHeads}-${'slim' | 'fat'}`
  | 'soma-body-v1/baby'
  | `soma-body-v1/${SomaBodySex}-${'child' | 'teen'}`
  | `soma-body-v2/${SomaBodySex}`
  | `soma-body-v2/${SomaBodySex}-${'newborn' | 'child' | 'old'}`;
export type SomaBodySelection = { age?: SomaBodyAge; sex: SomaBodySex };
export const DEFAULT_SOMA_BODY_SELECTION: SomaBodySelection = Object.freeze({ age: 'adult', sex: 'male' });

const freezeEntry = (preset: (typeof SOMA_BODY_MANIFEST_V1.entries | typeof SOMA_BODY_MANIFEST_V2.entries)[number]) => Object.freeze({ ...preset,
  parameters: Object.freeze({ ...preset.parameters }), localChanges: Object.freeze({ ...preset.localChanges }),
  measurements: Object.freeze({ ...preset.measurements }) });
export const SOMA_BODY_PRESETS = Object.freeze([
  ...SOMA_BODY_MANIFEST_V1.entries.map(freezeEntry),
  ...SOMA_BODY_MANIFEST_V2.entries.map(freezeEntry)
]);
export type SomaBodyPreset = (typeof SOMA_BODY_PRESETS)[number];
export type SomaBodyJoint = { name: string; parent: number; position: number[]; rotation: number[]; bind: number[][] };
export type SomaBodyData = {
  joints: SomaBodyJoint[];
  skin: { vertices: Vec3[]; faces: number[][]; indices: number[][]; weights: number[][]; inverseBindMatrices: number[][] };
};

export function resolveSomaBodyPreset(id: unknown): SomaBodyPreset {
  const entry = SOMA_BODY_PRESETS.find(entry => entry.id === id);
  if (!entry) throw new Error(`Unknown SOMA body preset: ${String(id)}`);
  return entry;
}

export function somaBodyPresetId(selection: SomaBodySelection): SomaBodyPresetId {
  const age = selection.age ?? 'adult';
  const key = age === 'adult' ? selection.sex : `${selection.sex}-${age}`;
  const id = `${SOMA_BODY_CATALOG_VERSION}/${key}` as SomaBodyPresetId;
  return resolveSomaBodyPreset(id).id as SomaBodyPresetId;
}

export function somaBodyPresetName(id: unknown): string {
  const p = resolveSomaBodyPreset(id);
  const ageGroup = (p as { ageGroup?: string }).ageGroup;
  if (p.id.startsWith(`${SOMA_BODY_LEGACY_CATALOG_VERSION}/`)) {
    if (p.heads === null) return p.sex === 'neutral' ? '婴儿' : `${p.sex === 'male' ? '男' : '女'}${ageGroup === 'child' ? '童' : '少年'}`;
    return `${p.sex === 'male' ? '男' : '女'} · ${p.heads}头身 · ${p.build === 'slim' ? '瘦' : '胖'}`;
  }
  const sex = p.sex === 'male' ? '男' : '女';
  if (ageGroup === 'newborn') return `${sex}新生儿`;
  if (ageGroup === 'child') return `${sex}童`;
  if (ageGroup === 'old') return `${sex}老人`;
  return `${sex}青年`;
}

function unpack(encoded: string, width: number, integer = false): number[][] {
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  if (bytes.byteLength % (4 * width)) throw new Error('Invalid packed SOMA body array');
  const view = new DataView(bytes.buffer);
  return Object.freeze(Array.from({ length: bytes.byteLength / 4 / width }, (_, row) =>
    Object.freeze(Array.from({ length: width }, (_, col) => integer
      ? view.getUint32((row * width + col) * 4, true)
      : view.getFloat32((row * width + col) * 4, true))) as number[])) as number[][];
}

const packedByVersion = {
  'soma-body-v1': SOMA_BODY_PACKED_V1,
  'soma-body-v2': SOMA_BODY_PACKED_V2
} as const;
function packedFor(id: string) {
  const slash = id.indexOf('/');
  const version = id.slice(0, slash) as keyof typeof packedByVersion;
  const packed = packedByVersion[version];
  if (!packed) throw new Error(`Unknown SOMA body catalog: ${version}`);
  return { packed, key: id.slice(slash + 1) };
}

const jointCache = new Map<string, SomaBodyJoint[]>();
export function somaBodyJoints(id: unknown): SomaBodyJoint[] {
  const entry = resolveSomaBodyPreset(id), old = jointCache.get(entry.id);
  if (old) return old;
  const { packed, key } = packedFor(entry.id);
  const source = packed.bodies[key as keyof typeof packed.bodies];
  if (!source) throw new Error(`Missing SOMA body payload: ${entry.id}`);
  const joints = Object.freeze(source.joints.map(j => Object.freeze({ ...j,
    position: Object.freeze(j.position), rotation: Object.freeze(j.rotation),
    bind: Object.freeze(j.bind.map(row => Object.freeze(row))) }))) as unknown as SomaBodyJoint[];
  jointCache.set(entry.id, joints);
  return joints;
}

const sharedCache = new WeakMap<object, Pick<SomaBodyData['skin'], 'faces' | 'indices' | 'weights'>>();
const cache = new Map<string, SomaBodyData>();
/** Decoded at first use, once per immutable preset. Scene readers copy per-instance mutable arrays. */
export function somaBodyData(id: unknown): SomaBodyData {
  const entry = resolveSomaBodyPreset(id);
  const existing = cache.get(entry.id);
  if (existing) return existing;
  const { packed, key } = packedFor(entry.id);
  const source = packed.bodies[key as keyof typeof packed.bodies];
  if (!source) throw new Error(`Missing SOMA body payload: ${entry.id}`);
  let shared = sharedCache.get(packed as object);
  if (!shared) {
    shared = { faces: unpack(packed.shared.faces, 3, true), indices: unpack(packed.shared.indices, packed.shared.influenceCount, true), weights: unpack(packed.shared.weights, packed.shared.influenceCount) };
    sharedCache.set(packed as object, shared);
  }
  const data = Object.freeze({ joints: somaBodyJoints(entry.id), skin: Object.freeze({ ...shared,
    vertices: unpack(source.vertices, 3) as Vec3[], inverseBindMatrices: unpack(source.inverseBindMatrices, 16) }) });
  cache.set(entry.id, data);
  return data;
}
