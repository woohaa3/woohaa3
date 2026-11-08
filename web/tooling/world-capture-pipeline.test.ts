/**
 * T10 integration: real Canvas/SQLite/Yjs + real Media Service + the real run entry.
 *
 * The renderer producer is deterministic on purpose: this test proves the scheduling,
 * versioning, media verification and durable acceptance protocol. It does not claim
 * real GPU rendering; T09 supplies the production producer and T11b the final static
 * product chain.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  normalizeModelDefinition,
  parseCanvasAggregate,
  type CanvasTaskCatalog,
  type MediaStorage,
  type ServerCanvas,
  type WorldCameraData,
  type WorldCaptureProducerOutcome,
  type WorldCaptureRequest
} from "@woohaa3/contracts";
import type { WorldCaptureService } from "../services/canvas-service/src/world-authoring/capture-service.js";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { createMediaService } from "@woohaa3/media-service";
import { createTaskService } from "../services/task-service/src/composition.js";
import { createCanvasTaskClient } from "../services/canvas-service/src/clients/task-client.js";
import type { TaskService } from "../services/task-service/src/composition.js";
import type { MediaClient } from "../services/task-service/src/clients/media-client.js";
import { CanvasRoom } from "../services/canvas-service/src/sync/room.js";
import { SqliteYjsRepository } from "../services/canvas-service/src/storage/sqlite/yjs.js";
import { createCanvasService } from "../services/canvas-service/src/composition.js";
import { InMemoryCanvasRepository } from "../services/canvas-service/src/storage/core/in-memory-repository.js";
import { createInMemoryWriterLock } from "../services/canvas-service/src/sync/index.js";
import { createWorldAuthoringAuthority } from "../services/canvas-service/src/world-authoring/authority.js";
import { createWorldCaptureMediaSavePort } from "../services/canvas-service/src/world-authoring/capture-media.js";
import type { RendererClient } from "../services/canvas-service/src/model-renderer/client.js";

const NOW = "2026-01-01T00:00:00Z";
const CANVAS_ID = "canvas-capture";
const CAMERA_ID = "camera-1";
const INSTANCE_A = "instance-a";
const INSTANCE_B = "instance-b";

const closers: Array<() => Promise<void> | void> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Vec3 = [number, number, number];

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function quatFromBasis(right: Vec3, up: Vec3, back: Vec3): [number, number, number, number] {
  const m00 = right[0], m01 = up[0], m02 = back[0];
  const m10 = right[1], m11 = up[1], m12 = back[1];
  const m20 = right[2], m21 = up[2], m22 = back[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

function worldRotationFor(forward: Vec3): [number, number, number, number] {
  const back = normalize([-forward[0], -forward[1], -forward[2]]);
  const right = normalize(cross([0, 1, 0], back));
  const up = cross(back, right);
  return quatFromBasis(right, up, back);
}

const ISOMETRIC_ROTATION = worldRotationFor([1, 1, -1]);

function modelDefinition(script: string) {
  const normalized = normalizeModelDefinition({
    modelScript: script,
    modelScriptLanguage: "javascript",
    modelScriptVersion: "woohaa-model-js-v2",
    placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
  });
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.value;
}

function instanceData(id: string, u: number, v: number, script = "scene.box({ id: 'body', size: [2, 2, 2] });") {
  const normalized = modelDefinition(script);
  return {
    sharedWorldInstance: {
      kind: "world-instance",
      version: "shared-world-v1",
      instanceId: id,
      transform: {
        version: "shared-world-v1",
        position: { u, v, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    },
    modelScript: normalized.modelScript,
    modelScriptLanguage: normalized.modelScriptLanguage,
    modelScriptVersion: normalized.modelScriptVersion,
    modelContentVersion: normalized.contentVersion,
    modelPlacement: normalized.placement
  };
}

function cameraData(): WorldCameraData {
  return {
    kind: "world-camera",
    version: "shared-world-v1",
    cameraId: CAMERA_ID,
    settingsVersion: "camera-1-v1",
    position: { u: 5, v: 5, h: 1.5 },
    rotation: ISOMETRIC_ROTATION,
    projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: null
  };
}

function canvasFixture(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas(CANVAS_ID, NOW);
  canvas.document.nodes.push(
    { id: "model-a", type: "model3d", position: { x: 0, y: 0 } },
    { id: "model-b", type: "model3d", position: { x: 300, y: 0 } },
    { id: "camera-card", type: "world-camera", position: { x: 900, y: 900 } },
    { id: "image-node", type: "image", position: { x: 0, y: 400 } }
  );
  canvas.nodeData["model-a"] = instanceData(INSTANCE_A, 2, 2);
  canvas.nodeData["model-b"] = instanceData(INSTANCE_B, -2, 2);
  canvas.nodeData["camera-card"] = { worldCamera: cameraData() } as never;
  canvas.nodeData["image-node"] = { title: "生成", prompt: "draw" } as never;
  return canvas;
}

function pngBytes(width: number, height: number): Uint8Array {
  // Minimal valid IHDR + IEND structure. The media adapter and the test only inspect
  // the encoded header dimensions; Media Service stores the exact bytes.
  const ihdr = new Uint8Array(25);
  ihdr.set([0, 0, 0, 13], 0);
  ihdr.set([0x49, 0x48, 0x44, 0x52], 4);
  const view = new DataView(ihdr.buffer);
  view.setUint32(8, width);
  view.setUint32(12, height);
  ihdr.set([8, 6, 0, 0, 0], 16);
  // CRC is not validated by the dimension reader or Media Service; keep zeros.
  const iend = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]);
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bytes = new Uint8Array(signature.length + ihdr.length + iend.length);
  bytes.set(signature, 0);
  bytes.set(ihdr, signature.length);
  bytes.set(iend, signature.length + ihdr.length);
  return bytes;
}

class MemoryMediaStorage implements MediaStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType });
  }
  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) throw Object.assign(new Error(`missing ${key}`), { code: "MEDIA_OBJECT_NOT_FOUND" });
    return { bytes: new Uint8Array(object.bytes), contentType: object.contentType };
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async stat(key: string) {
    const object = this.objects.get(key);
    if (!object) throw Object.assign(new Error(`missing ${key}`), { code: "MEDIA_OBJECT_NOT_FOUND" });
    return { size: object.bytes.byteLength, contentType: object.contentType };
  }
}

function catalog(modelKey = "m", acceptsCapture = true): CanvasTaskCatalog {
  return {
    available: true,
    models: [{
      providerId: "p",
      modelKey,
      providerModelId: "m",
      modelType: "image",
      title: "M",
      interaction: { id: "generic-model", version: 1 },
      inputSchema: {},
      defaultInput: {},
      bindings: acceptsCapture ? [{
        field: "references",
        semantic: "reference-image",
        roles: ["reference_image"],
        mediaKinds: ["image"],
        mediaTypes: ["image/png"],
        maxItems: 4,
        valueFormat: "url"
      }] : [],
      taskTimeoutMs: 1000
    }],
    defaultModels: {}
  };
}

type Harness = {
  dir: string;
  file: string;
  repository: SqliteYjsRepository;
  service: Awaited<ReturnType<typeof createCanvasService>>;
  capture: WorldCaptureService;
  mediaStorage: MemoryMediaStorage;
  mediaSave: ReturnType<typeof createWorldCaptureMediaSavePort>;
  media: ReturnType<typeof createMediaService>;
  taskSubmits: Array<{ worldCapture?: unknown }>;
  taskService?: TaskService;
  providerReferences: Array<{ role: string; storageKey?: string; mediaType: string; mediaKind?: string }>;
};

async function openHarness(options: {
  saveDelay?: (key: string) => Promise<void>;
  realTask?: boolean;
  captureUnsupported?: boolean;
  modelRenderer?: RendererClient;
  now?: () => string;
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "world-capture-pipeline-"));
  dirs.push(dir);
  const file = join(dir, "canvas.sqlite");
  const canvas = canvasFixture();
  expect(parseCanvasAggregate(canvas, { now: NOW }).ok).toBe(true);
  const authority = createWorldAuthoringAuthority({ verifyStopped: () => true });
  const repository = new SqliteYjsRepository({ path: file, spatialAuthority: authority });
  await new CanvasRoom({ canvasId: CANVAS_ID, repository }).initialize({ canvas, roomEpoch: "e", createdAt: NOW });
  const catalogRepository = new InMemoryCanvasRepository();
  await catalogRepository.createCanvas(canvas);
  const mediaStorage = new MemoryMediaStorage();
  const media = createMediaService({ storage: mediaStorage, env: {} });
  const realSave = createWorldCaptureMediaSavePort({ media: media.port() });
  const mediaSave = options.saveDelay
    ? {
        async save(request: import("@woohaa3/contracts").WorldCaptureMediaSaveRequest) {
          await options.saveDelay!(request.key.worldContentVersion);
          return realSave.save(request);
        }
      }
    : realSave;
  const taskSubmits: Array<{ worldCapture?: unknown }> = [];
  const providerReferences: Harness["providerReferences"] = [];
  let taskService: TaskService | undefined;
  let taskClient: import("../services/canvas-service/src/clients/task-client.js").CanvasTaskClient = {
    async submit(request: { workerTaskKey: string; canvasId: string; nodeId: string; runId: string; worldCapture?: unknown }) {
      taskSubmits.push({ worldCapture: request.worldCapture });
      return {
        workerTaskKey: request.workerTaskKey,
        state: "queued",
        reused: false,
        canvasId: request.canvasId,
        nodeId: request.nodeId,
        runId: request.runId
      };
    },
    async cancel() {},
    async status() { return null; },
    async history() { return { items: [], cursor: 0 }; },
    async canvasActivity() { return { items: [] }; },
    async canvasActivitySince() { return { items: [] }; },
    async canvasActivityChanges() { return { items: [] }; }
  } as never;

  if (options.realTask) {
    const mediaClient: MediaClient = {
      verify: async (storageKey, expected, scope) =>
        media.port().verify(storageKey, expected as never, scope as never),
      sign: async (storageKey) => `https://media.invalid/${storageKey}`,
      importFromLocator: async () => { throw new Error("not used"); },
      importFromUrl: async () => { throw new Error("not used"); },
      importBytes: async () => { throw new Error("not used"); }
    };
    const provider = {
      extensionId: "test",
      providerId: "p",
      available: true,
      provider: {} as never,
      models: [{
        providerId: "p",
        providerModelId: "m",
        modelType: "image" as const,
        title: "M",
        inputSchema: {},
        defaultInput: {},
        capabilities: {
          referenceInput: {
            bindings: [{
              field: "references",
              semantic: "reference-image",
              roles: ["reference_image"],
              mediaKinds: ["image"],
              mediaTypes: ["image/png"],
              maxItems: 4
            }]
          }
        }
      }],
      prepareInput: (input: import("@woohaa3/contracts").GenerationPrepareInput) => {
        providerReferences.push(...input.references.map((reference) => ({
          role: reference.role,
          ...(reference.storageKey ? { storageKey: reference.storageKey } : {}),
          mediaType: reference.mediaType,
          ...(reference.mediaKind ? { mediaKind: reference.mediaKind } : {})
        })));
        return { references: input.references };
      }
    };
    const stubServer = {
      worker: {},
      async submit() { return { created: true, record: { key: "stub", status: "queued" } }; },
      async status() { return null; },
      async cancel() {},
      history: {},
      counters: () => ({}),
      subscribe: () => () => {},
      stop() {},
      abortAll() {},
      async drained() {},
      async close() {}
    };
    taskService = createTaskService({
      env: {},
      storePath: join(dir, "task.sqlite"),
      serviceToken: "test-token",
      modelsConfig: { version: 1, models: [] },
      generationProviders: () => [provider] as never,
      mediaClient,
      workerServer: stubServer as never
    });
    const taskServer = http.createServer((req, res) => {
      void taskService!.handle(req, res).then((handled) => {
        if (!handled) { res.writeHead(404); res.end(); }
      });
    });
    await new Promise<void>((resolve) => taskServer.listen(0, "127.0.0.1", resolve));
    const address = taskServer.address();
    if (!address || typeof address === "string") throw new Error("task server address unavailable");
    closers.push(() => new Promise<void>((resolve, reject) => taskServer.close((error) => error ? reject(error) : resolve())));
    taskClient = createCanvasTaskClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      serviceToken: "test-token"
    });
  }

  const service = await createCanvasService({
    modelRenderer: options.modelRenderer ?? null,
    repository: catalogRepository,
    yjsRepository: repository,
    storageConfig: { backend: "sqlite", sqlitePath: file, limits: {} },
    writerLock: createInMemoryWriterLock(),
    spatialAuthority: authority,
    accessRuntime: {
      enabled: false,
      instance: { kind: "instance", id: "instance:test", ownerId: "instance:test", credentialOwnerId: "instance:test" }
    },
    worldCaptureMediaSave: mediaSave,
    worldCaptureFreezeTimeoutMs: 3000,
    mediaClient: {
      verify: (storageKey: string, expected?: Record<string, unknown>, scope?: { canvasId: string }) =>
        media.port().verify(storageKey, expected as never, scope)
    },
    resolveCatalog: async () => catalog(options.realTask ? "p:m" : "m", !options.captureUnsupported),
    taskClient,
    now: options.now ?? (() => NOW)
  });
  closers.push(async () => {
    service.worldCapture?.dispose();
    await service.close();
    try { repository.close(); } catch { /* already closed */ }
    await media.close();
    await taskService?.close();
  });
  if (!service.worldCapture) throw new Error("world capture service not assembled");
  return {
    dir,
    file,
    repository,
    service,
    capture: service.worldCapture,
    mediaStorage,
    mediaSave: realSave,
    media,
    taskSubmits,
    ...(taskService ? { taskService } : {}),
    providerReferences
  };
}

