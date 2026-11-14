/** Lightweight catalog metadata used by document validation. Keep packed meshes out of this module. */
import { SOMA_BODY_MANIFEST as SOMA_BODY_MANIFEST_V1 } from './body-manifest.js';
import { SOMA_BODY_MANIFEST_V2 } from './body-manifest-v2.js';

const entries = [...SOMA_BODY_MANIFEST_V1.entries, ...SOMA_BODY_MANIFEST_V2.entries];
export function resolveSomaBodyPreset(id: unknown) {
  const entry = entries.find(candidate => candidate.id === id);
  if (!entry) throw new Error(`Unknown SOMA body preset: ${String(id)}`);
  return entry;
}
