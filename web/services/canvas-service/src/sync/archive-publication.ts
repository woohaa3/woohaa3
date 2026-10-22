/** Offline archive publication. Caller must exclude live room writers. */
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import type { ServerCanvas } from "@woohaa3/contracts";
import { serverCanvasToYDoc, YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { YjsLoadedState, YjsCommandRecord } from "./yjs-repository.js";
import type { CanvasArchivePublication } from "../storage/core/archive-service.js";

/** Includes compacted command records; rollback must retain retry semantics. */
export type YjsArchiveSnapshot = {
  state: YjsLoadedState;
  revision: number;
  commands: YjsCommandRecord[];
};
export interface YjsArchiveRepository {
  captureArchiveState(canvasId: string): Promise<YjsArchiveSnapshot | null>;
  replaceArchiveState(canvasId: string, snapshot: YjsArchiveSnapshot | null): Promise<void>;
}

export function createYjsArchivePublication(repository: YjsArchiveRepository): CanvasArchivePublication {
  return {
    async prepare(canvasIds) {
      const backups = new Map<string, YjsArchiveSnapshot | null>();
      for (const id of canvasIds) backups.set(id, await repository.captureArchiveState(id));
      const touched = new Set<string>();
      return {
        async publish(canvas: ServerCanvas) {
          const doc = serverCanvasToYDoc(canvas);
          try {
            touched.add(canvas.id);
            await repository.replaceArchiveState(canvas.id, {
              state: {
                canvasId: canvas.id, formatVersion: YJS_CANVAS_FORMAT_VERSION,
                roomEpoch: randomUUID(), checkpoint: Y.encodeStateAsUpdate(doc), checkpointSeq: 0,
                updates: [], storageSeq: 0, projection: canvas,
                createdAt: canvas.updatedAt, updatedAt: canvas.updatedAt
              }, revision: canvas.revision, commands: []
            });
          } finally { doc.destroy(); }
        },
        async rollback() {
          const errors: unknown[] = [];
          for (const id of touched) {
            try { await repository.replaceArchiveState(id, backups.get(id) ?? null); }
            catch (error) { errors.push(error); }
          }
          if (errors.length) throw new AggregateError(errors, "Yjs archive rollback failed");
        }
      };
    }
  };
}
