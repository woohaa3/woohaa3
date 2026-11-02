/**
 * T11 assistant camera atomic receipt recovery.
 *
 * These probes use the real CanvasRoom, the real SQLite command receipts, the
 * real T08 camera-history service/repository and the real SQLite host-completion
 * store. Process loss is injected deterministically at the service boundary
 * (the outbox insert fails or the process is closed), not by claiming an OS
 * kill or GPU evidence.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  worldCameraCompletionKey,
  type ServerCanvas,
  type WorldCameraSettings
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, computeCommandPayloadHash } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../services/canvas-service/src/sync/room.js";
import { SqliteYjsRepository } from "../services/canvas-service/src/storage/sqlite/yjs.js";
import { createWorldAuthoringAuthority } from "../services/canvas-service/src/world-authoring/authority.js";
import { createWorldAuthoringService } from "../services/canvas-service/src/world-authoring/scene-area-service.js";
import {
  createAssistantWorldService,
  type AssistantWorldService
} from "../services/canvas-service/src/world-authoring/assistant-service.js";
import {
  createWorldCameraSettingsService,
  findWorldCameraNodeId,
  planWorldCameraSettings,
  type WorldCameraSettingsService
} from "../services/canvas-service/src/world-authoring/camera-service.js";
import { SqliteWorldCameraHistoryRepository } from "../services/canvas-service/src/storage/sqlite/world-camera-history.js";
import {
  type AssistantHostCompletionRepository,
  type AssistantWorldCommittedWrite,
  type AssistantWorldWriteIntent
} from "../services/canvas-service/src/world-authoring/host-completions.js";
import { SqliteAssistantHostCompletionRepository } from "../services/canvas-service/src/storage/sqlite/host-completions.js";
import { loadNodeSqlite } from "../services/canvas-service/src/storage/sqlite/sqlite-loader.js";
import { createCanvasService } from "../services/canvas-service/src/composition.js";

const now = "2026-01-01T00:00:00Z";
const canvasId = "canvas-atomic";
const cameraId = "camera-atomic";

const cameraA: WorldCameraSettings = {
  position: { u: 5, v: 5, h: 2 },
  rotation: [0, 0, 0, 1],
  projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
  captureMode: { kind: "static" },
  aspect: { width: 16, height: 9 },
  boundInstanceId: null
};

const cameraB: WorldCameraSettings = {
  ...cameraA,
  position: { u: 5, v: 5, h: 3.5 }
};

function scene() {
  return Promise.resolve({
    ok: true as const,
    version: "woohaa-model-js-v2" as const,
    sceneVersion: "scene-ir-v2",
    json: "",
    sourceHash: "fixture",
    ops: [{
      t: "box",
      id: "body",
      parent: null,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: null,
      color: null,
      size: [2, 2, 2]
    }] as never
  });
}

function canvasFixture(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas(canvasId, now);
  canvas.document.nodes.push(
    { id: "area-node", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "camera-card", type: "world-camera", position: { x: 900, y: 900 } }
  );
  canvas.nodeData["area-node"] = {
    sceneArea: {
      kind: "scene-area",
      version: "shared-world-v1",
      areaId: "area-1",
      scopeVersion: "area-scope-1",
      bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
    }
  };
  canvas.nodeData["camera-card"] = {
    worldCamera: {
      kind: "world-camera",
      version: "shared-world-v1",
      cameraId,
      settingsVersion: "camera-1-v1",
      position: { u: 5, v: 5, h: 1.5 },
      rotation: [0, 0, 0, 1],
      projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
      captureMode: { kind: "static" },
      aspect: { width: 16, height: 9 },
      boundInstanceId: null
    }
  };
  return canvas;
}

/** Real durable stores plus a switchable outbox failure at the service boundary. */
class FailingOutboxRepository implements AssistantHostCompletionRepository {
  failures: number;
  constructor(private readonly inner: AssistantHostCompletionRepository, failures: number) {
    this.failures = failures;
  }
  put(fact: Parameters<AssistantHostCompletionRepository["put"]>[0]) { return this.inner.put(fact); }
  get(completion: Parameters<AssistantHostCompletionRepository["get"]>[0]) { return this.inner.get(completion); }
  list(input?: Parameters<AssistantHostCompletionRepository["list"]>[0]) { return this.inner.list(input); }
  delete(completion: Parameters<AssistantHostCompletionRepository["delete"]>[0]) { return this.inner.delete(completion); }
  async putCommitted(write: AssistantWorldCommittedWrite): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("injected outbox insert failure");
    }
    await this.inner.putCommitted?.(write);
  }
  listCommitted(input?: Parameters<NonNullable<AssistantHostCompletionRepository["listCommitted"]>>[0]) {
    return this.inner.listCommitted?.(input) ?? Promise.resolve([]);
  }
  deleteCommitted(write: Parameters<NonNullable<AssistantHostCompletionRepository["deleteCommitted"]>>[0]) {
    return this.inner.deleteCommitted?.(write) ?? Promise.resolve();
  }
  putIntent(intent: AssistantWorldWriteIntent) { return this.inner.putIntent?.(intent) ?? Promise.resolve(); }
  getIntent(commandId: string) { return this.inner.getIntent?.(commandId) ?? Promise.resolve(null); }
  listIntents(input?: Parameters<NonNullable<AssistantHostCompletionRepository["listIntents"]>>[0]) {
    return this.inner.listIntents?.(input) ?? Promise.resolve([]);
  }
  deleteIntent(commandId: string) { return this.inner.deleteIntent?.(commandId) ?? Promise.resolve(); }
  close() { return this.inner.close?.(); }
}

