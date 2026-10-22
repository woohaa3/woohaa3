import * as Y from "yjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { serverCanvasToYDoc, YJS_CANVAS_FORMAT_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasArchiveService, InMemoryCanvasRepository } from "../storage/core/index.js";
import { SqliteCanvasRepository, SqliteYjsRepository } from "../storage/sqlite/index.js";
import { MongoYjsRepository } from "../storage/mongo/yjs.js";
import { fakeMongoDeps } from "../storage/mongo/test-support/fake-mongo.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { createYjsArchivePublication } from "./archive-publication.js";
import { createPublishedReader } from "./published-reader.js";
import { recoverYjsDocument } from "./recovery.js";
import type { YjsDocumentRepository } from "./yjs-repository.js";

const NOW = "2026-10-11T00:00:00.000Z";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function canvas(id: string, title: string) {
  const state = createEmptyWoohaa3ServerCanvas(id, NOW);
  state.title = title;
  state.document.nodes.push({ id: title, type: "text", position: { x: 12, y: 34 } });
  return state;
}
const factories = {
  memory: () => ({ legacy: new InMemoryCanvasRepository(), yjs: new InMemoryYjsDocumentRepository() }),
  sqlite: () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa-archive-publication-"));
    const file = path.join(dir, "canvas.sqlite");
    const legacy = new SqliteCanvasRepository({ path: file });
    const yjs = new SqliteYjsRepository({ path: file });
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => legacy.close(), () => yjs.close());
    return { legacy, yjs };
  },
  mongo: () => ({ legacy: new InMemoryCanvasRepository(), yjs: new MongoYjsRepository({ ...fakeMongoDeps(), database: "archive-test" }) })
};
async function seed(yjs: YjsDocumentRepository, id: string) {
  const state = canvas(id, "authoritative-old");
  const doc = serverCanvasToYDoc(state);
  const checkpoint = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  await yjs.createYjsDocument({ canvasId: id, formatVersion: YJS_CANVAS_FORMAT_VERSION,
    roomEpoch: "original-epoch", checkpoint, projection: state, revision: state.revision, createdAt: NOW });
  // A compacted command and an un-compacted no-op both retain retry identities.
  for (let i = 0; i < 2; i++) {
    await yjs.commitYjsCommand({ canvasId: id, expectedStorageSeq: i, update: new Uint8Array([0, 0]),
      revision: state.revision, updatedAt: NOW, projection: state,
      command: { commandId: `retry-${i}`, payloadHash: `hash-${i}`, revision: state.revision,
        changed: false, actorId: "agent", createdAt: NOW } });
  }
  await yjs.replaceCheckpoint({ canvasId: id, cutoffSeq: 1, checkpoint, updatedAt: NOW });
}
for (const [name, factory] of Object.entries(factories)) describe(`${name} authoritative archive import`, () => {
  it("replace updates published reads and recovered rooms, resets epoch/retry records", async () => {
    const { legacy, yjs } = factory();
    await legacy.createCanvas(canvas("target", "stale-legacy"));
    await seed(yjs, "target");
    const source = new InMemoryCanvasRepository();
    await source.createCanvas(canvas("target", "restored"));
    const archive = await new CanvasArchiveService({ repository: source }).exportArchive();
    const service = new CanvasArchiveService({ repository: legacy,
      publication: createYjsArchivePublication(yjs), publishedReader: createPublishedReader(yjs) });
    await expect(service.importArchive(archive)).rejects.toThrow();
    const before = await yjs.captureArchiveState("target");
    await service.importArchive(archive, { replace: true, dryRun: true });
    expect(await yjs.captureArchiveState("target")).toEqual(before);
    await service.importArchive(archive, { replace: true });
    expect((await createPublishedReader(yjs).loadPublished("target"))?.title).toBe("restored");
    const recovered = await recoverYjsDocument({ repository: yjs, canvasId: "target" });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) { expect(recovered.canvas.document.nodes[0].id).toBe("restored"); recovered.doc.destroy(); }
    expect((await yjs.loadYjsState("target"))?.roomEpoch).not.toBe("original-epoch");
    expect(await yjs.getCommandRecord("target", "retry-0")).toBeNull();
  });

  it("rejects overwriting an orphan authoritative document without replace", async () => {
    const { legacy, yjs } = factory();
    await seed(yjs, "orphan");
    const source = new InMemoryCanvasRepository();
    await source.createCanvas(canvas("orphan", "restored"));
    const archive = await new CanvasArchiveService({ repository: source }).exportArchive();
    const service = new CanvasArchiveService({ repository: legacy,
      publication: createYjsArchivePublication(yjs), publishedReader: createPublishedReader(yjs) });
    await expect(service.importArchive(archive)).rejects.toThrow(/已存在/);
    expect(await legacy.getCanvas("orphan")).toBeNull();
    await service.importArchive(archive, { replace: true });
    expect((await createPublishedReader(yjs).loadPublished("orphan"))?.title).toBe("restored");
  });

  it("second publish failure rolls back both stores, compacted commands and new targets", async () => {
    const { legacy, yjs } = factory();
    await legacy.createCanvas(canvas("existing", "stale-legacy"));
    await seed(yjs, "existing");
    const originalLegacy = await legacy.getCanvas("existing");
    const originalYjs = await yjs.captureArchiveState("existing");
    const source = new InMemoryCanvasRepository();
    await source.createCanvas(canvas("existing", "replacement"));
    await source.createCanvas(canvas("new", "new"));
    const archive = await new CanvasArchiveService({ repository: source }).exportArchive(["existing", "new"]);
    const publication = createYjsArchivePublication(yjs);
    const service = new CanvasArchiveService({ repository: legacy, publication: {
      async prepare(ids) {
        const transaction = await publication.prepare(ids);
        return { rollback: transaction.rollback, async publish(state) {
          await transaction.publish(state);
          if (state.id === "new") throw new Error("connection lost after publication");
        } };
      }
    } });
    await expect(service.importArchive(archive, { replace: true })).rejects.toThrow();
    expect(await legacy.getCanvas("existing")).toEqual(originalLegacy);
    expect(await yjs.captureArchiveState("existing")).toEqual(originalYjs);
    expect(await legacy.getCanvas("new")).toBeNull();
    expect(await yjs.loadYjsState("new")).toBeNull();
    expect(await yjs.getCommandRecord("existing", "retry-0")).not.toBeNull();
    const recovered = await recoverYjsDocument({ repository: yjs, canvasId: "existing" });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) { expect(recovered.canvas.title).toBe("authoritative-old"); recovered.doc.destroy(); }
  });
});

for (const backend of ["sqlite", "mongo"] as const) it(`${backend} failed atomic replacement preserves previous Yjs state`, async () => {
  let fail = false;
  let yjs: SqliteYjsRepository | MongoYjsRepository;
  if (backend === "sqlite") {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa-archive-atomic-"));
    yjs = new SqliteYjsRepository({ path: path.join(dir, "canvas.sqlite"), failWrites: () => fail });
    const repository = yjs;
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => repository.close());
  } else yjs = new MongoYjsRepository({ ...fakeMongoDeps(), database: "atomic", failWrites: () => fail });
  await seed(yjs, "target");
  const before = await yjs.captureArchiveState("target");
  fail = true;
  await expect(yjs.replaceArchiveState("target", before)).rejects.toThrow();
  expect(await yjs.captureArchiveState("target")).toEqual(before);
});
