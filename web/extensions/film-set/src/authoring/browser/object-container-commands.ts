import type { FilmSetHostContext } from "../../state/browser/host-ports.js";

/** Legacy entry point: objects are edited as group bindings, never floated as nodes. */
export async function setFilmSetObjectContainerVisible(_ctx: FilmSetHostContext, _filmSetNodeId: string, _itemId: string, _visible: boolean) {
  return { ok: false as const, reason: "对象容器已移除，请在片场 group 中编辑资源 binding" };
}

/** Kept for callers loaded during the migration window; opening a canvas never writes containers. */
export function installDefaultFilmSetObjectContainers(_ctx: FilmSetHostContext): () => void {
  return () => {};
}
