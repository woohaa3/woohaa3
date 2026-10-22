/**
 * 宿主录制服务：submit / cancel / status 的端到端行为（任务 6.1 / 6.3 / 7.1）。
 *
 * 用真实协调器 + 真实提交计划 + 真实宿主复核，只把「执行器派发」「Media 上传」
 * 「画布读写」换成可控替身；不需要 GPU。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasCommand, ContentRecordingSnapshot } from "@woohaa3/contracts";
import {
  HostRecordingService,
  type RecordingCanvasReader,
  type RecordingDispatcher,
  type RecordingUploader
} from "./host-service.js";
import { validateArtifactClaim } from "./finalize.js";

const CHECKSUM = "d".repeat(64);

function snapshot(): ContentRecordingSnapshot {
  return {
    schemaVersion: "woohaa-recording-snapshot-v1",
    compilerVersion: "c1",
    rendererVersion: "r1",
    origin: {
      canvasId: "c1",
      nodeId: "film",
      clipId: "clip-1",
      sourceIdentity: "src",
      canvasRevision: 3,
      sourceIncarnation: "inc-1"
    },
    profile: {
      profileKey: "native-v1",
      container: "mp4",
      codec: "h264",
      width: 1280,
      height: 720,
      bitrate: 4_000_000,
      fastStart: true,
      includeAudio: false,
      rendererVersion: "r1",
      compilerVersion: "c1",
      codecVersion: "k1",
      colorRevision: "col1"
    },
    timing: { frameRateNumer: 30, frameRateDenom: 1, durationNumer: 120, durationDenom: 30 },
    sceneIrJson: "{}",
    motionJson: "{}",
    initialCamera: { azimuth: 0, elevation: 0.5, distance: 4, focusOffset: [0, 0, 0] },
    aspect: "16:9",
    background: "#000000",
    resources: []
  };
}

let cachedArtifact: Uint8Array | null = null;

/** 最小 Fast Start H.264 MP4（够宿主复核解析）。缓存同一实例，保证 sha 与写入字节一致。 */
function artifactBytes(): Uint8Array {
  if (cachedArtifact) return cachedArtifact;
  const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  const u16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
  const box = (type: string, payload: number[]) => [
    ...u32(8 + payload.length),
    ...[...type].map(character => character.charCodeAt(0)),
    ...payload
  ];
  const fullBox = (type: string, flags: number, payload: number[]) =>
    box(type, [0, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff, ...payload]);
  const avcC = box("avcC", [1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, ...u16(2), 0x67, 0x42, 1, ...u16(1), 0x68]);
  const avc1 = box("avc1", [
    ...Array(6).fill(0), ...u16(1), ...Array(16).fill(0),
    ...u16(1280), ...u16(720),
    ...u32(0x0048_0000), ...u32(0x0048_0000), ...u32(0), ...u16(1),
    ...Array(32).fill(0), ...u16(0x18), ...u16(0xffff), ...avcC
  ]);
  const stbl = box("stbl", [
    ...fullBox("stsd", 0, [...u32(1), ...avc1]),
    ...fullBox("stts", 0, [...u32(1), ...u32(120), ...u32(1)]),
    ...fullBox("stsc", 0, [...u32(1), ...u32(1), ...u32(1), ...u32(1)]),
    ...fullBox("stsz", 0, [...u32(0), ...u32(120), ...Array(120).fill(0).flatMap(() => u32(4))]),
    ...fullBox("stco", 0, [...u32(1), ...u32(0)])
  ]);
  const minf = box("minf", [...fullBox("vmhd", 1, Array(8).fill(0)), ...stbl]);
  const mdia = box("mdia", [
    ...fullBox("mdhd", 0, [...u32(0), ...u32(0), ...u32(30), ...u32(120), ...u16(0x55c4), ...u16(0)]),
    ...fullBox("hdlr", 0, [
      ...u32(0), ...[..."vide"].map(character => character.charCodeAt(0)),
      ...Array(12).fill(0), ...[..."VideoHandler\u0000"].map(character => character.charCodeAt(0))
    ]),
    ...minf
  ]);
  const tkhd = fullBox("tkhd", 3, [
    ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(120),
    ...Array(8).fill(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0x0001_0000), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0x0001_0000), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0x4000_0000),
    ...u32(1280 * 65_536), ...u32(720 * 65_536)
  ]);
  const moov = box("moov", [
    ...fullBox("mvhd", 0, [
      ...u32(0), ...u32(0), ...u32(30), ...u32(120),
      ...u32(0x0001_0000), ...u16(0x0100), ...Array(10).fill(0),
      ...u32(0x0001_0000), ...u32(0), ...u32(0),
      ...u32(0), ...u32(0x0001_0000), ...u32(0),
      ...u32(0), ...u32(0), ...u32(0x4000_0000),
      ...Array(24).fill(0), ...u32(2)
    ]),
    ...box("trak", [...tkhd, ...mdia])
  ]);
  const ftyp = box("ftyp", [...[..."isom"].map(c => c.charCodeAt(0)), ...u32(0x200), ...[..."isom"].map(c => c.charCodeAt(0))]);
  cachedArtifact = new Uint8Array([...ftyp, ...moov, ...box("mdat", [...u32(4), 1, 2, 3, 4])]);
  return cachedArtifact;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wo-host-rec-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runtime(options: { failFreeze?: boolean } = {}) {
  return {
    recording: {
      matches: () => true,
      freeze: async () =>
        options.failFreeze
          ? { ok: false as const, code: "recording-source-invalid", message: "源无效" }
          : { ok: true as const, snapshot: snapshot() },
      planCommit: async (input: { purpose: string; title: string }) => {
        const commands: CanvasCommand[] = [
          { type: "asset.upsert", asset: { id: "asset-1" } as never }
        ];
        if (input.purpose === "export") {
          commands.push({ type: "node.add", node: { id: "node-1" } as never });
          return { ok: true as const, commands, commandId: "cmd-1", nodeId: "node-1" };
        }
        return { ok: true as const, commands, commandId: "cmd-ref" };
      },
      describe: () => ({ title: "片场 · 镜头 1", duration: 4, aspect: "16:9" })
    }
  };
}

