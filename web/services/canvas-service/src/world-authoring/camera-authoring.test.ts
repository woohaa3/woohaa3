import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDefaultWorldCameraData, createEmptyWoohaa3ServerCanvas, worldCameraUiSettingsOf, type CanvasNodeData } from "@woohaa3/contracts";
import { CanvasRoom } from "../sync/room.js";
import { SqliteYjsRepository } from "../storage/sqlite/yjs.js";
import { createWorldAuthoringAuthority } from "./authority.js";
import { createWorldAuthoringService } from "./scene-area-service.js";
import { createAssistantWorldService } from "./assistant-service.js";
import { createWorldCameraSettingsService } from "./camera-service.js";
import { InMemoryWorldCameraHistoryRepository } from "./camera-history.js";

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "camera-authoring-"));
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  const canvas = createEmptyWoohaa3ServerCanvas("canvas");
  for (const id of ["camera-a", "camera-b"]) {
    canvas.document.nodes.push({ id, type: "world-camera", position: { x: 0, y: 0 } });
    canvas.nodeData[id] = { worldCamera: createDefaultWorldCameraData(id, "v1", { u: 0, v: 0 }) } as unknown as CanvasNodeData;
  }
  canvas.document.nodes.push({ id: "model", type: "model3d", position: { x: 0, y: 0 } });
  canvas.nodeData.model = { title: "桌子", modelScript: "scene.box({});", modelScriptVersion: "woohaa-model-js-v2",
    sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: "model-instance",
      transform: { version: "shared-world-v1", position: { u: 2, v: 3, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } } };
  const authority = createWorldAuthoringAuthority({
    // Unknown reference geometry does not disable camera-only adjustments.
    executeScene: async () => ({ ok: false, error: "unavailable" }) as never,
    verifyStopped: (identity, evidence) => !!evidence && (evidence as { runId: string }).runId === identity.runId
  });
  const repository = new SqliteYjsRepository({ path: join(dir, "canvas.sqlite"), spatialAuthority: authority });
  closers.push(() => repository.close());
  const room = new CanvasRoom({ canvasId: canvas.id, repository });
  await room.initialize({ canvas, roomEpoch: "epoch", createdAt: new Date().toISOString() });
  closers.push(() => room.dispose());
  const worldAuthoring = createWorldAuthoringService({ authority, resolveRoom: async () => room,
    acquire: async intent => repository.acquireSpatialRun(intent),
    cancel: async (id, requestId) => repository.cancelSpatialRun(id, requestId),
    findLatest: async (id, operationId) => repository.findLatestWorldAuthoringCommand(id, operationId) });
  const history = new InMemoryWorldCameraHistoryRepository();
  let assistant: ReturnType<typeof createAssistantWorldService>;
  const cameraSettings = createWorldCameraSettingsService({ resolveRoom: async () => room,
    resolveContext: (id, contextId) => worldAuthoring.resolveCapability(id, contextId), history,
    verifyCompletion: (completion, evidence) => assistant.verifyCompletion(completion, evidence) });
  assistant = createAssistantWorldService({ authority, worldAuthoring, cameraSettings, resolveRoom: async () => room,
    cancel: async (id, requestId) => repository.cancelSpatialRun(id, requestId),
    confirmStopped: async input => repository.confirmSpatialStopped(input.canvasId, input.requestId, input.runId, input.epoch, input.executionId, input.evidence),
    pending: async () => repository.pendingSpatialRuns() });
  closers.push(() => assistant.close());
  const issue = (runId: string, cameraId = "camera-a") => assistant.issue({ canvasId: canvas.id, requestId: runId,
    runId, epoch: 0, executionId: runId, scope: { kind: "world-camera", cameraId } });
  const issued = await issue("run-a");
  if (!issued.ok) throw new Error(issued.message);
  const baseline = room.exportCanvas();
  if (!baseline.ok) throw new Error("missing canonical baseline");
  return { baseline: baseline.canvas, assistant, issue, contextId: issued.context.contextId, room, repository, history, canvas, cameraSettings };
}

it("reads a single writable lens and scene references, applies successive perspective edits, persists and completes once", async () => {
  const { assistant, contextId, repository, history } = await fixture();
  const first = await assistant.read({ canvasId: "canvas", contextId });
  expect(first).toMatchObject({ ok: true, view: {
    writable: [{ kind: "camera", cameraId: "camera-a", version: "v1" }],
    camera: { nodeId: "camera-a", settings: { cameraId: "camera-a", settingsVersion: "v1" } },
    sceneModels: [{ instanceId: "model-instance", title: "桌子", localBounds: null }]
  } });
  if (!first.ok || !first.view.camera) throw new Error("missing camera context");
  let current = first.view.camera.settings;
  for (const [index, fov] of [0.9, 0.7].entries()) {
    const settings = { ...worldCameraUiSettingsOf(current), position: { u: 8 + index, v: -5, h: 4 },
      projection: { kind: "perspective" as const, verticalFovRadians: fov, nearMeters: 0.1, farMeters: 500 }, aspect: { width: 4, height: 3 } };
    const written = await assistant.write({ contextId, operation: { kind: "set-world-camera", operationId: `adjust-${index}`,
      cameraId: "camera-a", expectedSettingsVersion: current.settingsVersion, settings } });
    expect(written).toMatchObject({ ok: true, duplicate: false });
    const read = await assistant.read({ canvasId: "canvas", contextId });
    if (!read.ok || !read.view.camera) throw new Error("missing adjusted camera");
    expect(read.view.camera.settings).toMatchObject(settings);
    expect(read.view.camera.settings.settingsVersion).not.toBe(current.settingsVersion);
    current = read.view.camera.settings;
  }
  expect(await assistant.write({ contextId, operation: { kind: "set-world-camera", operationId: "stale", cameraId: "camera-a",
    expectedSettingsVersion: "v1", settings: worldCameraUiSettingsOf(current) } })).toMatchObject({ ok: false, code: "version-conflict" });
  expect((await repository.loadYjsState("canvas"))?.projection?.nodeData["camera-a"]?.worldCamera).toEqual(current);
  const settle = { canvasId: "canvas", runId: "run-a", status: "succeeded" as const, evidence: { runId: "run-a" } };
  expect(await assistant.settleRun(settle)).toEqual({ ok: true });
  expect(await assistant.settleRun(settle)).toEqual({ ok: true });
  const entries = await history.list("canvas", "camera-a");
  expect(entries).toHaveLength(1);
  expect(entries[0]?.settingsVersion).toBe(current.settingsVersion);
  expect(await repository.pendingSpatialRuns()).toHaveLength(0);
});

