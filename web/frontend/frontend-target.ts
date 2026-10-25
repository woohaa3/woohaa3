import { join } from "node:path";

/** Desktop owns a native Bevy renderer; its distribution has no browser fallback. */
export function frontendTarget(root: string, mode: string): { nativeOnly: boolean; input: Record<string, string> } {
  const nativeOnly = mode === "desktop";
  return {
    nativeOnly,
    input: nativeOnly
      ? { main: join(root, "index.html") }
      : { main: join(root, "index.html"), renderer: join(root, "renderer.html") }
  };
}