type Harness = Awaited<ReturnType<typeof openHarness>>;

async function openHarness(root: string, options: { outboxFailures?: number } = {}) {
  const file = join(root, "canvas.sqlite");
  const hostFile = join(root, "host-completions.sqlite");
  const historyFile = join(root, "camera-history.sqlite");
  const authority = createWorldAuthoringAuthority({
    executeScene: scene,
    verifyStopped: (identity, evidence) => {
      const value = evidence as { terminal?: unknown; runId?: unknown } | null;
      return !!value && value.terminal === true && value.runId === identity.runId;
    }
  });
  const repository = new SqliteYjsRepository({ path: file, spatialAuthority: authority });
  const room = new CanvasRoom({ canvasId, repository, now: () => now });
  await room.initialize({ canvas: canvasFixture(), roomEpoch: "initial", createdAt: now });
  return buildServices(room, repository, authority, file, hostFile, historyFile, options.outboxFailures ?? 0);
}

async function reopenHarness(harness: Harness, options: { outboxFailures?: number } = {}) {
  harness.assistant.close();
  await harness.hostFacts.close();
  await harness.history.close();
  harness.repository.close();
  const authority = createWorldAuthoringAuthority({
    executeScene: scene,
    verifyStopped: (identity, evidence) => {
      const value = evidence as { terminal?: unknown; runId?: unknown } | null;
      return !!value && value.terminal === true && value.runId === identity.runId;
    }
  });
  const repository = new SqliteYjsRepository({ path: harness.file, spatialAuthority: authority });
  const room = new CanvasRoom({ canvasId, repository, now: () => now });
  const loaded = await room.load();
  expect(loaded.ok).toBe(true);
  return buildServices(
    room,
    repository,
    authority,
    harness.file,
    harness.hostFile,
    harness.historyFile,
    options.outboxFailures ?? 0
  );
}

