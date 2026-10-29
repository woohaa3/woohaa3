import type { FilmSetHostContext as FilmSetContext } from "../../state/browser/host-ports.js";

/**
 * Legacy composite object containers are deliberately no longer installed.
 * Film-set groups render source cards through bindings and persist edits with
 * `filmSetGroup.bindingPatch`; this hook remains as a compatibility seam for
 * callers that still invoke the old installer during migration.
 */
export function installFilmSetObjectContainers(_ctx: FilmSetContext, _feedback = new Map<string, string>()): () => void {
  return () => {};
}
