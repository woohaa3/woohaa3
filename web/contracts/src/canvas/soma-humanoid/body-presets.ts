/** Immutable offline-generated bodies. This catalog is shared by every authoring boundary. */
import { SOMA_BODY_PACKED } from './body-data.js';
import { SOMA_BODY_MANIFEST } from './body-manifest.js';
import type { Vec3 } from '../model-transform.js';

export const SOMA_BODY_CATALOG_VERSION = 'soma-body-v1';
export type SomaBodySex = 'male' | 'female';
export type SomaBodyHeads = 7 | 8 | 9 | 10;
export type SomaBodyBuild = 'slim' | 'fat';
export type SomaBodyAge = 'adult' | 'baby' | 'child' | 'teen';
export type SomaBodyPresetId = `soma-body-v1/${SomaBodySex}-${SomaBodyHeads}-${SomaBodyBuild}` | 'soma-body-v1/baby' | `soma-body-v1/${SomaBodySex}-${'child' | 'teen'}`;
export type SomaBodySelection = { age?: SomaBodyAge; sex: SomaBodySex; heads: SomaBodyHeads; build: SomaBodyBuild };
export const DEFAULT_SOMA_BODY_SELECTION: SomaBodySelection = Object.freeze({ sex: 'male', heads: 8, build: 'slim' });
export const SOMA_BODY_PRESETS = Object.freeze(SOMA_BODY_MANIFEST.entries.map(preset => Object.freeze({ ...preset,
  parameters: Object.freeze({ ...preset.parameters }), localChanges: Object.freeze({ ...preset.localChanges }),
  measurements: Object.freeze({ ...preset.measurements }) })));
export type SomaBodyJoint = { name: string; parent: number; position: number[]; rotation: number[]; bind: number[][] };
export type SomaBodyData = {
  joints: SomaBodyJoint[];
  skin: { vertices: Vec3[]; faces: number[][]; indices: number[][]; weights: number[][]; inverseBindMatrices: number[][] };
};

export function resolveSomaBodyPreset(id: unknown) {
  const entry = SOMA_BODY_PRESETS.find(entry => entry.id === id);
  if (!entry) throw new Error(`Unknown SOMA body preset: ${String(id)}`);
  return entry;
}
export function somaBodyPresetId(selection: SomaBodySelection): SomaBodyPresetId {
  const key = selection.age === 'baby' ? 'baby' : selection.age && selection.age !== 'adult'
    ? `${selection.sex}-${selection.age}` : `${selection.sex}-${selection.heads}-${selection.build}`;
  const id = `${SOMA_BODY_CATALOG_VERSION}/${key}`;
  return resolveSomaBodyPreset(id).id;
}
export function somaBodyPresetName(id: unknown): string {
  const p = resolveSomaBodyPreset(id);
  if (p.heads === null) return p.sex === 'neutral' ? '婴儿' : `${p.sex === 'male' ? '男' : '女'}${p.ageGroup === 'child' ? '童' : '少年'}`;
  return `${p.sex === 'male' ? '男' : '女'} · ${p.heads}头身 · ${p.build === 'slim' ? '瘦' : '胖'}`;
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
const jointCache = new Map<string, SomaBodyJoint[]>();
export function somaBodyJoints(id: unknown): SomaBodyJoint[] {
  const entry = resolveSomaBodyPreset(id), old = jointCache.get(entry.id);
  if (old) return old;
  const source = SOMA_BODY_PACKED.bodies[entry.id.slice(SOMA_BODY_CATALOG_VERSION.length + 1) as keyof typeof SOMA_BODY_PACKED.bodies];
  const joints = Object.freeze(source.joints.map(j => Object.freeze({ ...j,
    position: Object.freeze(j.position), rotation: Object.freeze(j.rotation),
    bind: Object.freeze(j.bind.map(row => Object.freeze(row))) }))) as unknown as SomaBodyJoint[];
  jointCache.set(entry.id, joints);
  return joints;
}
let shared: Pick<SomaBodyData['skin'], 'faces' | 'indices' | 'weights'> | undefined;
const cache = new Map<string, SomaBodyData>();
/** Decoded at first use, once per immutable preset. Scene readers copy per-instance mutable arrays. */
export function somaBodyData(id: unknown): SomaBodyData {
  const entry = resolveSomaBodyPreset(id);
  const existing = cache.get(entry.id);
  if (existing) return existing;
  const source = SOMA_BODY_PACKED.bodies[entry.id.slice(SOMA_BODY_CATALOG_VERSION.length + 1) as keyof typeof SOMA_BODY_PACKED.bodies];
  const s = SOMA_BODY_PACKED.shared;
  shared ??= { faces: unpack(s.faces, 3, true), indices: unpack(s.indices, s.influenceCount, true), weights: unpack(s.weights, s.influenceCount) };
  const data = Object.freeze({ joints: somaBodyJoints(entry.id), skin: Object.freeze({ ...shared,
    vertices: unpack(source.vertices, 3) as Vec3[], inverseBindMatrices: unpack(source.inverseBindMatrices, 16) }) });
  cache.set(entry.id, data);
  return data;
}
