import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ContentContribution } from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "./composite-assets.js";
import { WorkingProjectionStore } from "../cordis/services/canvas-state/store/working-projection.js";
const contribution: ContentContribution = { extensionId: "test.owner", commands: {
  kinds: ["rename"], decode: command => ({ ok: true, value: command.payload }),
  satisfied: (value, canvas) => canvas.title === value, apply: (value, canvas) => ({ ok: true, canvas: { ...canvas, title: String(value) } })
} };
const adapter = { extensionId: "test.owner", owner: "test.owner", executionKey: () => "key", prepare: () => null, content: contribution };
describe("scope owned content contributions", () => {
  it("observes late registration, replay and release through the same live resolver", () => {
    const registry = new CompositeAssetRegistry();
    const store = new WorkingProjectionStore(undefined, registry.getContent);
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    store.applyCanonical(canvas);
    expect(registry.getContent()).toBeUndefined();
    const release = registry.register(adapter);
    const commands = [{ type: "extension.command" as const, extensionId: "test.owner", kind: "rename", payload: "new title" }];
    expect(store.appendBatch({ commandId: "first", commands, baseRevision: 1, submittedAt: canvas.updatedAt })).toMatchObject({ ok: true });
    expect(store.workingCanvas?.title).toBe("new title");
    store.applyCanonical(canvas);
    expect(store.workingCanvas?.title).toBe("new title");
    store.applyCanonical({ ...canvas, title: "new title", revision: canvas.revision + 1 });
    expect(store.pendingBatches).toHaveLength(0);
    release();
    expect(registry.getContent()?.resolve("test.owner")).toBeNull();
    expect(store.appendBatch({ commandId: "second", commands, baseRevision: 1, submittedAt: canvas.updatedAt })).toMatchObject({ ok: false, code: "content-owner-unavailable" });
  });
  it("rejects forged ownership and clears without stale disposers", () => {
    const registry = new CompositeAssetRegistry();
    expect(() => registry.register({ ...adapter, content: { extensionId: "test.forged" } })).toThrow();
    const release = registry.register(adapter);
    registry.clear();
    expect(registry.getContent()?.resolve("test.owner")).toBeNull();
    const replacement = contribution;
    registry.register(adapter);
    release();
    expect(registry.getContent()?.resolve("test.owner")).toBe(replacement);
  });
  it("rolls back content when lifecycle registration fails", () => {
    const registry = new CompositeAssetRegistry();
    const managedLifecycle = { extensionId: "test.owner", schemaVersion: 1 as const, plan: () => ({ nodes: [] }) };
    const releaseConflict = registry.managedLifecycles.register(managedLifecycle);
    expect(() => registry.register({ ...adapter, managedLifecycle })).toThrow();
    expect(registry.getContent()).toBeUndefined();
    releaseConflict();
    registry.register({ ...adapter, managedLifecycle });
    expect(registry.getContent()?.resolve("test.owner")).toBe(contribution);
  });

  it("rebases pending effects immediately on release and retries them on registration", () => {
    const registry = new CompositeAssetRegistry();
    const store = new WorkingProjectionStore(undefined, registry.getContent);
    const stop = registry.subscribeContent(() => store.refreshContent());
    const canvas = createEmptyWoohaa3ServerCanvas("c");
    store.applyCanonical(canvas);
    const release = registry.register(adapter);
    const commands = [{ type: "extension.command" as const, extensionId: "test.owner", kind: "rename", payload: "pending" }];
    store.appendBatch({ commandId: "first", commands, baseRevision: 1, submittedAt: canvas.updatedAt });
    expect(store.workingCanvas?.title).toBe("pending");
    release();
    expect(store.workingCanvas?.title).toBe(canvas.title);
    expect(store.pendingBatches[0]?.state).toBe("blocked");
    registry.register(adapter);
    expect(store.workingCanvas?.title).toBe("pending");
    expect(store.pendingBatches[0]?.state).toBe("pending");
    registry.clear();
    expect(store.workingCanvas?.title).toBe(canvas.title);
    expect(store.pendingBatches[0]?.state).toBe("blocked");
    stop();
  });

  it("notifies content changes without subscribing to preview invalidation", () => {
    const registry = new CompositeAssetRegistry();
    let notifications = 0;
    const stop = registry.subscribeContent(() => notifications++);
    registry.invalidate();
    registry.setProjection("owner", null);
    expect(notifications).toBe(0);
    const release = registry.register(adapter);
    expect(notifications).toBe(1);
    registry.invalidate();
    expect(notifications).toBe(1);
    release();
    expect(notifications).toBe(2);
    registry.register(adapter);
    registry.clear();
    expect(notifications).toBe(4);
    const before = notifications;
    stop();
    registry.register(adapter);
    expect(notifications).toBe(before);
  });

});