function canvasReader(overrides: Partial<RecordingCanvasReader> = {}): RecordingCanvasReader {
  return {
    read: async () => ({
      ok: true,
      revision: 3,
      assets: [],
      nodeData: { filmSetContent: {} },
      sourceIncarnation: "inc-1",
      layout: { x: 0, y: 0, width: 320 },
      writable: true
    }),
    currentLayout: async () => ({ x: 100, y: 20, width: 320 }),
    submit: async () => ({ ok: true, duplicate: false }),
    ...overrides
  };
}

function uploader(): RecordingUploader {
  return async ({ sizeBytes }) => ({
    ok: true,
    artifact: { storageKey: `sha256-${CHECKSUM}`, checksum: CHECKSUM, contentType: "video/mp4", size: sizeBytes }
  });
}

function dispatcher(savings: { path: string; sha: string }): RecordingDispatcher {
  return async input => {
    const bytes = artifactBytes();
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(bytes).digest("hex");
    // 声明必须与真实字节一致（宿主会重算并比对 hash）。
    const path = join(root, `${input.identity.attemptId}.mp4`);
    writeFileSync(path, bytes);
    savings.path = path;
    savings.sha = sha;
    input.onProgress(10, 120);
    return {
      ok: true,
      claim: {
        path,
        sizeBytes: bytes.byteLength,
        contentSha256: sha,
        width: 1280,
        height: 720,
        durationSeconds: 4,
        frameCount: 120,
        mimeType: "video/mp4"
      }
    };
  };
}

function service(options: {
  dispatch?: RecordingDispatcher;
  canvas?: RecordingCanvasReader;
  runtime?: ReturnType<typeof runtime>;
  executorAvailable?: boolean;
} = {}) {
  const savings = { path: "", sha: "" };
  const executor = options.executorAvailable === false
    ? null
    : ({
        available: true,
        registry: {
          list: () => [
            {
              capability: { executorInstanceId: "exec-1", softwareAdapter: false, gpuAdapter: "Apple M4 Pro" },
              executionEpoch: 1
            }
          ]
        }
      } as never);
  const instance = new HostRecordingService({
    runtime: (options.runtime ?? runtime()) as never,
    canvas: options.canvas ?? canvasReader(),
    upload: uploader(),
    dispatch: options.dispatch ?? dispatcher(savings),
    executor,
    now: () => 1_000
  });
  return { instance, savings };
}

const body = {
  requestId: "req-1",
  purpose: "export" as const,
  nodeId: "film",
  clipId: "clip-1",
  profileKey: "native-v1",
  displayVersion: "v3"
};

