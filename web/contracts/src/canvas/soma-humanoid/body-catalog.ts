/** Lightweight catalog metadata used by document validation. Keep packed meshes out of this module. */
import { SOMA_BODY_MANIFEST as SOMA_BODY_MANIFEST_V1 } from './body-manifest.js';
import { SOMA_BODY_MANIFEST_V2 } from './body-manifest-v2.js';

/**
 * IDs written by the short-lived v2 baby presets. They remain readable so
 * existing canvases can migrate by loading, while the picker only exposes
 * the canonical Anny age groups.
 */
export const SOMA_BODY_PRESET_ALIASES = Object.freeze({
  'soma-body-v2/male-baby': 'soma-body-v2/male-newborn',
  'soma-body-v2/female-baby': 'soma-body-v2/female-newborn'
} as const);

export function canonicalSomaBodyPresetId(id: unknown): unknown {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SOMA_BODY_PRESET_ALIASES, id)
    ? SOMA_BODY_PRESET_ALIASES[id as keyof typeof SOMA_BODY_PRESET_ALIASES]
    : id;
}

const entries = [...SOMA_BODY_MANIFEST_V1.entries, ...SOMA_BODY_MANIFEST_V2.entries];
export function resolveSomaBodyPreset(id: unknown) {
  const entry = entries.find(candidate => candidate.id === canonicalSomaBodyPresetId(id));
  if (!entry) throw new Error(`Unknown SOMA body preset: ${String(id)}`);
  return entry;
}
