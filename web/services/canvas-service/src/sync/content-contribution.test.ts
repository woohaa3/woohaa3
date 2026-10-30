import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, createEmptyWoohaa3ServerCanvas, type ContentCommandCodec } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasApplicationService } from "../storage/core/application-service.js";
import { InMemoryCanvasRepository } from "../storage/core/in-memory-repository.js";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { CanvasRoomRegistry } from "./room-registry.js";

const NOW = "2026-10-30T00:00:00.000Z";
const commands = [{ type: "extension.command" as const, extensionId: "test.content", kind: "rename", payload: "renamed" }];
const codec: ContentCommandCodec = {
  kinds: ["rename"],
  decode: command => ({ ok: true, value: command.payload }),
  apply: (value, canvas) => ({ ok: true, canvas: { ...canvas, title: String(value) } }),
  satisfied: (value, canvas) => canvas.title === value
};

describe("trusted content in authoritative command paths", () => {
  it("forwards the live resolver through registry and room, and rejects after release without committing", async () => {
    const content = new ContentContributionRegistry();
    const release = content.register({ extensionId: "test.content", commands: codec });
    const rooms = new CanvasRoomRegistry({ repository: new InMemoryYjsDocumentRepository(), content,
      bootstrap: async id => createEmptyWoohaa3ServerCanvas(id, NOW), now: () => NOW, verifyAssets: false });
    const room = await rooms.resolve("canvas");
    const batch = { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: "canvas", commandId: "first", baseRevision: 0, actorId: "test", commands };
    try {
      expect(await room.submit(batch)).toMatchObject({ ok: true, revision: 1 });
      expect(room.exportCanvas()).toMatchObject({ ok: true, canvas: { title: "renamed" } });
      release();
      expect(await room.submit({ ...batch, commandId: "after-release", baseRevision: 1 })).toMatchObject({ ok: false, code: "content-owner-unavailable" });
      expect(room.exportCanvas()).toMatchObject({ ok: true, canvas: { revision: 1, title: "renamed" } });
    } finally { await rooms.destroyAll(); }
  });

  it("uses the same resolver for the repository CAS path", async () => {
    const content = new ContentContributionRegistry();
    content.register({ extensionId: "test.content", commands: codec });
    const service = new CanvasApplicationService({ repository: new InMemoryCanvasRepository(), content, now: () => NOW });
    await service.createCanvas({ canvasId: "canvas" });
    const result = await service.commitCommands({ canvasId: "canvas", expectedRevision: 1, operationId: "first", actorId: "test", commands });
    expect(result.canvas.title).toBe("renamed");
  });
});
