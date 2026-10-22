import { describe, expect, it } from "vitest";
import { canonicalFilmSetFields, createEmptyWoohaa3ServerCanvas, filmSetClipPrecondition, hashModelScript, hashMotionScript, type CanvasCommand, decodeFilmSetNodeData, filmSetAnimationsOf } from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../sync/room.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { readLegacyFilmSetNodeData } from "./legacy-film-set-reader.js";
const now = "2026-10-10T00:00:00.000Z";

/**
 * 旧 flat 片场画布（隔离离线 reader 的输入）。**不**经过生产 room：
 * 生产读取路径不得再认识旧身份（change: 2026-10-11-extract-film-set-extension）。
 * 这里直接构造 Era A（顶层五字段 + 节点级 motion，无独立 clips）的旧格式。
 */
function legacyCanvas() {
  const canvas = createEmptyWoohaa3ServerCanvas("c", now);
  canvas.document.nodes.push({ id: "fs", type: "animation3d", position: { x: 0, y: 0 } });
  canvas.nodeData.fs = {
    extensionId: "film-set",
    title: "旧片场",
    modelScript: "scene.box({id:'actor'});",
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    modelContentVersion: { revision: 1, sourceHash: hashModelScript("scene.box({id:'actor'});"), contentHash: "c1" },
    modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
    motionScript: "",
    motionScriptLanguage: "javascript",
    motionScriptVersion: "woohaa-motion-js-v1",
    motionRevision: 1,
    motionSourceHash: hashMotionScript(""),
    motionBasedOnModelVersion: { revision: 1, contentHash: "c1" },
    initialCamera: { azimuth: 0, elevation: 0.5, distance: 4, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
    timeline: { duration: 5, loop: false }
  } as never;
  return canvas;
}

/** 已在隔离 reader 升级后的 canonical 片场画布，用于 room 内的 durable 命令断言。 */
async function migratedRoom() {
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: "c", repository, now: () => now });
  const canvas = createEmptyWoohaa3ServerCanvas("c", now);
  canvas.document.nodes.push({ id: "fs", type: "composite-asset", position: { x: 0, y: 0 } });
  const read = readLegacyFilmSetNodeData(legacyCanvas().nodeData.fs);
  if (!read.ok) throw Error(read.reason);
  canvas.nodeData.fs = canonicalFilmSetFields(read.value) as never;
  await room.initialize({ canvas, roomEpoch: "e", createdAt: now });
  return { room, repository };
}

function commands(room: CanvasRoom, commandId: string, ops: CanvasCommand[]) {
  const exported = room.exportCanvas(); if (!exported.ok) throw Error(exported.message);
  return room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, commandId, canvasId: "c", actorId: "test", baseRevision: exported.canvas.revision, commands: ops });
}
function snapshot(room: CanvasRoom) { const read = room.exportCanvas(); if (!read.ok) throw Error(read.message); return read.canvas; }
function rename(room: CanvasRoom, name: string): CanvasCommand {
  const decoded = decodeFilmSetNodeData(snapshot(room).nodeData.fs); if (!decoded.ok) throw Error(decoded.reason);
  const op = { kind: "rename" as const, name };
  return { type: "filmSet.clipPatch", nodeId: "fs", clipId: "legacy-default", op, expectedHash: filmSetClipPrecondition(filmSetAnimationsOf(decoded.value), "legacy-default", op) };
}
describe("durable clip commands and explicit migration", () => {
  it("隔离 reader 只读转换旧 flat 片场，产出严格 canonical 内容", () => {
    const canvas = legacyCanvas();
    const before = JSON.stringify(canvas);
    const result = readLegacyFilmSetNodeData(canvas.nodeData.fs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(JSON.stringify(canvas)).toBe(before);
    const fields = canonicalFilmSetFields(result.value);
    expect(fields.extensionId).toBe("film-set");
    expect(fields.timeline).toBeUndefined();
    expect(fields.modelScript).toBeUndefined();
    expect(decodeFilmSetNodeData(fields).ok).toBe(true);
  });

  it("canonical 内容再读不改变身份、items 或 clips，也不写 room", async () => {
    const { room } = await migratedRoom();
    const before = JSON.stringify(snapshot(room));
    const fields = snapshot(room).nodeData.fs;
    const read = readLegacyFilmSetNodeData(fields);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.reason);
    expect(canonicalFilmSetFields(read.value)).toEqual(fields);
    expect(JSON.stringify(snapshot(room))).toBe(before);
    room.dispose();
  });

  it("durable failure preserves old fields, model and published revision", async () => {
    const { room, repository } = await migratedRoom(); const before = JSON.stringify(snapshot(room)); repository.failNextCommit(new Error("write failure"));
    expect((await commands(room, "failed-upgrade", [rename(room, "改名")])).ok).toBe(false);
    expect(JSON.stringify(snapshot(room))).toBe(before); room.dispose();
  });

  it("request retries are idempotent; unrelated fields merge; same-field conflicts reject", async () => {
    const { room } = await migratedRoom(); const first = rename(room, "新名称");
    expect((await commands(room, "rename", [first])).ok).toBe(true);
    expect(await commands(room, "rename", [first])).toMatchObject({ ok: true, status: "duplicate" });
    expect((await commands(room, "stale", [first])).ok).toBe(false);
    const decoded = decodeFilmSetNodeData(snapshot(room).nodeData.fs); if (!decoded.ok) throw Error(decoded.reason);
    const timeline = { kind: "timeline" as const, timeline: { duration: 8, loop: true } };
    const pending = { type: "filmSet.clipPatch" as const, nodeId: "fs", clipId: "legacy-default", op: timeline, expectedHash: filmSetClipPrecondition(filmSetAnimationsOf(decoded.value), "legacy-default", timeline) };
    await commands(room, "rename2", [rename(room, "其他名称")]);
    expect((await commands(room, "timeline", [pending])).ok).toBe(true); room.dispose();
  });
});
