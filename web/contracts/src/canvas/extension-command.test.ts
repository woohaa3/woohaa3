import { describe, expect, it, vi } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { ContentContributionRegistry, type ContentCommandCodec } from "./content-contribution.js";
import { decodeCanvasCommandBatch, isCanvasCommand } from "./commands.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";

function renameCodec(apply: ContentCommandCodec["apply"] = (_value, canvas) => ({ ok: true, canvas: { ...canvas, title: "已改" } })): ContentCommandCodec {
  return {
    kinds: ["rename"],
    decode(command) {
      return command.payload === "ok" ? { ok: true, value: "已改" } : { ok: false, code: "rename-invalid", reason: "rename-invalid" };
    },
    apply,
    satisfied: () => true
  };
}

describe("extension.command", () => {
  it("合法命令写入，未知身份、伪造 kind 与 codec 失败都不留下半批结果", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-27T00:00:00.000Z");
    const registry = new ContentContributionRegistry();
    const apply = vi.fn(renameCodec().apply);
    registry.register({ extensionId: "film-set", commands: { ...renameCodec(), apply } });
    const now = "2026-10-27T00:00:00.000Z";
    const applied = applyCanvasCommands(canvas, [{ type: "extension.command", extensionId: "film-set", kind: "rename", payload: "ok" }], { now, content: registry });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.canvas.title).toBe("已改");
    expect(apply).toHaveBeenCalledOnce();

    const missing = applyCanvasCommands(canvas, [{ type: "extension.command", extensionId: "creature-video-assets", kind: "rename", payload: "ok" }], { now, content: registry });
    expect(missing).toMatchObject({ ok: false, rejection: { code: "content-owner-unavailable", message: "creature-video-assets" } });
    expect(canvas.title).not.toBe("已改");

    const forged = applyCanvasCommands(canvas, [
      { type: "extension.command", extensionId: "film-set", kind: "rename", payload: "ok" },
      { type: "extension.command", extensionId: "film-set", kind: "forge", payload: "ok" }
    ], { now, content: registry });
    expect(forged).toMatchObject({ ok: false, rejection: { code: "content-owner-unavailable" } });

    const rejected = applyCanvasCommands(canvas, [{ type: "extension.command", extensionId: "film-set", kind: "rename", payload: "no" }], { now, content: registry });
    expect(rejected).toMatchObject({ ok: false, rejection: { code: "content-command-rejected", message: "rename-invalid" } });

    const throwing = new ContentContributionRegistry();
    throwing.register({
      extensionId: "film-set",
      commands: { ...renameCodec(), apply: () => { throw new Error("secret command detail"); } }
    });
    const failed = applyCanvasCommands(canvas, [{ type: "extension.command", extensionId: "film-set", kind: "rename", payload: "ok" }], { now, content: throwing });
    expect(failed).toMatchObject({ ok: false, rejection: { code: "content-codec-failed", message: "film-set" } });
    expect(JSON.stringify(failed)).not.toContain("secret");
  });

  it("结构解码要求 payload 存在", () => {
    expect(isCanvasCommand({ type: "extension.command", extensionId: "film-set", kind: "rename", payload: null })).toBe(true);
    expect(isCanvasCommand({ type: "extension.command", extensionId: "film-set", kind: "rename" })).toBe(false);
    const batch = decodeCanvasCommandBatch({
      canvasId: "canvas",
      expectedRevision: 0,
      operationId: "op",
      actorId: "user",
      commands: [{ type: "extension.command", extensionId: "film-set", kind: "rename", payload: { title: "标题" } }]
    });
    expect(batch.ok).toBe(true);
  });
});
it("contains mutations and errors from extension command callbacks", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-30T00:00:00.000Z");
  canvas.document.nodes.push({ id: "n", type: "image", position: { x: 0, y: 0 } });
  canvas.nodeData.n = { nested: { value: "original" } };
  const before = JSON.stringify(canvas);
  const content = new ContentContributionRegistry();
  content.register({ extensionId: "test.mutation", commands: {
    kinds: ["break"], decode: command => ({ ok: true, value: command.payload }), satisfied: () => true,
    apply: (_value, current) => {
      (current.nodeData.n!.nested as { value: string }).value = "mutated";
      throw Error("private callback detail");
    }
  } });
  const result = applyCanvasCommands(canvas, [{ type: "extension.command", extensionId: "test.mutation", kind: "break", payload: null }], { content });
  expect(result).toMatchObject({ ok: false, rejection: { code: "content-codec-failed" } });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(JSON.stringify(canvas)).toBe(before);
});
