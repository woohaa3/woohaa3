/** Fixed user-invoked factories; these do not start an assistant turn. */
export type DirectorCharacterKind = "capsule" | "humanoid";
export const DIRECTOR_CHARACTER_SCRIPTS = {
  capsule: `scene.capsule({ id: "body", radius: 0.22, height: 1.3, position: [0, 0.65, 0], color: "#d9dce2" });
scene.sphere({ id: "head", radius: 0.22, position: [0, 1.48, 0], color: "#d9dce2" });
// Eyes face local +Z, matching the humanoid's forward direction.
scene.sphere({ id: "left-eye", radius: 0.04, position: [-0.08, 1.52, 0.2], color: "#000000" });
scene.sphere({ id: "right-eye", radius: 0.04, position: [0.08, 1.52, 0.2], color: "#000000" });`,
  humanoid: 'scene.somaHumanoid({ style: "humanoid" });',
} as const;
