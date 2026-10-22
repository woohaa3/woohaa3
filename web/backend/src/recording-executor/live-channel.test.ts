import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { RECORDING_PROTOCOL_VERSION, type ContentRecordingSnapshot } from "@woohaa3/contracts";
import { createRecordingExecutorChannel } from "./channel.js";
import { connectRecordingExecutor } from "./client.js";
import { createExecutorDispatcher } from "./dispatcher.js";
import { recordingAttemptDirectory, stageRecordingResources } from "./attempt-files.js";

it("dispatches through a registered real socket and receives the full terminal payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "wo-channel-"));
  const channel = (await createRecordingExecutorChannel({ env: { WOOHAA3_RECORDING_RUNTIME_ROOT: root }, checkoutDirectory: "/test/recording" }))!;
  const identity = { jobId: "j", attemptId: "a", executorInstanceId: "executor", executionEpoch: 1, snapshotHash: "hash", contentIdentity: "content", profileKey: "profile" };
  const client = connectRecordingExecutor({ socketPath: channel.socketPath, noncePath: channel.noncePath,
    capability: { executorInstanceId: "executor", checkoutId: channel.checkoutId, protocolVersion: RECORDING_PROTOCOL_VERSION,
      supportedProtocolVersions: [RECORDING_PROTOCOL_VERSION], snapshotSchemaVersion: "s1", rendererVersion: "r1", compilerVersion: "c1", codecVersion: "k1", colorRevision: "col1", gpuAdapter: "test protocol only", softwareAdapter: false },
    onTerminate: () => undefined,
    onMessage: message => {
      if (message.payloadName !== "submitJob") return;
      client.send({ protocolVersion: RECORDING_PROTOCOL_VERSION, sequence: "2", stateChanged: {
        job: message.payload.job, state: "RECORDING_JOB_STATE_SUCCEEDED", artifact: {
          path: "/private/test.mp4", contentSha256: "a".repeat(64), sizeBytes: "100", width: 64, height: 48,
          frameCount: "6", durationNumer: "1", durationDenom: "5", mimeType: "video/mp4"
        }
      }});
    }
  });
  try {
    expect(await client.registered).toMatchObject({ ok: true });
    let sequence = 0;
    const dispatch = createExecutorDispatcher({ send: message => channel.sendControl(message), subscribe: listener => channel.onControl(listener), nextSequence: () => ++sequence });
    const snapshot = { profile: { profileKey: "profile", width: 64, height: 48 }, timing: { frameRateNumer: 30, frameRateDenom: 1, durationNumer: 1, durationDenom: 5 }, sceneIrJson: "{}", motionJson: "{}", resources: [] } as unknown as ContentRecordingSnapshot;
    const result = await dispatch({ identity, snapshot, purpose: "export", leaseMs: 30000, signal: new AbortController().signal, onProgress: () => undefined });
    expect(result).toMatchObject({ ok: true, claim: { path: "/private/test.mp4", frameCount: 6 } });
    expect(client.send({ protocolVersion: RECORDING_PROTOCOL_VERSION, sequence: "3", leaseHeartbeat: { executorInstanceId: "executor" } })).toBe(true);
    await client.close();
    await vi.waitFor(() => expect(channel.executorCount()).toBe(0));
  } finally { await client.close(); await channel.close(); await rm(root, { recursive: true, force: true }); }
});

it("stages verified bytes under generated filenames and rejects changed media", async () => {
  const root = await mkdtemp(join(tmpdir(), "wo-stage-"));
  const bytes = new Uint8Array([1, 2, 3]);
  const snapshot = { origin: { canvasId: "canvas-rec" }, resources: [{ resourceId: "../../outside", storageKey: "stable", sizeBytes: 3, contentType: "image/png", checksum: createHash("sha256").update(bytes).digest("hex") }] } as unknown as ContentRecordingSnapshot;
  const directory = recordingAttemptDirectory(root, "../../attempt");
  const reads: Array<{ storageKey: string; canvasId?: string }> = [];
  try {
    await stageRecordingResources({ directory, snapshot, signal: new AbortController().signal, read: async (storageKey, canvasId) => { reads.push({ storageKey, ...(canvasId !== undefined ? { canvasId } : {}) }); return { bytes, contentType: "image/png" }; } });
    // 素材读取必须带快照冻结的画布作用域：远端画布的字节只在托管存储里，丢了就会去主存储找。
    expect(reads).toEqual([{ storageKey: "stable", canvasId: "canvas-rec" }]);
    expect(await readFile(join(directory, "resource-0.bin"))).toEqual(Buffer.from(bytes));
    await expect(stageRecordingResources({ directory: join(root, "changed"), snapshot, signal: new AbortController().signal, read: async () => ({ bytes: new Uint8Array([3, 2, 1]), contentType: "image/png" }) })).rejects.toThrow("冻结身份不符");
  } finally { await rm(root, { recursive: true, force: true }); }
});
