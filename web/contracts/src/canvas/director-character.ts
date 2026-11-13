/** Fixed user-invoked factories; these do not start an assistant turn. */
export type DirectorCharacterKind = "capsule" | "humanoid";
export type DirectorCapsulePreset = "two-heads";
export const DIRECTOR_CHARACTER_SCRIPTS = {
  capsule: `scene.capsule({ id: "body", radius: 0.22, height: 1.3, position: [0, 0.65, 0], color: "#d9dce2" });
scene.sphere({ id: "head", radius: 0.22, position: [0, 1.48, 0], color: "#d9dce2" });
// Eyes face local +Z, matching the humanoid's forward direction.
scene.sphere({ id: "left-eye", radius: 0.04, position: [-0.08, 1.52, 0.2], color: "#000000" });
scene.sphere({ id: "right-eye", radius: 0.04, position: [0.08, 1.52, 0.2], color: "#000000" });`,
  humanoid: 'scene.somaHumanoid({ style: "humanoid" });',
} as const;

import { resolveSomaBodyPreset, type SomaBodyPresetId } from './soma-humanoid/body-presets.js';
export const DIRECTOR_TWO_HEADS_CAPSULE_SCRIPT = `scene.capsule({ id: "body", radius: 0.22, height: 0.44, position: [0, 0.22, 0], color: "#d9dce2" });
scene.sphere({ id: "head", radius: 0.22, position: [0, 0.66, 0], color: "#d9dce2" });
// Eyes face local +Z.
scene.sphere({ id: "left-eye", radius: 0.04, position: [-0.08, 0.70, 0.2], color: "#000000" });
scene.sphere({ id: "right-eye", radius: 0.04, position: [0.08, 0.70, 0.2], color: "#000000" });`;
/** Missing preset deliberately retains the historical factory, never the picker default. */
export function directorCharacterScript(kind: DirectorCharacterKind, bodyPreset?: SomaBodyPresetId, capsulePreset?: DirectorCapsulePreset): string {
  if (kind !== 'capsule' && kind !== 'humanoid') throw new Error('Unknown director character kind');
  if (capsulePreset !== undefined) {
    if (kind !== 'capsule' || bodyPreset !== undefined || capsulePreset !== 'two-heads') throw new Error('Invalid capsule preset');
    return DIRECTOR_TWO_HEADS_CAPSULE_SCRIPT;
  }
  if (bodyPreset === undefined) return DIRECTOR_CHARACTER_SCRIPTS[kind];
  if (kind !== 'humanoid') throw new Error('Body preset requires humanoid character');
  const preset = resolveSomaBodyPreset(bodyPreset);
  return `scene.somaHumanoid({ style: "humanoid", bodyPreset: ${JSON.stringify(preset.id)} });`;
}