function imageOutcome(request: WorldCaptureRequest): WorldCaptureProducerOutcome {
  return {
    status: "image",
    requestId: request.requestId,
    key: request.key,
    contentFingerprint: request.contentFingerprint,
    image: {
      bytes: pngBytes(request.output.width, request.output.height),
      contentType: request.output.contentType,
      width: request.output.width,
      height: request.output.height
    }
  };
}

function registerProducer(
  capture: WorldCaptureService,
  handler: (request: WorldCaptureRequest) => Promise<WorldCaptureProducerOutcome> = async request => imageOutcome(request)
) {
  const calls: WorldCaptureRequest[] = [];
  const registration = capture.registerProducer({
    producerId: "deterministic-t10",
    capture: async request => {
      calls.push(request);
      return handler(request);
    }
  });
  return { calls, registration };
}

/**
 * 模拟页面驱动渲染：反复消费待取景清单，出图并提交。真实前端由 world-cameras 插件
 * 在场景变化时按同一 pending/commit 接口渲染，这里用于宿主侧回归。
 */
function emulatePage(harness: Harness): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      for (const item of harness.capture.pendingPageCaptures(CANVAS_ID)) {
        if (stopped) return;
        await harness.capture.commitPageCapture({
          canvasId: item.canvasId,
          cameraId: item.cameraId,
          key: item.key,
          png: Buffer.from(pngBytes(item.width, item.height)),
          width: item.width,
          height: item.height
        });
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })();
  return () => {
    stopped = true;
  };
}