async function buildServices(
  room: CanvasRoom,
  repository: SqliteYjsRepository,
  authority: ReturnType<typeof createWorldAuthoringAuthority>,
  file: string,
  hostFile: string,
  historyFile: string,
  outboxFailures: number
) {
  const worldAuthoring = createWorldAuthoringService({
    authority,
    resolveRoom: async () => room,
    acquire: async (intent) => repository.acquireSpatialRun(intent),
    cancel: async (canvasIdValue, requestId) => repository.cancelSpatialRun(canvasIdValue, requestId),
    findLatest: async (canvasIdValue, operationId) => repository.findLatestWorldAuthoringCommand(canvasIdValue, operationId)
  });
  const history = new SqliteWorldCameraHistoryRepository({ path: historyFile });
  const innerFacts = new SqliteAssistantHostCompletionRepository({ path: hostFile });
  const hostFacts = new FailingOutboxRepository(innerFacts, outboxFailures);
  let assistant: AssistantWorldService | null = null;
  const cameraSettings: WorldCameraSettingsService = createWorldCameraSettingsService({
    resolveRoom: async () => room,
    resolveContext: (canvasIdValue, contextId) => worldAuthoring.resolveCapability(canvasIdValue, contextId),
    history,
    verifyCompletion: (completion, evidence) => assistant ? assistant.verifyCompletion(completion, evidence) : false,
    now: () => now
  });
  assistant = createAssistantWorldService({
    authority,
    worldAuthoring,
    cameraSettings,
    resolveRoom: async () => room,
    cancel: async (canvasIdValue, requestId) => repository.cancelSpatialRun(canvasIdValue, requestId),
    confirmStopped: async (input) => repository.confirmSpatialStopped(
      input.canvasId,
      input.requestId,
      input.runId,
      input.epoch,
      input.executionId,
      input.evidence
    ),
    findRecordedCompletion: async (completion) => {
      const entry = await history.get(completion.canvasId, worldCameraCompletionKey(completion));
      return !!entry
        && entry.runId === completion.runId
        && entry.completionId === completion.completionId
        && entry.cameraId === completion.cameraId
        && entry.settingsVersion === completion.settingsVersion;
    },
    hostCompletions: hostFacts,
    pending: async () => repository.pendingSpatialRuns()
  });
  return {
    file,
    room,
    repository,
    history,
    hostFile,
    historyFile,
    hostFacts,
    assistant,
    cameraSettings,
    worldAuthoring,
    settle: (status: "queued" | "running" | "committing" | "succeeded" | "partial" | "failed" | "cancelled", evidence: unknown = { terminal: true, runId: "run-1" }) =>
      assistant!.settleRun({ canvasId, runId: "run-1", status, evidence })
  };
}

async function issueAndWrite(harness: Harness, settings: WorldCameraSettings = cameraA, operationId = "camera-edit") {
  const issued = await harness.assistant.issue({
    canvasId,
    requestId: "run-1",
    runId: "run-1",
    epoch: 0,
    executionId: "exec-1",
    scope: { kind: "scene-area", areaId: "area-1" }
  });
  if (!issued.ok) throw new Error(issued.message);
  const operation = {
    kind: "set-world-camera" as const,
    operationId,
    cameraId,
    expectedSettingsVersion: "camera-1-v1",
    settings
  };
  const written = await harness.assistant.write({ contextId: issued.context.contextId, operation });
  return { issued, operation, written };
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "assistant-camera-atomic-"));
}

