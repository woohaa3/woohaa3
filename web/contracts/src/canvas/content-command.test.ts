import { describe, expect, it } from "vitest";
import { applyCanvasCommands } from "./command-reducer.js";
import { isCanvasCommandSatisfied } from "./command-satisfaction.js";
import { ContentContributionRegistry, type ContentCommandCodec } from "./content-contribution.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";

function commands(): ContentCommandCodec {
  return {
    kinds: ["node.rename"],
    decode(command) {
      const payload = command.payload as { title?: unknown };
      if (typeof payload?.title !== "string") return { ok: false, code: "invalid-title", reason: "invalid-title" };
      return { ok: true, value: { nodeId: command.nodeId, title: payload.title } };
    },
    apply(value, canvas) {
      const { nodeId, title } = value as { nodeId?: string; title: string };
      if (!nodeId || !canvas.document.nodes.some((node) => node.id === nodeId)) return { ok: false, code: "node-missing", reason: "node-missing" };
      return { ok: true, canvas: { ...canvas, nodeData: { ...canvas.nodeData, [nodeId]: { ...(canvas.nodeData[nodeId] ?? {}), title } } } as typeof canvas };
    },
    satisfied(value, canvas) {
      const { nodeId, title } = value as { nodeId?: string; title: string };
      return !!nodeId && (canvas.nodeData[nodeId] as { title?: string } | undefined)?.title === title;
    }
  };
}

function registry(codec: ContentCommandCodec = commands()): ContentContributionRegistry {
  const result = new ContentContributionRegistry();
  result.register({ extensionId: "test-command", commands: codec });
  return result;
}

function canvas() {
  const result = createEmptyWoohaa3ServerCanvas("canvas");
  result.document.nodes.push({ id: "node", type: "composite-asset", position: { x: 0, y: 0 } });
  result.nodeData.node = { extensionId: "test-command", title: "old" };
  return result;
}

describe("extension.command", () => {
  it("decodes, applies and reports satisfaction through the owner", () => {
    const applied = applyCanvasCommands(canvas(), [{
      type: "extension.command",
      extensionId: "test-command",
      nodeId: "node",
      kind: "node.rename",
      payload: { title: "new" }
    }], { content: registry() });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.canvas.nodeData.node).toEqual({ extensionId: "test-command", title: "new" });
    expect(isCanvasCommandSatisfied(applied.canvas, {
      type: "extension.command",
      extensionId: "test-command",
      nodeId: "node",
      kind: "node.rename",
      payload: { title: "new" }
    }, registry())).toBe(true);
  });

  it("rejects unknown owner and forged kind before side effects", () => {
    const source = canvas();
    const unknown = applyCanvasCommands(source, [{
      type: "extension.command",
      extensionId: "other",
      nodeId: "node",
      kind: "node.rename",
      payload: { title: "new" }
    }], { content: registry() });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.rejection.code).toBe("content-owner-unavailable");

    const forged = applyCanvasCommands(source, [{
      type: "extension.command",
      extensionId: "test-command",
      nodeId: "node",
      kind: "node.delete",
      payload: {}
    }], { content: registry() });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.rejection.code).toBe("content-owner-unavailable");
    expect(source.nodeData.node).toEqual({ extensionId: "test-command", title: "old" });
  });

  it("rejects an owner decode/apply failure atomically", () => {
    const applied = applyCanvasCommands(canvas(), [{
      type: "extension.command",
      extensionId: "test-command",
      nodeId: "node",
      kind: "node.rename",
      payload: { title: 3 }
    }], { content: registry() });
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.rejection.code).toBe("content-command-rejected");
  });
});

describe("legacy command owner window", () => {
  it("routes a claimed legacy command type to the owner before core handling", () => {
    const registry = new ContentContributionRegistry();
    registry.register({
      extensionId: "test-legacy",
      commands: {
        kinds: ["filmSet.itemPatch"],
        legacyTypes: ["filmSet.itemPatch"],
        decode: (command) => ({ ok: true, value: command.payload }),
        apply: (_value, canvas) => ({ ok: true, canvas: { ...canvas, title: "owner-applied" } }),
        satisfied: (_value, canvas) => canvas.title === "owner-applied"
      }
    });
    const result = applyCanvasCommands(canvas(), [{
      type: "filmSet.itemPatch",
      nodeId: "node",
      itemId: "item",
      op: { kind: "transform", transform: { offset: { x: 0, y: 0, z: 0 }, yaw: 0, scale: 1 } }
    } as never], { content: registry });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.canvas.title).toBe("owner-applied");
  });
});