async function canonical(harness: Harness): Promise<ServerCanvas> {
  const room = await harness.service.sync!.registry.resolve(CANVAS_ID);
  const snapshot = await room!.inspectPublished(value => value);
  if (!snapshot.ok) throw new Error(snapshot.message);
  return snapshot.canvas;
}

async function patchNodeData(harness: Harness, nodeId: string, value: Record<string, unknown>): Promise<void> {
  const room = await harness.service.sync!.registry.resolve(CANVAS_ID);
  const canvas = await canonical(harness);
  const result = await room!.submit({
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: CANVAS_ID,
    commandId: `patch-${nodeId}-${canvas.revision}`,
    actorId: "test",
    baseRevision: canvas.revision,
    commands: [{ type: "nodeData.patch", nodeId, value }]
  } as never);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
}

async function patchModelScript(harness: Harness, nodeId: string, script: string): Promise<void> {
  const normalized = modelDefinition(script);
  await patchNodeData(harness, nodeId, {
    modelScript: normalized.modelScript,
    modelContentVersion: normalized.contentVersion,
    modelPlacement: normalized.placement
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition timed out");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function startServer(harness: Harness): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void harness.service.handle(req, res).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const base = `http://127.0.0.1:${address.port}`;
  closers.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { base, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

describe("T10 continuous capture and generation input freeze", () => {
  it("opening a restored canvas schedules capture without editing or starting a generation", async () => {
    const harness = await openHarness();
    const registry = harness.service.sync!.registry;
    const restored = await registry.resolve(CANVAS_ID);
    const before = restored.exportCanvas();
    expect(harness.capture.statuses(CANVAS_ID)).toEqual([]);
    const lease = await registry.acquire(CANVAS_ID);
    try {
      expect(harness.capture.pendingPageCaptures(CANVAS_ID)).toEqual([
        expect.objectContaining({ cameraId: CAMERA_ID, kind: "static", attemptId: expect.any(String) })
      ]);
      expect(restored.exportCanvas()).toEqual(before);
      expect(harness.taskSubmits).toHaveLength(0);
    } finally { lease.release(); }
  });

  it("freezes a page-rendered connected camera and delivers its pixels to the Provider", async () => {
    const harness = await openHarness({ realTask: true });
    const room = await harness.service.sync!.registry.resolve(CANVAS_ID);
    const canvas = await canonical(harness);
    expect((await room!.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: CANVAS_ID,
      commandId: "connect-camera", actorId: "test", baseRevision: canvas.revision,
      commands: [{ type: "edge.add", edge: { id: "camera-input", source: "camera-card", target: "image-node" } }]
    })).ok).toBe(true);
    const stopPage = emulatePage(harness);
    const server = await startServer(harness);
    const run = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      nodeId: "image-node", runId: "run-connected", jobId: "job-connected", modelKey: "p:m", prompt: "draw", parameters: {}
    });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    expect(harness.providerReferences).toHaveLength(1);
    const frozen = await harness.capture.freezeForGeneration({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(harness.providerReferences[0]).toEqual({
      role: "reference_image", storageKey: frozen.binding.media.storageKey, mediaType: "image/png", mediaKind: "image"
    });
    const repeated = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      nodeId: "image-node", runId: "run-connected-explicit", jobId: "job-connected-explicit", modelKey: "p:m",
      prompt: "draw", parameters: {}, worldCapture: frozen.binding
    });
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(202);
    expect(harness.providerReferences).toHaveLength(2); // One image per run, even with the same explicit selection.
    stopPage();
  });

  it("accepts a new connected-camera run after the cached claim expires without renewing an explicit old claim", async () => {
    let clock = Date.parse(NOW);
    const harness = await openHarness({ realTask: true, now: () => new Date(clock).toISOString() });
    const room = await harness.service.sync!.registry.resolve(CANVAS_ID);
    const canvas = await canonical(harness);
    expect((await room!.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: CANVAS_ID,
      commandId: "connect-aged-camera", actorId: "test", baseRevision: canvas.revision,
      commands: [{ type: "edge.add", edge: { id: "camera-input", source: "camera-card", target: "image-node" } }]
    })).ok).toBe(true);
    const stopPage = emulatePage(harness);
    const frozen = await harness.capture.freezeForGeneration({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    clock += 11 * 60_000;
    const server = await startServer(harness);
    const request = {
      nodeId: "image-node", runId: "run-aged-camera", jobId: "job-aged-camera",
      modelKey: "p:m", prompt: "draw", parameters: {}
    };
    const run = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, request);
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    expect(harness.providerReferences).toEqual([{
      role: "reference_image", storageKey: frozen.binding.media.storageKey,
      mediaType: "image/png", mediaKind: "image"
    }]);
    const repeated = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, request);
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(202);
    // Acknowledgement recovery returns the original acceptance without preparing
    // inputs or submitting the same paid run a second time.
    expect(harness.providerReferences).toHaveLength(1);
    const rejected = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      ...request, runId: "run-expired-explicit", jobId: "job-expired-explicit", worldCapture: frozen.binding
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("COMMAND_REJECTED");
    expect(rejected.body.message).toContain("取景冻结结果已过期");
    expect(harness.providerReferences).toHaveLength(1);
    expect((await canonical(harness)).jobs.map(job => job.id)).toEqual(["job-aged-camera"]);
    stopPage();
  });

  it("freezes a page-rendered image through prepare/commit and rejects a stale render", async () => {
    let clock = Date.parse(NOW);
    const harness = await openHarness({ realTask: true, now: () => new Date(clock).toISOString() });
    const server = await startServer(harness);
    const prepared = await post(server.base, `/api/canvases/${CANVAS_ID}/captures-page-prepare`, { cameraId: CAMERA_ID });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const { key, width, height, attemptId } = prepared.body as { key: unknown; width: number; height: number; attemptId: string };

    const pngBase64 = Buffer.from(pngBytes(width, height)).toString("base64");
    const commit = await post(server.base, `/api/canvases/${CANVAS_ID}/captures-page-commit`, {
      cameraId: CAMERA_ID, attemptId, key, pngBase64, width, height
    });
    expect(commit.status, JSON.stringify(commit.body)).toBe(200);
    expect((commit.body as { binding?: { key?: { cameraId?: string } } }).binding?.key?.cameraId).toBe(CAMERA_ID);

    clock += 11 * 60_000;
    const nextCommit = await post(server.base, `/api/canvases/${CANVAS_ID}/captures-page-commit`, {
      cameraId: CAMERA_ID, attemptId, key, pngBase64, width, height
    });
    expect(nextCommit.status, JSON.stringify(nextCommit.body)).toBe(200);
    expect(nextCommit.body.binding.requestId).not.toBe(commit.body.binding.requestId);
    expect(nextCommit.body.binding.media).toEqual(commit.body.binding.media);
    const run = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      nodeId: "image-node", runId: "run-page-refreeze", jobId: "job-page-refreeze",
      modelKey: "p:m", prompt: "draw", parameters: {}, worldCapture: nextCommit.body.binding
    });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    expect(harness.providerReferences).toHaveLength(1);

    // An authoring change invalidates the rendered framing: the stale commit must be
    // rejected instead of freezing a picture of the old world.
    await patchModelScript(harness, "model-a", "scene.box({ id: 'body', size: [4, 4, 4] });");
    const stale = await post(server.base, `/api/canvases/${CANVAS_ID}/captures-page-commit`, {
      cameraId: CAMERA_ID, attemptId, key, pngBase64, width, height
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect((stale.body as { code?: string }).code).toBe("superseded");
  });

  it("rejects an old page attempt after a same-version retry, including a late media save", async () => {
    const gate = deferred<void>();
    let saving = false;
    const harness = await openHarness({ saveDelay: async () => { saving = true; await gate.promise; } });
    const prepared = await harness.capture.preparePageCapture({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    if (!prepared.ok) throw new Error(prepared.message);
    const input = { canvasId: CANVAS_ID, cameraId: CAMERA_ID, attemptId: prepared.attemptId,
      key: prepared.key, png: pngBytes(prepared.width, prepared.height), width: prepared.width, height: prepared.height };
    const commit = harness.capture.commitPageCapture(input);
    await waitFor(() => saving);
    await harness.capture.refresh({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    const current = harness.capture.pendingPageCaptures(CANVAS_ID)[0]!;
    expect(current.key).toEqual(prepared.key);
    expect(current.attemptId).not.toBe(prepared.attemptId);
    gate.resolve();
    expect(await commit).toMatchObject({ ok: false, code: "superseded" });
    expect(await harness.capture.commitPageCapture(input)).toMatchObject({ ok: false, code: "superseded" });
    expect(harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID }).phase).not.toBe("ready");
    expect(harness.taskSubmits).toHaveLength(0);
  });

  it("rejects a page render when canonical content changes during media saving", async () => {
    const gate = deferred<void>();
    let saving = false;
    const harness = await openHarness({ saveDelay: async () => { saving = true; await gate.promise; } });
    const prepared = await harness.capture.preparePageCapture({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    if (!prepared.ok) throw new Error(prepared.message);
    const commit = harness.capture.commitPageCapture({ canvasId: CANVAS_ID, cameraId: CAMERA_ID,
      key: prepared.key, png: pngBytes(prepared.width, prepared.height), width: prepared.width, height: prepared.height });
    await waitFor(() => saving);
    await patchModelScript(harness, "model-a", "scene.box({ id: 'body', size: [5, 5, 5] });");
    gate.resolve();
    expect(await commit).toMatchObject({ ok: false, code: "superseded" });
    const status = harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(status.key?.worldContentVersion).not.toBe(prepared.key.worldContentVersion);
    expect(status.phase).not.toBe("ready");
    expect(harness.taskSubmits).toHaveLength(0);
  });

  it("rejects a page capture whose pixel size does not match the canonical output", async () => {
    const harness = await openHarness({ realTask: true });
    const server = await startServer(harness);
    const prepared = await post(server.base, `/api/canvases/${CANVAS_ID}/captures-page-prepare`, { cameraId: CAMERA_ID });
    const { key, width, height, attemptId } = prepared.body as { key: unknown; width: number; height: number; attemptId: string };
    const wrong = await post(server.base, `/api/canvases/${CANVAS_ID}/captures-page-commit`, {
      cameraId: CAMERA_ID, attemptId, key,
      pngBase64: Buffer.from(pngBytes(Math.max(1, width - 8), height)).toString("base64"),
      width: Math.max(1, width - 8), height
    });
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(400);
  });


  it("leaves ordinary generation independent of unrelated camera cards", async () => {
    const harness = await openHarness({ realTask: true });
    const server = await startServer(harness);
    const run = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      nodeId: "image-node", runId: "run-ordinary", jobId: "job-ordinary", modelKey: "p:m", prompt: "draw", parameters: {}
    });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    expect(harness.providerReferences).toEqual([]);
  });

  it("fails closed without accepting a job when no page renders the connected camera", async () => {
    const harness = await openHarness();
    const room = await harness.service.sync!.registry.resolve(CANVAS_ID);
    const canvas = await canonical(harness);
    expect((await room!.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: CANVAS_ID,
      commandId: "connect-unavailable", actorId: "test", baseRevision: canvas.revision,
      commands: [{ type: "edge.add", edge: { id: "camera-input", source: "camera-card", target: "image-node" } }]
    })).ok).toBe(true);
    const server = await startServer(harness);
    const run = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      nodeId: "image-node", runId: "run-unavailable", jobId: "job-unavailable", modelKey: "m", prompt: "draw", parameters: {}
    });
    // 页面未渲染 → 冻结等待超时，明确拒绝，不产生伪造取景或任务。
    expect(run.status).toBe(400);
    expect((run.body as { message?: string }).message).toContain("取景");
    expect(harness.taskSubmits).toHaveLength(0);
    expect((await canonical(harness)).jobs).toHaveLength(0);
  });

  it("refreshes on canonical authoring changes only, coalesces, and rejects stale image/media results", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<WorldCaptureProducerOutcome>>>();
    const harness = await openHarness();
    const { calls } = registerProducer(harness.capture, request => {
      const slot = deferred<WorldCaptureProducerOutcome>();
      pending.set(request.key.worldContentVersion, slot);
      return slot.promise;
    });

    // A slow initial capture; then two rapid canonical changes must leave only the
    // latest key in flight.
    const first = harness.capture.refresh({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    await waitFor(() => calls.length === 1);
    const keyA = calls[0]!.key;

    await patchModelScript(harness, "model-a", "scene.box({ id: 'body', size: [3, 3, 3] });");
    await waitFor(() => calls.length === 2);
    const keyB = calls[1]!.key;
    // Card moves and viewport-like layout changes are not authoring changes.
    const room = await harness.service.sync!.registry.resolve(CANVAS_ID);
    const before = await canonical(harness);
    await room!.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: CANVAS_ID,
      commandId: "move-cards",
      actorId: "test",
      baseRevision: before.revision,
      commands: [
        { type: "node.update", nodeId: "camera-card", position: { x: 50, y: 60 } },
        { type: "node.update", nodeId: "model-a", position: { x: 10, y: 20 } }
      ]
    } as never);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toHaveLength(2);

    await patchModelScript(harness, "model-a", "scene.box({ id: 'body', size: [4, 4, 4] });");
    await waitFor(() => calls.length === 3);
    const keyC = calls[2]!.key;
    expect(new Set([keyA.worldContentVersion, keyB.worldContentVersion, keyC.worldContentVersion]).size).toBe(3);

    pending.get(keyC.worldContentVersion)!.resolve(imageOutcome(calls[2]!));
    await waitFor(() => harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID }).phase === "ready");
    const readyKey = harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID }).key!;
    expect(readyKey.worldContentVersion).toBe(keyC.worldContentVersion);

    // Late old image must not overwrite the current framing.
    pending.get(keyA.worldContentVersion)!.resolve(imageOutcome(calls[0]!));
    pending.get(keyB.worldContentVersion)?.resolve(imageOutcome(calls[1]!));
    await first;
    const afterLate = harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(afterLate.key!.worldContentVersion).toBe(keyC.worldContentVersion);
    expect(afterLate.stale).toBe(false);
    expect(afterLate.input?.key.worldContentVersion).toBe(keyC.worldContentVersion);
  });

  it("keeps the exact pinned model content and never renders a missing bound target", async () => {
    const harness = await openHarness();
    const { calls } = registerProducer(harness.capture);
    await harness.capture.refresh({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    const first = calls[0]!;
    expect(first.subject.kind).toBe("world");
    if (first.subject.kind === "world") {
      expect(first.subject.contents).toHaveLength(2);
      const body = first.subject.contents.find(content => content.instanceId === INSTANCE_A)!;
      expect(body.content.kind).toBe("script");
      if (body.content.kind === "script") {
        expect(body.content.definition.modelScript).toContain("size: [2, 2, 2]");
      }
    }
    const firstFingerprint = first.contentFingerprint;

    await patchModelScript(harness, "model-a", "scene.box({ id: 'body', size: [7, 7, 7] });");
    await waitFor(() => calls.length === 2);
    const second = calls[1]!;
    expect(second.contentFingerprint).not.toBe(firstFingerprint);
    if (second.subject.kind === "world") {
      const body = second.subject.contents.find(content => content.instanceId === INSTANCE_A)!;
      expect(body.content.kind === "script" && body.content.definition.modelScript).toContain("size: [7, 7, 7]");
    }

    // A missing binding is explicit; the producer is not called and no world fallback
    // image may be accepted.
    await patchNodeData(harness, "camera-card", {
      worldCamera: { ...cameraData(), boundInstanceId: "missing-instance" }
    });
    await waitFor(() => harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID }).reason === "bound-target-missing");
    const status = harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(status.phase).toBe("unavailable");
    expect(status.input?.key.worldContentVersion).toBe(second.key.worldContentVersion);
    expect(status.stale).toBe(true);
    expect(calls).toHaveLength(2);
    const frozen = await harness.capture.freezeForGeneration({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.code).toBe("capture-unavailable");
  });

  it("freezes at click time through the real HTTP entry and never rewrites accepted input", async () => {
    const harness = await openHarness();
    registerProducer(harness.capture);
    await harness.capture.refresh({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    const server = await startServer(harness);

    const frozen = await post(server.base, `/api/canvases/${CANVAS_ID}/captures-freeze`, {
      cameraId: CAMERA_ID,
      requestId: "generation-capture-1"
    });
    expect(frozen.status).toBe(200);
    expect(frozen.body.ok).toBe(true);
    const binding = frozen.body.binding;
    expect(binding.input.mediaId).toBeTruthy();
    const stored = await harness.media.port().verify(binding.input.mediaId, {
      checksum: binding.input.checksum
    });
    expect(stored).toMatchObject({ exists: true, matches: true });

    const run = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      nodeId: "image-node",
      runId: "run-capture-1",
      jobId: "job-capture-1",
      modelKey: "m",
      prompt: "draw",
      parameters: {},
      worldCapture: binding
    });
    expect(run.status).toBe(202);
    expect(harness.taskSubmits).toHaveLength(1);
    expect(harness.taskSubmits[0]!.worldCapture).toEqual(binding);
    const job = (await canonical(harness)).jobs.find(entry => entry.id === "job-capture-1")!;
    expect(job.worldCapture).toEqual(binding);

    // Later world changes do not rewrite the accepted run input.
    await patchModelScript(harness, "model-b", "scene.box({ id: 'body', size: [9, 9, 9] });");
    await waitFor(() => harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID }).key!.worldContentVersion !== binding.key.worldContentVersion);
    const after = (await canonical(harness)).jobs.find(entry => entry.id === "job-capture-1")!;
    expect(after.worldCapture).toEqual(binding);
    expect(harness.taskSubmits[0]!.worldCapture).toEqual(binding);

    // A forged/expired binding is rejected before any run is accepted.
    const forged = {
      ...binding,
      input: { ...binding.input, checksum: "f".repeat(64) }
    };
    const rejected = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      nodeId: "image-node",
      runId: "run-capture-forged",
      jobId: "job-capture-forged",
      modelKey: "m",
      prompt: "draw",
      parameters: {},
      worldCapture: forged
    });
    expect(rejected.status).toBe(400);
    expect(harness.taskSubmits).toHaveLength(1);
    expect((await canonical(harness)).jobs.some(entry => entry.id === "job-capture-forged")).toBe(false);
  });

  it("materializes the frozen capture as a real Task reference input for the Provider", async () => {
    const harness = await openHarness({ realTask: true });
    registerProducer(harness.capture);
    await harness.capture.refresh({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    const server = await startServer(harness);

    const frozen = await post(server.base, `/api/canvases/${CANVAS_ID}/captures-freeze`, {
      cameraId: CAMERA_ID,
      requestId: "generation-capture-provider"
    });
    expect(frozen.status).toBe(200);
    const binding = frozen.body.binding;

    const run = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      nodeId: "image-node",
      runId: "run-capture-provider",
      jobId: "job-capture-provider",
      modelKey: "p:m",
      prompt: "draw",
      parameters: {},
      worldCapture: binding
    });
    expect(run.status).toBe(202);

    // The real Task Service decode -> capability -> media verify -> Provider materialization
    // path must see the exact frozen bytes, not only the worldCapture metadata.
    expect(harness.providerReferences).toEqual([{
      role: "reference_image",
      storageKey: binding.media.storageKey,
      mediaType: binding.media.contentType,
      mediaKind: "image"
    }]);
    const job = (await canonical(harness)).jobs.find(entry => entry.id === "job-capture-provider")!;
    expect(job.worldCapture).toEqual(binding);
  });

  it("rejects a model that cannot accept the framing reference before acceptance", async () => {
    const harness = await openHarness({ captureUnsupported: true });
    registerProducer(harness.capture);
    await harness.capture.refresh({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    const server = await startServer(harness);
    const frozen = await post(server.base, `/api/canvases/${CANVAS_ID}/captures-freeze`, {
      cameraId: CAMERA_ID,
      requestId: "generation-capture-unsupported"
    });
    expect(frozen.status).toBe(200);

    const run = await post(server.base, `/api/canvases/${CANVAS_ID}/runs`, {
      nodeId: "image-node",
      runId: "run-capture-unsupported",
      jobId: "job-capture-unsupported",
      modelKey: "m",
      prompt: "draw",
      parameters: {},
      worldCapture: frozen.body.binding
    });
    expect(run.status).toBe(400);
    expect(harness.taskSubmits).toHaveLength(0);
    const canvas = await canonical(harness);
    expect(canvas.jobs.some(entry => entry.id === "job-capture-unsupported")).toBe(false);
  });

  it("settles superseded waits and ignores late resource notices without retargeting", async () => {
    const harness = await openHarness();
    let waitingFirst = true;
    const gates: Array<ReturnType<typeof deferred<WorldCaptureProducerOutcome>>> = [];
    const { calls } = registerProducer(harness.capture, async request => {
      if (waitingFirst) {
        waitingFirst = false;
        return {
          status: "waiting",
          requestId: request.requestId,
          key: request.key,
          contentFingerprint: request.contentFingerprint,
          reason: "resources-not-ready"
        };
      }
      const gate = deferred<WorldCaptureProducerOutcome>();
      gates.push(gate);
      return gate.promise;
    });

    await harness.capture.refresh({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    const firstRequestId = calls[0]!.requestId;
    expect(harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID }).phase).toBe("waiting");

    // A canonical change starts a new attempt; a late resource notice for the old
    // request must not refresh or retarget it.
    await patchModelScript(harness, "model-a", "scene.box({ id: 'body', size: [6, 6, 6] });");
    await waitFor(() => calls.length === 2);
    harness.capture.notifyResourcesReady({
      canvasId: CANVAS_ID,
      cameraId: CAMERA_ID,
      requestId: firstRequestId
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toHaveLength(2);

    // A wait pinned to one key becomes explicitly superseded when the world changes.
    const pendingFreeze = harness.capture.freezeForGeneration({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    await waitFor(() => gates.length === 1);
    await patchModelScript(harness, "model-b", "scene.box({ id: 'body', size: [8, 8, 8] });");
    const frozen = await pendingFreeze;
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) {
      expect(frozen.code).toBe("superseded");
      expect(frozen.requestedKey).toBeDefined();
      expect(frozen.currentKey).toBeDefined();
    }
    for (const gate of gates) gate.resolve(imageOutcome(calls[calls.length - 1]!));
    await new Promise(resolve => setTimeout(resolve, 20));

    harness.capture.forgetCanvas(CANVAS_ID);
    const forgotten = harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(forgotten.phase).toBe("empty");
    expect(forgotten.input).toBeUndefined();
  });

  it("rejects late media receipts and fails closed without a producer or a successful save", async () => {
    const saveGate = deferred<void>();
    let delayedVersion: string | null = null;
    const harness = await openHarness({
      saveDelay: async key => {
        if (delayedVersion === null) delayedVersion = key;
        if (key === delayedVersion) await saveGate.promise;
      }
    });
    registerProducer(harness.capture);
    const first = harness.capture.refresh({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    await waitFor(() => delayedVersion !== null);
    const oldVersion = delayedVersion!;

    await patchModelScript(harness, "model-a", "scene.box({ id: 'body', size: [5, 5, 5] });");
    await waitFor(() => {
      const status = harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
      return status.phase === "ready" && status.key?.worldContentVersion !== oldVersion;
    });
    saveGate.resolve();
    await first;
    const current = harness.capture.status({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(current.key!.worldContentVersion).not.toBe(oldVersion);
    expect(current.phase).toBe("ready");
    expect(current.stale).toBe(false);

    // 页面驱动：没有页面渲染时宿主只登记待取景并等待；超时明确失败，不伪成功。
    const pageLess = await openHarness();
    const pendingRefresh = await pageLess.capture.refresh({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(pendingRefresh.ok).toBe(true);
    if (pendingRefresh.ok) expect(pendingRefresh.status.phase).toBe("waiting");
    expect(pageLess.capture.pendingPageCaptures(CANVAS_ID).map(entry => entry.cameraId)).toContain(CAMERA_ID);
    const frozen = await pageLess.capture.freezeForGeneration({ canvasId: CANVAS_ID, cameraId: CAMERA_ID });
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.code).toBe("timeout");
  });
});
