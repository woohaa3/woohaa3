/** Fixed user-invoked factories; these do not start an assistant turn. */
export type DirectorCharacterKind = "capsule" | "humanoid";
export const DIRECTOR_CHARACTER_SCRIPTS = {
  capsule: 'scene.capsule({ radius: 0.22, height: 1.7, position: [0, 0.85, 0], color: "#d9dce2" });',
  humanoid: 'scene.somaHumanoid({ style: "humanoid" });',
} as const;
