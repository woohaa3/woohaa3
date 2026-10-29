import { migrateLegacyFilmSetToGroup } from "../contracts/src/canvas/film-set-group-migration.js";
import type { ServerCanvas } from "../contracts/src/canvas/domain/index.js";
/** Explicit legacy fixture boundary; production commands never accept the old writes. */
export function migrateFilmSetFixture(canvas: ServerCanvas, nodeId: string): ServerCanvas {
  const migrated = migrateLegacyFilmSetToGroup(canvas, nodeId, { commandId: "test-group-migration", groupId: nodeId });
  if (!migrated.ok) throw new Error(migrated.reason);
  return migrated.canvas;
}

export function migrateFilmSetCanvasFixture(canvas: ServerCanvas): ServerCanvas {
  let current = canvas;
  for (const node of canvas.document.nodes) {
    const data = canvas.nodeData[node.id];
    if (node.type === "composite-asset" && data?.extensionId === "film-set" && data.filmSetObject === undefined) current = migrateFilmSetFixture(current, node.id);
  }
  return current;
}