describe("HostRecordingService.submit", () => {
  it("accepts a job and reports queued state immediately", async () => {
    const { instance } = service();
    const result = await instance.submit({ canvasId: "c1", body });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toBe("queued");
    expect(result.duplicate).toBe(false);
    expect(result.jobId).toBe("recording-req-1");
  });

  it("is idempotent per requestId", async () => {
    const { instance } = service();
    const first = await instance.submit({ canvasId: "c1", body });
    const second = await instance.submit({ canvasId: "c1", body });
    if (!first.ok || !second.ok) throw new Error("submit failed");
    expect(second.duplicate).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(instance.jobs()).toHaveLength(1);
  });

  it("reports executor-unavailable instead of silently degrading", async () => {
    const { instance } = service({ executorAvailable: false });
    const result = await instance.submit({ canvasId: "c1", body });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("recording-executor-unavailable");
  });

  it("reports recording-unavailable when the extension has no recording port", async () => {
    const instance = new HostRecordingService({
      runtime: {} as never,
      canvas: canvasReader(),
      upload: uploader(),
      dispatch: dispatcher({ path: "", sha: "" }),
      executor: null
    });
    const result = await instance.submit({ canvasId: "c1", body });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("recording-unavailable");
  });

  it("surfaces a freeze failure instead of queueing", async () => {
    const { instance } = service({ runtime: runtime({ failFreeze: true }) });
    const result = await instance.submit({ canvasId: "c1", body });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("recording-source-invalid");
    expect(instance.jobs()).toHaveLength(0);
  });
});

describe("HostRecordingService status and completion", () => {
  it("reaches succeeded with a verified artifact and clears the context", async () => {
    const { instance } = service();
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit failed");
    await vi.waitFor(async () => {
      const result = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
      expect(result.ok && result.status.state).toBe("succeeded");
    });
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status.error?.message ?? "none").toBe("none");
    expect(status.status.state).toBe("succeeded");
    expect(status.status.submittedVersion).toBe("v3");
  });

  it("exposes the frozen display title so the activity mirror does not invent one", async () => {
    const { instance } = service();
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit failed");
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    expect(status.ok && status.status.title).toBe("片场 · 镜头 1");
    const listed = await instance.list({ canvasId: "c1" });
    expect(listed.map(entry => entry.title)).toEqual(["片场 · 镜头 1"]);
  });

  it("passes the frozen downstream reference identity through the host commit", async () => {
    const identity = { contentIdentity: "downstream-content", profileKey: "downstream-profile" };
    const recordingRuntime = runtime();
    recordingRuntime.recording.freeze = async () => ({ ok: true as const, snapshot: snapshot(), referenceIdentity: identity });
    const commit = vi.spyOn(recordingRuntime.recording, "planCommit");
    const { instance } = service({ runtime: recordingRuntime });
    const submitted = await instance.submit({ canvasId: "c1", body: { ...body, purpose: "reference" } });
    if (!submitted.ok) throw new Error("submit failed");
    await vi.waitFor(async () => {
      const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
      expect(status.ok && status.status.state).toBe("succeeded");
    });
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ purpose: "reference", referenceIdentity: identity }));
  });

  it("binds the frozen media read to the request canvas scope", async () => {
    const reads: Array<{ storageKey: string; canvasId?: string }> = [];
    const recordingRuntime = runtime();
    // 扩展在 freeze 里通过 canvas.read 读素材；宿主必须把本次画布 id 绑上去。
    // runtime() 的替身把 freeze 声明成零参；这里覆写成消费 canvas.read 的一参版本。
    const freezeWithMedia = async (input: {
      canvas: { read?: (storageKey: string) => Promise<{ bytes: Uint8Array; contentType: string }> };
    }) => {
      await input.canvas.read?.("sha256-" + CHECKSUM);
      const frozen = snapshot();
      return { ok: true as const, snapshot: { ...frozen, origin: { ...frozen.origin, canvasId: "canvas-scope" } } };
    };
    recordingRuntime.recording.freeze = freezeWithMedia as unknown as typeof recordingRuntime.recording.freeze;
    const { instance } = service({
      runtime: recordingRuntime,
      canvas: canvasReader({
        readMedia: async (storageKey, canvasId) => {
          reads.push({ storageKey, ...(canvasId !== undefined ? { canvasId } : {}) });
          return { bytes: new Uint8Array([1]), contentType: "image/png" };
        }
      })
    });
    const submitted = await instance.submit({ canvasId: "canvas-scope", body });
    expect(submitted.ok).toBe(true);
    // 远端画布的素材只在托管存储 <canvasId>/media/<key> 里；作用域不能丢，也不能换成别的 id。
    expect(reads).toEqual([{ storageKey: "sha256-" + CHECKSUM, canvasId: "canvas-scope" }]);
    if (!submitted.ok) return;
    await vi.waitFor(async () => {
      const status = await instance.status({ canvasId: "canvas-scope", jobId: submitted.jobId });
      expect(status.ok && status.status.state).toBe("succeeded");
    });
  });

  it("keeps a failed job's stage and message", async () => {
    const failing: RecordingDispatcher = async () => ({
      ok: false,
      stage: "RECORDING_ERROR_STAGE_FRAME_READY",
      code: "capture-readiness-timeout",
      message: "frame 7 not ready",
      transient: true
    });
    const { instance } = service({ dispatch: failing });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit failed");
    await new Promise(resolve => setTimeout(resolve, 20));
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    if (!status.ok) throw new Error("status failed");
    expect(status.status.state).toBe("failed");
    expect(status.status.error?.code).toBe("capture-readiness-timeout");
    expect(status.status.error?.stage).toBe("RECORDING_ERROR_STAGE_FRAME_READY");
  });

  it("returns unknown-job for another canvas", async () => {
    const { instance } = service();
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit failed");
    const status = await instance.status({ canvasId: "c2", jobId: submitted.jobId });
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.code).toBe("recording-unknown-job");
  });

  it("lists only the current canvas", async () => {
    const { instance } = service();
    await instance.submit({ canvasId: "c1", body });
    expect((await instance.list({ canvasId: "c1" })).length).toBe(1);
    expect(await instance.list({ canvasId: "c2" })).toHaveLength(0);
  });
});