describe("assistant camera atomic receipt recovery", () => {
  it("recovers a canonical camera commit whose outbox insert never happened", async () => {
    const root = tempRoot();
    let harness: Harness | null = null;
    try {
      harness = await openHarness(root, { outboxFailures: 1 });
      const { issued, written } = await issueAndWrite(harness);
      // The tool must not report success when its durable receipt failed.
      expect(written).toMatchObject({ ok: false, code: "not-ready" });
      const intents = await harness.hostFacts.listIntents({ canvasId, runId: "run-1" });
      expect(intents).toHaveLength(1);
      expect(await harness.hostFacts.listCommitted({ canvasId, runId: "run-1" })).toHaveLength(0);
      expect(await harness.history.list(canvasId, cameraId)).toHaveLength(0);
      // The original real command receipt exists and binds the frozen payload.
      const intent = intents[0]!;
      const receipt = await harness.room.lookupCommand(intent.commandId);
      expect(receipt).toMatchObject({ payloadHash: intent.payloadHash });
      expect(intent.settingsVersion).toBeTruthy();

      harness = await reopenHarness(harness);
      // Host-start reconciliation only adopts the verified receipt into the
      // outbox; it does not create history without a trusted terminal turn.
      expect(await harness.assistant.resumePendingCompletions()).toMatchObject({ ok: true });
      expect(await harness.history.list(canvasId, cameraId)).toHaveLength(0);
      expect(await harness.hostFacts.listCommitted({ canvasId, runId: "run-1" })).toHaveLength(1);
      expect(await harness.settle("succeeded")).toEqual({ ok: true });
      const entries = await harness.history.list(canvasId, cameraId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        runId: "run-1",
        completionId: issued.completionId,
        cameraId,
        settingsVersion: intent.settingsVersion,
        snapshot: { camera: { cameraId, settingsVersion: intent.settingsVersion, position: { h: 2 } } }
      });
      expect(await harness.hostFacts.listIntents({ canvasId, runId: "run-1" })).toHaveLength(0);
      expect(await harness.hostFacts.listCommitted({ canvasId, runId: "run-1" })).toHaveLength(0);
      expect(await harness.hostFacts.list({ canvasId, runId: "run-1" })).toHaveLength(0);
      expect(await harness.repository.pendingSpatialRuns()).toHaveLength(0);

      // Repeated settle/complete stay idempotent on the same completion identity.
      expect(await harness.settle("succeeded")).toEqual({ ok: true });
      expect(await harness.assistant.complete({
        contextId: issued.context.contextId,
        completion: {
          canvasId,
          runId: "run-1",
          completionId: issued.completionId,
          cameraId,
          settingsVersion: intent.settingsVersion
        }
      })).toMatchObject({ ok: true, duplicate: true });
      expect(await harness.history.list(canvasId, cameraId)).toHaveLength(1);
    } finally {
      harness?.assistant.close();
      await harness?.hostFacts.close();
      await harness?.history.close();
      harness?.repository.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adopts the original receipt on same-intent retry instead of returning version-conflict", async () => {
    const root = tempRoot();
    let harness: Harness | null = null;
    try {
      harness = await openHarness(root, { outboxFailures: 1 });
      const { issued, operation, written } = await issueAndWrite(harness);
      expect(written).toMatchObject({ ok: false, code: "not-ready" });
      const intent = (await harness.hostFacts.listIntents({ canvasId, runId: "run-1" }))[0]!;

      // The outbox is available again; the exact same intent must resolve the
      // already-committed command rather than re-applying against an advanced
      // version.
      harness.hostFacts.failures = 0;
      const retried = await harness.assistant.write({ contextId: issued.context.contextId, operation });
      expect(retried).toMatchObject({ ok: true, duplicate: true, settingsVersion: intent.settingsVersion });
      if (!retried.ok) return;
      expect(retried.commandId).toBe(intent.commandId);
      expect(await harness.hostFacts.listIntents({ canvasId, runId: "run-1" })).toHaveLength(0);
      expect(await harness.hostFacts.listCommitted({ canvasId, runId: "run-1" })).toHaveLength(1);

      expect(await harness.settle("succeeded")).toEqual({ ok: true });
      const entries = await harness.history.list(canvasId, cameraId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        completionId: issued.completionId,
        settingsVersion: intent.settingsVersion,
        snapshot: { camera: { position: { h: 2 } } }
      });
    } finally {
      harness?.assistant.close();
      await harness?.hostFacts.close();
      await harness?.history.close();
      harness?.repository.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never treats a pre-commit intent as proof of a submitted camera", async () => {
    const root = tempRoot();
    let harness: Harness | null = null;
    try {
      harness = await openHarness(root);
      const issued = await harness.assistant.issue({
        canvasId,
        requestId: "run-1",
        runId: "run-1",
        epoch: 0,
        executionId: "exec-1",
        scope: { kind: "scene-area", areaId: "area-1" }
      });
      if (!issued.ok) throw new Error(issued.message);
      const inspected = await harness.room.inspectPublished(value => value);
      const nodeId = inspected.ok ? findWorldCameraNodeId(inspected.canvas, cameraId) : null;
      const planned = planWorldCameraSettings(cameraId, cameraA);
      if (!nodeId || "ok" in planned) throw new Error("fixture camera invalid");
      // Simulate the process dying *before* the canonical command executes: only
      // the durable pre-commit intent exists, with no command receipt.
      const commandId = "world-camera-save:intent-only:pre-commit";
      const payloadHash = await computeCommandPayloadHash({
        canvasId,
        commands: [{ type: "nodeData.patch", nodeId, value: { worldCamera: planned } as never }]
      });
      await harness.hostFacts.putIntent({
        canvasId,
        requestId: "run-1",
        runId: "run-1",
        epoch: 0,
        executionId: "exec-1",
        contextId: issued.context.contextId,
        completionId: issued.completionId,
        cameraId,
        commandId,
        expectedSettingsVersion: "camera-1-v1",
        nodeId,
        settingsVersion: planned.settingsVersion,
        snapshot: planned,
        payloadHash
      });
      expect(await harness.room.lookupCommand(commandId)).toBeNull();

      harness = await reopenHarness(harness);
      expect(await harness.settle("succeeded")).toEqual({ ok: true });
      expect(await harness.history.list(canvasId, cameraId)).toHaveLength(0);
      expect(await harness.hostFacts.listIntents({ canvasId, runId: "run-1" })).toHaveLength(0);
      expect(await harness.hostFacts.listCommitted({ canvasId, runId: "run-1" })).toHaveLength(0);
      expect(await harness.hostFacts.list({ canvasId, runId: "run-1" })).toHaveLength(0);
      expect(await harness.repository.pendingSpatialRuns()).toHaveLength(0);
      // The canonical camera was never changed by recovery.
      const current = await harness.room.inspectPublished(value => value);
      expect(current.ok && (current.canvas.nodeData["camera-card"]?.worldCamera as { settingsVersion?: string }).settingsVersion)
        .toBe("camera-1-v1");
    } finally {
      harness?.assistant.close();
      await harness?.hostFacts.close();
      await harness?.history.close();
      harness?.repository.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the exact A snapshot after B and camera deletion across a real SQLite reopen", async () => {
    const root = tempRoot();
    let harness: Harness | null = null;
    try {
      harness = await openHarness(root, { outboxFailures: 1 });
      const { issued, written } = await issueAndWrite(harness, cameraA);
      expect(written).toMatchObject({ ok: false, code: "not-ready" });
      const intent = (await harness.hostFacts.listIntents({ canvasId, runId: "run-1" }))[0]!;
      const versionA = intent.settingsVersion;
      // Stop/release happened without the first successful settle (the previous
      // process released occupancy after the canonical commit). The historical
      // write must survive this release.
      await harness.repository.confirmSpatialStopped(
        canvasId,
        "run-1",
        "run-1",
        0,
        "exec-1",
        { terminal: true, runId: "run-1" }
      );
      expect(await harness.repository.pendingSpatialRuns()).toHaveLength(0);

      const later = await harness.cameraSettings.save({
        canvasId,
        cameraId,
        expectedSettingsVersion: versionA,
        settings: cameraB,
        operationId: "later-edit",
        actorId: "test"
      });
      expect(later.ok).toBe(true);
      if (!later.ok) return;
      expect(later.settingsVersion).not.toBe(versionA);

      // Delete the original camera after A. Recovery must still record A from
      // its frozen snapshot without restoring the deleted current camera.
      const removed = await harness.room.submit({
        protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
        canvasId,
        commandId: "delete-camera",
        actorId: "test",
        baseRevision: harness.room.currentRevision,
        commands: [{ type: "node.remove", nodeIds: ["camera-card"] }]
      });
      expect(removed.ok).toBe(true);
      expect(harness.room.exportCanvas().ok).toBe(true);
      const before = harness.room.exportCanvas();
      expect(before.ok && before.canvas.document.nodes.some(node => node.id === "camera-card")).toBe(false);

      harness = await reopenHarness(harness);
      expect(await harness.settle("succeeded")).toEqual({ ok: true });
      const entries = await harness.history.list(canvasId, cameraId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        completionId: issued.completionId,
        settingsVersion: versionA,
        snapshot: { camera: { settingsVersion: versionA, position: { h: 2 } } }
      });
      // Current canonical state remains deleted; A is history, not a rollback.
      const current = await harness.room.inspectPublished(value => value);
      expect(current.ok && current.canvas.document.nodes.some(node => node.id === "camera-card")).toBe(false);
      expect(await harness.hostFacts.list({ canvasId, runId: "run-1" })).toHaveLength(0);
    } finally {
      harness?.assistant.close();
      await harness?.hostFacts.close();
      await harness?.history.close();
      harness?.repository.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never records history or re-signs completion for active, failed, cancelled or unverified turns", async () => {
    {
      const root = tempRoot();
      let harness: Harness | null = null;
      try {
        harness = await openHarness(root);
        await issueAndWrite(harness);
        // An active turn is not a terminal success: no completion fact, no
        // history and no re-signed capability.
        expect(await harness.settle("running")).toEqual({ ok: true });
        expect(await harness.history.list(canvasId, cameraId)).toHaveLength(0);
        expect(await harness.hostFacts.list({ canvasId, runId: "run-1" })).toHaveLength(0);
      } finally {
        harness?.assistant.close();
        await harness?.hostFacts.close();
        await harness?.history.close();
        harness?.repository.close();
        rmSync(root, { recursive: true, force: true });
      }
    }
    for (const status of ["failed", "cancelled"] as const) {
      const root = tempRoot();
      let harness: Harness | null = null;
      try {
        harness = await openHarness(root);
        const { issued } = await issueAndWrite(harness);
        expect(await harness.settle(status)).toEqual({ ok: true });
        expect(await harness.history.list(canvasId, cameraId)).toHaveLength(0);
        expect(await harness.hostFacts.list({ canvasId, runId: "run-1" })).toHaveLength(0);
        expect(await harness.hostFacts.listCommitted({ canvasId, runId: "run-1" })).toHaveLength(0);
        expect(await harness.repository.pendingSpatialRuns()).toHaveLength(0);
        const completion = {
          canvasId,
          runId: "run-1",
          completionId: issued.completionId,
          cameraId,
          settingsVersion: "camera-1-v1"
        };
        expect(await harness.assistant.complete({ contextId: issued.context.contextId, completion }))
          .toMatchObject({ ok: false });
        expect(await harness.history.list(canvasId, cameraId)).toHaveLength(0);
      } finally {
        harness?.assistant.close();
        await harness?.hostFacts.close();
        await harness?.history.close();
        harness?.repository.close();
        rmSync(root, { recursive: true, force: true });
      }
    }

    const root = tempRoot();
    let harness: Harness | null = null;
    try {
      harness = await openHarness(root);
      await issueAndWrite(harness);
      // The host cannot prove the exact execution stopped: keep occupancy and
      // the outbox, and never promote a completion.
      expect(await harness.settle("succeeded", null)).toMatchObject({ ok: false, code: "unverified-stop" });
      expect(await harness.history.list(canvasId, cameraId)).toHaveLength(0);
      expect(await harness.repository.pendingSpatialRuns()).toHaveLength(1);
      expect(await harness.hostFacts.listCommitted({ canvasId, runId: "run-1" })).toHaveLength(1);
      expect(await harness.hostFacts.list({ canvasId, runId: "run-1" })).toHaveLength(0);
    } finally {
      harness?.assistant.close();
      await harness?.hostFacts.close();
      await harness?.history.close();
      harness?.repository.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wires the durable intent store through the real canvas composition", async () => {
    const root = tempRoot();
    const file = join(root, "composed.sqlite");
    let service: Awaited<ReturnType<typeof createCanvasService>> | null = null;
    try {
      service = await createCanvasService({
        env: {
          WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
          WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: file
        },
        enableYjsSync: true,
        enableModelMcp: false,
        enablePromptSnippets: false
      });
      expect(service.assistantWorld).not.toBeNull();
      const sqlite = loadNodeSqlite();
      const db = new sqlite.DatabaseSync(file, { readOnly: true });
      try {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_world_write_intents'"
        ).get() as { name?: string } | undefined;
        expect(row?.name).toBe("assistant_world_write_intents");
      } finally {
        db.close();
      }
    } finally {
      await service?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
