import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  decodeSceneAreaData,
  type WorldAnimationScript,
  type WorldToolContext
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../sync/room.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { createAssistantWorldService } from "./assistant-service.js";

const NOW = "2026-11-04T00:00:00.000Z";
const bounds = { min: { u: -3, v: -3 }, max: { u: 3, v: 3 } };
const scope = { scope: { kind: "scene-area" as const, areaId: "area-1" }, scopeVersion: "scope-1" };
const query = { canvasId: "canvas-1", contextId: "context-1" };
const original: WorldAnimationScript = {
  script: [
    'motion.instance.tween("actor", { property: "position", startTime: 0, endTime: 5, from: [-1.5, 0, 0], to: [1.5, 0, 0], easing: "easeOut" });',
    'motion.instance.tween("actor", { property: "rotation", startTime: 0, endTime: 5, from: [0, 0, 0], to: [0, 0, 90], easing: "easeInOut" });',
    'motion.instance.tween("prop", { property: "scale", startTime: 0, endTime: 5, from: [1], to: [2], easing: "linear" });'
  ].join("\n"),
  scriptLanguage: "javascript",
  scriptVersion: "woohaa-world-animation-js-v1",
  revision: 1,
  sourceHash: "hash-original",
  duration: 5,
  loop: true
};

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

async function fixture(options: { animationScript?: WorldAnimationScript | null; group?: boolean; readOnlyProp?: boolean } = {}) {
  const animationScript = options.animationScript === undefined ? structuredClone(original) : options.animationScript;
  const canvas = createEmptyWoohaa3ServerCanvas(query.canvasId, NOW);
  canvas.document.nodes = [
    { id: "area-node", type: "scene-area", position: { x: 0, y: 0 } },
    ...["actor", "prop"].map(id => ({ id, type: "model3d", position: { x: 0, y: 0 } }))
  ];
  canvas.nodeData["area-node"] = { sceneArea: {
    kind: "scene-area", version: "shared-world-v1", areaId: "area-1", scopeVersion: "scope-1", bounds,
    ...(animationScript ? { animationScript } : {})
  } };
  for (const id of ["actor", "prop"]) canvas.nodeData[id] = {
    modelScript: "scene.box({});", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2",
    sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: id,
      transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } }
  };
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: canvas.id, repository, now: () => NOW });
  await room.initialize({ canvas, roomEpoch: "epoch-1", createdAt: NOW });
  closers.push(() => room.dispose());
  const selectedScope = options.group
    ? { scope: { kind: "workflow-group-2d" as const, groupId: "group-1" }, scopeVersion: "group-scope-1" }
    : scope;
  const targets = ["actor", "prop"].map(instanceId => ({ kind: "instance" as const, instanceId, version: `version-${instanceId}` }));
  const writable = options.group ? [] : targets.filter(target => !options.readOnlyProp || target.instanceId !== "prop");
  const context: WorldToolContext = {
    contextId: query.contextId, canvasId: canvas.id, runId: "run-1", epoch: 0, scope: selectedScope,
    writableTargets: writable.map(target => ({ target, lease: {
      canvasId: canvas.id, runId: "run-1", epoch: 0, target: { kind: "instance", instanceId: target.instanceId }
    } })),
    readOnlyReferences: options.group ? targets : options.readOnlyProp ? [targets[1]!] : []
  };
  let revoked = false;
  const service = createAssistantWorldService({
    authority: {
      async prepareCanvas() { return { ok: true, snapshot: {} } as never; },
      async prepareContent() { return null; },
      // Deliberately stale: reading animation must use the current published room.
      cacheFor() {
        return {
          kind: "scene-area",
          area: canvas.nodeData["area-node"]!.sceneArea,
          instances: new Map(targets.map((target) => [target.instanceId, {
            identity: { kind: "instance", instanceId: target.instanceId },
            nodeId: `node-${target.instanceId}`,
            version: target.version,
            data: { transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } },
            localAabb: { min: [0, 0, 0], max: [1, 1, 1] }
          }])) as never
        } as never;
      }
    },
    worldAuthoring: {
      async issueContext() { return { ok: true, context, run: {
        canvasId: canvas.id, requestId: "request-1", runId: "run-1", epoch: 0, executionId: "execution-1", state: "active"
      }, retry: false }; },
      async revokeContext() { revoked = true; },
      resolveCapability() { return revoked
        ? { ok: false, code: "stale-epoch", message: "revoked" }
        : { context, capability: {} }; },
      refreshContextVersions() {}
    },
    cameraSettings: { async save() { throw new Error("not used"); }, async complete() { throw new Error("not used"); } },
    async resolveRoom() { return room; },
    async cancel() {}, async confirmStopped() {}, async pending() { return []; }
  });
  closers.push(() => service.close());
  await service.issue({ canvasId: canvas.id, requestId: "request-1", runId: "run-1", epoch: 0,
    executionId: "execution-1", scope: selectedScope.scope });
  const patchArea = async (changes: Record<string, string>) => {
    const snapshot = room.exportCanvas();
    if (!snapshot.ok) throw new Error(snapshot.message);
    return room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: canvas.id,
      commandId: `change-area-${room.currentRevision}`, baseRevision: room.currentRevision, actorId: "test",
      commands: [{ type: "nodeData.patch", nodeId: "area-node", value: {
        sceneArea: { ...snapshot.canvas.nodeData["area-node"]!.sceneArea as object, ...changes }
      } }] });
  };
  return { service, room, repository, patchArea, revoke: () => { revoked = true; } };
}