describe("HostRecordingService cancel", () => {
  it("cancels a queued job", async () => {
    const slow: RecordingDispatcher = input =>
      new Promise(resolve => {
        input.signal.addEventListener("abort", () =>
          resolve({ ok: false, stage: "RECORDING_ERROR_STAGE_CAPABILITY", code: "recording-cancelled", message: "cancelled", transient: false })
        );
      });
    const { instance } = service({ dispatch: slow });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit failed");
    const cancelled = await instance.cancel({ canvasId: "c1", jobId: submitted.jobId });
    expect(cancelled).toEqual({ ok: true, cancelled: true });
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    if (!status.ok) throw new Error("status failed");
    expect(status.status.state).toBe("cancelled");
    // 取消会清掉查询上下文，但标题属于任务：浮层仍须拿到真标题。
    expect(status.status.title).toBe("片场 · 镜头 1");
  });

  it("returns too-late once committing started", async () => {
    const { instance } = service();
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit failed");
    await new Promise(resolve => setTimeout(resolve, 20));
    // 已成功 → 不能取消，且不能谎称取消成功。
    const cancelled = await instance.cancel({ canvasId: "c1", jobId: submitted.jobId });
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.code).toBe("recording-too-late");
  });

  it("returns unknown-job for a missing job", async () => {
    const { instance } = service();
    const cancelled = await instance.cancel({ canvasId: "c1", jobId: "nope" });
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.code).toBe("recording-unknown-job");
  });
});

describe("artifact claim validation used by the host gate", () => {
  it("rejects claims whose size exceeds the limit", () => {
    const result = validateArtifactClaim(
      {
        path: "/tmp/x.mp4",
        sizeBytes: 300 * 1024 * 1024,
        contentSha256: CHECKSUM,
        width: 1280,
        height: 720,
        durationSeconds: 4,
        frameCount: 120,
        mimeType: "video/mp4"
      },
      { maxBytes: 256 * 1024 * 1024 }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("recording-artifact-too-large");
  });
});

describe("recording worker queue", () => {
  it("serializes accepted jobs and skips cancelled queued work", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const dispatchArtifact = dispatcher({ path: "", sha: "" });
    let calls = 0;
    const dispatch: RecordingDispatcher = async request => {
      calls += 1;
      if (calls === 1) await gate;
      return dispatchArtifact(request);
    };
    const { instance } = service({ dispatch });
    const first = await instance.submit({ canvasId: "c1", body: { ...body, requestId: "queue-first" } });
    const second = await instance.submit({ canvasId: "c1", body: { ...body, requestId: "queue-second" } });
    const third = await instance.submit({ canvasId: "c1", body: { ...body, requestId: "queue-cancelled" } });
    if (!first.ok || !second.ok || !third.ok) throw new Error("submission failed");
    expect(calls).toBe(1);
    expect(await instance.status({ canvasId: "c1", jobId: second.jobId })).toMatchObject({ ok: true, status: { state: "queued" } });
    await instance.cancel({ canvasId: "c1", jobId: third.jobId });
    release();
    await vi.waitFor(async () => {
      expect(await instance.status({ canvasId: "c1", jobId: second.jobId })).toMatchObject({ ok: true, status: { state: "succeeded" } });
    });
    expect(calls).toBe(2);
    expect(await instance.status({ canvasId: "c1", jobId: third.jobId })).toMatchObject({ ok: true, status: { state: "cancelled" } });
  });
});
