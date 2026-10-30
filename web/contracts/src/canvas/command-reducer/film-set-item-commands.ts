/**
 * Legacy composite object command boundary.
 *
 * Composite film-set snapshots remain decodable for migration and history
 * reads, but they are no longer an authoring target. All new object edits use
 * `filmSetGroup.bindingPatch` against the canonical group marker.
 */
import type { CanvasCommand } from "../commands.js";
import { reject, type CommandApplyResult, type WorkingState } from "./types.js";

export function patchFilmSetItem(
  _work: WorkingState,
  _command: Extract<CanvasCommand, { type: "filmSet.itemPatch" }>
): CommandApplyResult {
  return reject("invalid-self-contained-node", "旧 composite 片场仅支持只读兼容，请迁移为 film-set group");
}