it("rejects overlapping runs and writes to other cameras, models, animation, bindings and orthographic lenses", async () => {
  const { assistant, issue, contextId, room, baseline } = await fixture();
  expect(await issue("overlap")).toMatchObject({ ok: false, code: "lease-conflict" });
  expect(await issue("other", "camera-b")).toMatchObject({ ok: true });
  const base = createDefaultWorldCameraData("camera-a", "v1", { u: 0, v: 0 });
  const settings = worldCameraUiSettingsOf(base);
  const write = (cameraId: string, next = settings) => assistant.write({ contextId, operation: { kind: "set-world-camera",
    operationId: "denied", cameraId, expectedSettingsVersion: "v1", settings: next } });
  expect(await write("camera-b")).toMatchObject({ ok: false, code: "outside-scope" });
  expect(await write("camera-a", { ...settings, boundInstanceId: "model-instance" })).toMatchObject({ ok: false, code: "outside-scope" });
  expect(await write("camera-a", { ...settings, projection: { kind: "isometric", verticalSizeMeters: 10, nearMeters: 0.1, farMeters: 100 } })).toMatchObject({ ok: false, code: "invalid-data" });
  expect(await assistant.write({ contextId, operation: { kind: "set-model-transform", operationId: "model-write", instanceId: "model-instance", expectedVersion: "v1",
    transform: { version: "shared-world-v1", position: { u: 1, v: 2, h: 3 }, rotation: [0, 0, 0, 1], scale: 1 } } })).toMatchObject({ ok: false, code: "outside-scope" });
  expect(room.currentRevision).toBe(0);
  expect((await room.inspectPublished(value => value)).ok).toBe(true);
  const snapshot = room.exportCanvas();
  expect(snapshot.ok && snapshot.canvas.nodeData).toEqual(baseline.nodeData);
});

it("normalizes hand-rounded rotations, applies partial patches and reports the current version", async () => {
  const { assistant, contextId } = await fixture();
  const first = await assistant.read({ canvasId: "canvas", contextId });
  if (!first.ok || !first.view.camera) throw new Error("missing camera context");
  const base = worldCameraUiSettingsOf(first.view.camera.settings);
  const originalVersion = first.view.camera.settings.settingsVersion;

  const rounded = await assistant.write({ contextId, operation: {
    kind: "set-world-camera", operationId: "rounded-rotation", cameraId: "camera-a",
    expectedSettingsVersion: originalVersion,
    settings: { ...base, rotation: [0, 0, -0.7071, 0.7071] } } });
  expect(rounded).toMatchObject({ ok: true });
  const normalizedRead = await assistant.read({ canvasId: "canvas", contextId });
  if (!normalizedRead.ok || !normalizedRead.view.camera) throw new Error("missing adjusted camera");
  const normalizedRotation = normalizedRead.view.camera.settings.rotation;
  expect(Math.abs(normalizedRotation.reduce((sum, value) => sum + value * value, 0) - 1)).toBeLessThan(1e-6);
  expect(normalizedRotation[2]).toBeCloseTo(-Math.SQRT1_2, 9);

  const partial = await assistant.write({ contextId, operation: {
    kind: "set-world-camera", operationId: "partial-position", cameraId: "camera-a",
    expectedSettingsVersion: normalizedRead.view.camera.settings.settingsVersion,
    settings: { position: { u: 4, v: 6, h: 2 } } } });
  expect(partial).toMatchObject({ ok: true });
  const partialRead = await assistant.read({ canvasId: "canvas", contextId });
  if (!partialRead.ok || !partialRead.view.camera) throw new Error("missing patched camera");
  expect(partialRead.view.camera.settings.position).toEqual({ u: 4, v: 6, h: 2 });
  expect(partialRead.view.camera.settings.projection).toEqual(base.projection);
  expect(partialRead.view.camera.settings.rotation).toEqual(normalizedRotation);

  const currentVersion = partialRead.view.camera.settings.settingsVersion;
  const stale = await assistant.write({ contextId, operation: {
    kind: "set-world-camera", operationId: "stale-again", cameraId: "camera-a",
    expectedSettingsVersion: originalVersion,
    settings: { position: { u: 1, v: 1, h: 1 } } } });
  expect(stale).toMatchObject({ ok: false, code: "version-conflict" });
  expect(stale.ok ? "" : stale.message).toContain(currentVersion);

  const invalidRotation = await assistant.write({ contextId, operation: {
    kind: "set-world-camera", operationId: "invalid-rotation", cameraId: "camera-a",
    expectedSettingsVersion: currentVersion,
    settings: { rotation: [0, 0, 0.5, 0.5] } } });
  expect(invalidRotation).toMatchObject({ ok: false, code: "invalid-data" });
  expect(invalidRotation.ok ? "" : invalidRotation.message).toContain("旋转四元数");
});