describe("current director animation in assistant context", () => {
  it("reads the animation script, revises it, and reads the committed script with the same context", async () => {
    const { service, room, repository } = await fixture();
    const first = await service.read(query);
    expect(first).toMatchObject({ ok: true, view: { bounds, sceneArea: { nodeId: "area-node", revision: 0, animationScript: original } } });
    expect(first.ok && first.view.sceneModels?.map((model) => model.instanceId).sort()).toEqual(["actor", "prop"]);
    expect(first.ok && first.view.sceneModels?.[0]?.localBounds).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    if (!first.ok || !first.view.sceneArea?.animationScript) throw new Error("Expected the current animation script");
    const revisedScript = first.view.sceneArea.animationScript.script.replace("to: [1.5, 0, 0]", "to: [1.5, 1, 0]");
    const write = await service.write({ contextId: query.contextId,
      operation: { kind: "set-scene-animation-script", operationId: "animation-revision", script: revisedScript, duration: original.duration, loop: original.loop } });
    expect(write).toMatchObject({ ok: true, revision: 1, noop: false });
    const second = await service.read(query);
    if (!second.ok || !second.view.sceneArea?.animationScript) throw new Error("Expected the revised animation script");
    expect(second.view.sceneArea.animationScript.script).toBe(revisedScript);
    expect(second.view.sceneArea.animationScript.revision).toBe(2);
    expect(first.view.sceneArea.animationScript.script).toBe(original.script);
    expect(room.currentRevision).toBe(1);
    const reopened = new CanvasRoom({ canvasId: query.canvasId, repository, now: () => NOW });
    closers.push(() => reopened.dispose());
    await reopened.load();
    const persisted = reopened.exportCanvas();
    const area = persisted.ok ? decodeSceneAreaData(persisted.canvas.nodeData["area-node"]!.sceneArea) : null;
    expect(area?.ok && area.value.animationScript?.script).toBe(revisedScript);
  });

  it("distinguishes a director without animation from an older response", async () => {
    const { service, room } = await fixture({ animationScript: null });
    expect(await service.read(query)).toMatchObject({ ok: true, view: { sceneArea: { nodeId: "area-node", revision: 0, animationScript: null } } });
    expect(room.currentRevision).toBe(0);
  });

  it("never exposes director animation or bounds through a 2D group context", async () => {
    const { service } = await fixture({ group: true });
    const result = await service.read(query);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.view).not.toHaveProperty("sceneArea");
    expect(result.view).not.toHaveProperty("bounds");
    expect(result.view.worldWritable).toBe(false);
  });

  it("rejects a different canvas and an unissued context", async () => {
    const { service } = await fixture();
    expect(await service.read({ ...query, canvasId: "another-canvas" })).toMatchObject({ ok: false, code: "stale-epoch" });
    expect(await service.read({ ...query, contextId: "unissued" })).toMatchObject({ ok: false, code: "not-issued" });
  });

  it.each(["cancel", "revoke"])("rechecks %s while waiting for a published read", async action => {
    const { service, room, revoke } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const queued = room.inspectPublished(async () => { entered(); await gate; });
    await started;
    const pending = service.read(query);
    if (action === "cancel") await service.cancel(query);
    else revoke();
    release();
    await queued;
    expect(await pending).toMatchObject({ ok: false, code: action === "cancel" ? "cancelled" : "stale-epoch" });
  });

  it.each(["areaId", "scopeVersion"])("rejects changed %s without returning stale animation", async field => {
    const { service, patchArea } = await fixture();
    expect((await patchArea({ [field]: "changed" })).ok).toBe(true);
    expect(await service.read(query)).toMatchObject({ ok: false, code: field === "areaId" ? "outside-scope" : "version-conflict" });
  });

  it("rejects the whole animation script if it targets a read-only part without exposing or filtering it", async () => {
    const { service, room } = await fixture({ readOnlyProp: true });
    const result = await service.read(query);
    expect(result).toMatchObject({ ok: false, code: "outside-scope", message: expect.stringContaining("原动画未修改") });
    expect(result).not.toHaveProperty("view");
    const published = room.exportCanvas();
    const area = published.ok ? decodeSceneAreaData(published.canvas.nodeData["area-node"]!.sceneArea) : null;
    expect(area?.ok && area.value.animationScript?.script).toBe(original.script);
    expect(room.currentRevision).toBe(0);
  });
});
