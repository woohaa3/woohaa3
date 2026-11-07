/** 键盘操控：Q/E 推拉，W/S 俯仰，A/D 左右。按住持续生效（逐帧累加）。数值对齐 miora。 */
export const KEY_ZOOM_STEP = 1.2;
export const KEY_ROTATE_STEP = 0.012;

export const PANORAMA_KEYS = ["KeyQ", "KeyE", "KeyW", "KeyS", "KeyA", "KeyD"] as const;
export type PanoramaKey = (typeof PANORAMA_KEYS)[number];

export function isPanoramaKey(code: string): code is PanoramaKey {
  return (PANORAMA_KEYS as readonly string[]).includes(code);
}

/** 快捷键面板的版式：三行两列。 */
export const SHORTCUT_ROWS: ReadonlyArray<readonly [{ label: string; key: string }, { label: string; key: string }]> = [
  [{ label: "镜头推进", key: "Q" }, { label: "镜头拉远", key: "E" }],
  [{ label: "镜头上摇", key: "W" }, { label: "镜头左摇", key: "A" }],
  [{ label: "镜头下摇", key: "S" }, { label: "镜头右摇", key: "D" }]
];

/** 一帧里按住的键合成的视场变化与转动量；没有任何效果时返回 null。 */
export function frameDelta(held: ReadonlySet<string>): { dFov: number; dYaw: number; dPitch: number } | null {
  let dFov = 0;
  let dYaw = 0;
  let dPitch = 0;
  if (held.has("KeyQ")) dFov -= KEY_ZOOM_STEP;
  if (held.has("KeyE")) dFov += KEY_ZOOM_STEP;
  if (held.has("KeyA")) dYaw -= KEY_ROTATE_STEP;
  if (held.has("KeyD")) dYaw += KEY_ROTATE_STEP;
  if (held.has("KeyW")) dPitch += KEY_ROTATE_STEP;
  if (held.has("KeyS")) dPitch -= KEY_ROTATE_STEP;
  return dFov || dYaw || dPitch ? { dFov, dYaw, dPitch } : null;
}
