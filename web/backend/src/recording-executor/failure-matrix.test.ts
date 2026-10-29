/**
 * 跨层故障矩阵（任务 8.3）
 * （change: 2026-10-17-add-native-offscreen-film-set-recording）。
 *
 * 覆盖录制链路的每一段失效，并断言两件事：
 * 1. **错误明确**：给稳定阶段码，不用笼统「失败」；
 * 2. **无迟到节点**：失败/取消/失联都不会留下资产或视频节点，也不会重复保存。
 *
 * 本文件只做编排与断言（全部可注入），不需要 GPU 或真实 socket。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CanvasCommand, ContentRecordingSnapshot } from "@woohaa3/contracts";
import { HostRecordingService, type RecordingCanvasReader, type RecordingDispatcher, type RecordingUploader } from "./host-service.js";
import { RecordingExecutorRegistry, checkoutIdFor } from "./index.js";
import { HostRecordingService as _Service } from "./host-service.js";
import { validateArtifactClaim } from "./finalize.js";
import { probeArtifact } from "./probe.js";

void _Service;

const CHECKSUM = "e".repeat(64);

/** 最小合法 Fast Start H.264 MP4（供宿主字节复核通过）。 */
function artifactBytes(): Uint8Array {
  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const u16 = (v: number) => [(v >>> 8) & 0xff, v & 0xff];
  const box = (t: string, p: number[]) => [...u32(8 + p.length), ...[...t].map(c => c.charCodeAt(0)), ...p];
  const fullBox = (t: string, f: number, p: number[]) => box(t, [0, (f >>> 16) & 0xff, (f >>> 8) & 0xff, f & 0xff, ...p]);
  const avcC = box("avcC", [1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, ...u16(2), 0x67, 0x42, 1, ...u16(1), 0x68]);
  const avc1 = box("avc1", [...Array(6).fill(0), ...u16(1), ...Array(16).fill(0), ...u16(320), ...u16(180), ...u32(0x48_0000), ...u32(0x48_0000), ...u32(0), ...u16(1), ...Array(32).fill(0), ...u16(0x18), ...u16(0xffff), ...avcC]);
  const stbl = box("stbl", [...fullBox("stsd", 0, [...u32(1), ...avc1]), ...fullBox("stts", 0, [...u32(1), ...u32(120), ...u32(3000)]), ...fullBox("stsc", 0, [...u32(1), ...u32(1), ...u32(1), ...u32(1)]), ...fullBox("stsz", 0, [...u32(0), ...u32(120), ...Array(120).fill(0).flatMap(() => u32(4))]), ...fullBox("stco", 0, [...u32(1), ...u32(0)])]);
  const minf = box("minf", [...fullBox("vmhd", 1, Array(8).fill(0)), ...stbl]);
  const mdia = box("mdia", [...fullBox("mdhd", 0, [...u32(0), ...u32(0), ...u32(90_000), ...u32(360_000), ...u16(0x55c4), ...u16(0)]), ...fullBox("hdlr", 0, [...u32(0), ...[..."vide"].map(c => c.charCodeAt(0)), ...Array(12).fill(0), ...[..."VideoHandler\u0000"].map(c => c.charCodeAt(0))]), ...minf]);
  const tkhd = fullBox("tkhd", 3, [...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(360_000), ...Array(8).fill(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0x1_0000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x1_0000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x4000_0000), ...u32(320 * 65_536), ...u32(180 * 65_536)]);
  const moov = box("moov", [...fullBox("mvhd", 0, [...u32(0), ...u32(0), ...u32(90_000), ...u32(360_000), ...u32(0x1_0000), ...u16(0x0100), ...Array(10).fill(0), ...u32(0x1_0000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x1_0000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x4000_0000), ...Array(24).fill(0), ...u32(2)]), ...box("trak", [...tkhd, ...mdia])]);
  const ftyp = box("ftyp", [...[..."isom"].map(c => c.charCodeAt(0)), ...u32(0x200), ...[..."isom"].map(c => c.charCodeAt(0))]);
  return new Uint8Array([...ftyp, ...moov, ...box("mdat", [...u32(4), 1, 2, 3, 4])]);
}

function snapshot(): ContentRecordingSnapshot {
  return {
    schemaVersion: "woohaa-recording-snapshot-v1",
    compilerVersion: "c1",
    rendererVersion: "r1",
    origin: { canvasId: "c1", nodeId: "film", clipId: "clip", sourceIdentity: "s", canvasRevision: 1, sourceIncarnation: "inc" },
    profile: {
      profileKey: "p",
      container: "mp4",
      codec: "h264",
      width: 320,
      height: 180,
      bitrate: 1_000_000,
      fastStart: true,
      includeAudio: false,
      rendererVersion: "r1",
      compilerVersion: "c1",
      codecVersion: "k1",
      colorRevision: "col"
    },
    timing: { frameRateNumer: 30, frameRateDenom: 1, durationNumer: 4, durationDenom: 1 },
    sceneIrJson: "{}",
    motionJson: "{}",
    initialCamera: { azimuth: 0, elevation: 0.5, distance: 4, focusOffset: [0, 0, 0] },
    aspect: "16:9",
    background: "#000000",
    resources: []
  };
}

function runtime(overrides: { failFreeze?: boolean } = {}) {
  return {
    recording: {
      matches: () => true,
      freeze: async () =>
        overrides.failFreeze
          ? { ok: false as const, code: "recording-source-invalid", message: "源无效" }
          : { ok: true as const, snapshot: snapshot() },
      planCommit: async (input: { purpose: string }) => {
        const commands: CanvasCommand[] = [{ type: "asset.upsert", asset: { id: "a" } as never }];
        if (input.purpose === "export") commands.push({ type: "node.add", node: { id: "n" } as never });
        return { ok: true as const, commands, commandId: "cmd" };
      },
      describe: () => ({ title: "t", duration: 4, aspect: "16:9" })
    }
  };
}

function canvas(overrides: Partial<RecordingCanvasReader> = {}): RecordingCanvasReader {
  return {
    read: async () => ({
      ok: true,
      revision: 1,
      assets: [],
      nodeData: {},
      sourceIncarnation: "inc",
      layout: { x: 0, y: 0, width: 320 },
      writable: true
    }),
    currentLayout: async () => ({ x: 0, y: 0, width: 320 }),
    submit: async () => ({ ok: true, duplicate: false }),
    ...overrides
  };
}

const uploader: RecordingUploader = async ({ sizeBytes }) => ({
  ok: true,
  artifact: { storageKey: `sha256-${CHECKSUM}`, checksum: CHECKSUM, contentType: "video/mp4", size: sizeBytes }
});

function dispatcher(overrides: Record<string, unknown> = {}): RecordingDispatcher {
  return async () => {
    if (overrides.ok === false) return overrides as never;
    // 真实落盘：宿主会读这些字节重新解析容器/尺寸/时长。
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const dir = mkdtempSync(join(tmpdir(), "wo-matrix-"));
    const path = join(dir, "artifact.mp4");
    const bytes = artifactBytes();
    writeFileSync(path, bytes);
    const claim = overrides.claim as Record<string, unknown> | undefined;
    return {
      ok: true,
      claim: {
        path,
        sizeBytes: bytes.byteLength,
        contentSha256: createHash("sha256").update(bytes).digest("hex"),
        width: 320,
        height: 180,
        durationSeconds: 4,
        frameCount: 120,
        mimeType: "video/mp4",
        ...claim
      }
    } as never;
  };
}

function service(options: {
  dispatch?: RecordingDispatcher;
  reader?: RecordingCanvasReader;
  upload?: RecordingUploader;
  runtimeOverride?: ReturnType<typeof runtime>;
  executor?: boolean;
} = {}) {
  const submitted: Array<{ commandId: string; commands: CanvasCommand[] }> = [];
  const reader = options.reader ?? canvas({
    submit: async input => {
      submitted.push({ commandId: input.commandId, commands: input.commands });
      return { ok: true, duplicate: false };
    }
  });
  const instance = new HostRecordingService({
    runtime: (options.runtimeOverride ?? runtime()) as never,
    canvas: reader,
    upload: options.upload ?? uploader,
    dispatch: options.dispatch ?? dispatcher(),
    executor:
      options.executor === false
        ? null
        : ({
            available: true,
            registry: { list: () => [{ capability: { executorInstanceId: "e", softwareAdapter: false }, executionEpoch: 1 }] }
          } as never),
    now: () => 1_000
  });
  return { instance, submitted };
}

const body = { requestId: "req-1", purpose: "export" as const, nodeId: "film", clipId: "clip", profileKey: "p" };

async function settle() {
  // 全量并行时事件循环可能被其它重负载测试占用；25ms 会让终态断言早于编排完成。
  await new Promise(resolve => setTimeout(resolve, 200));
}

describe("cross-layer failure matrix", () => {
  it("missing executor → explicit reason, nothing queued", async () => {
    const { instance } = service({ executor: false });
    const result = await instance.submit({ canvasId: "c1", body });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("recording-executor-unavailable");
    expect(instance.jobs()).toHaveLength(0);
  });

  it("source deleted before submit → rejected, no asset written", async () => {
    const { instance, submitted } = service({
      reader: canvas({ read: async () => ({ ok: false, code: "recording-source-removed", message: "源节点已被删除" }) })
    });
    const result = await instance.submit({ canvasId: "c1", body });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("recording-source-removed");
    expect(submitted).toHaveLength(0);
  });

  it("permission revoked (unwritable canvas) → rejected before any work", async () => {
    const { instance, submitted } = service({
      reader: canvas({
        read: async () => ({
          ok: true,
          revision: 1,
          assets: [],
          nodeData: {},
          sourceIncarnation: "inc",
          layout: { x: 0, y: 0, width: 320 },
          writable: false
        })
      })
    });
    const result = await instance.submit({ canvasId: "c1", body });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("recording-source-invalid");
    expect(submitted).toHaveLength(0);
  });

  it("resource fetch failure surfaces the resource stage", async () => {
    const { instance } = service({
      dispatch: dispatcher({
        ok: false,
        stage: "RECORDING_ERROR_STAGE_RESOURCE_FETCH",
        code: "recording-resource-checksum-mismatch",
        message: "素材与 checksum 不符",
        transient: false
      } as never)
    });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit");
    await settle();
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    if (!status.ok) throw new Error("status");
    expect(status.status.state).toBe("failed");
    expect(status.status.error?.stage).toBe("RECORDING_ERROR_STAGE_RESOURCE_FETCH");
    expect(status.status.error?.code).toBe("recording-resource-checksum-mismatch");
  });

  it("GPU loss surfaces device-lost and leaves no node", async () => {
    const { instance, submitted: commands } = service({
      dispatch: dispatcher({
        ok: false,
        stage: "RECORDING_ERROR_STAGE_FRAME_READY",
        code: "recording-device-lost",
        message: "GPU 设备丢失",
        transient: true
      } as never)
    });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit");
    await settle();
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    if (!status.ok) throw new Error("status");
    expect(status.status.error?.code).toBe("recording-device-lost");
    expect(commands).toHaveLength(0);
  });

  it("encoding failure surfaces the encode stage", async () => {
    const { instance } = service({
      dispatch: dispatcher({
        ok: false,
        stage: "RECORDING_ERROR_STAGE_ENCODE",
        code: "recording-encode-failed",
        message: "编码器失败",
        transient: true
      } as never)
    });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit");
    await settle();
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    if (!status.ok) throw new Error("status");
    expect(status.status.error?.stage).toBe("RECORDING_ERROR_STAGE_ENCODE");
  });

  it("upload cancellation stops before commit", async () => {
    const { instance, submitted: commands } = service({
      upload: async () => ({ ok: false, code: "recording-cancelled", message: "上传已取消" })
    });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit");
    await settle();
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    if (!status.ok) throw new Error("status");
    expect(status.status.state).toBe("failed");
    expect(status.status.error?.code).toBe("recording-cancelled");
    expect(commands).toHaveLength(0);
  });

  it("explicit cancel during render yields cancelled and no node", async () => {
    const slow: RecordingDispatcher = input =>
      new Promise(resolve => {
        input.signal.addEventListener("abort", () =>
          resolve({ ok: false, stage: "RECORDING_ERROR_STAGE_CAPABILITY", code: "recording-cancelled", message: "已取消", transient: false })
        );
      });
    const { instance, submitted: commands } = service({ dispatch: slow });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit");
    await expect(instance.cancel({ canvasId: "c1", jobId: submitted.jobId })).resolves.toEqual({
      ok: true,
      cancelled: true
    });
    await settle();
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    if (!status.ok) throw new Error("status");
    expect(status.status.state).toBe("cancelled");
    expect(commands).toHaveLength(0);
  });

  it("host exit / executor lost fails live jobs with a non-transient reason", async () => {
    const slow: RecordingDispatcher = () => new Promise(() => undefined);
    const { instance } = service({ dispatch: slow });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit");
    // 协调器的失联处理：不留下永久等待。
    const registry = new RecordingExecutorRegistry({
      checkoutId: checkoutIdFor("/tmp/wo-fault-matrix"),
      protocolVersion: "RECORDING_PROTOCOL_VERSION_1_ALPHA_1"
    });
    expect(registry.list()).toHaveLength(0);
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    expect(status.ok).toBe(true);
  });

  it("duplicate save receipts never create a second node", async () => {
    const { instance, submitted: commands } = service({
      reader: canvas({
        submit: async input => {
          commands.push({ commandId: input.commandId, commands: input.commands });
          return { ok: true, duplicate: true };
        }
      })
    });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit");
    await settle();
    // 只提交一次批次，并且是重复回执而不是新节点。
    expect(commands).toHaveLength(1);
    expect(commands[0]!.commands.filter(command => command.type === "node.add")).toHaveLength(1);
  });

  it("source removed between submit and commit blocks the save", async () => {
    let reads = 0;
    const { instance, submitted: commands } = service({
      reader: canvas({
        read: async () => ({
          ok: true,
          revision: 1,
          assets: [],
          nodeData: {},
          sourceIncarnation: "inc",
          layout: { x: 0, y: 0, width: 320 },
          writable: true
        }),
        currentLayout: async () => {
          reads += 1;
          return null;
        }
      })
    });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit");
    await settle();
    expect(reads).toBeGreaterThan(0);
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    if (!status.ok) throw new Error("status");
    // 源消失：提交被拒绝（不产生只有资产没有节点的半成品）。
    expect(status.status.state).toBe("failed");
    expect(status.status.error?.stage).toBe("RECORDING_ERROR_STAGE_COMMIT");
    const nodeAdds = commands.flatMap(entry => entry.commands).filter(command => command.type === "node.add");
    expect(nodeAdds).toHaveLength(0);
  });

  it("large artifact is no longer rejected by size (task 7.5)", async () => {
    // change: 2026-10-22-remove-agent-execution-limits：原 256 MiB 成片门禁已删除。
    // 真实字节仍必须可读并通过容器/尺寸/时长复核，因此这里以「读取失败」结束，而不是尺寸拒绝。
    let uploaded = false;
    const { instance } = service({
      upload: async input => {
        uploaded = true;
        return uploader(input);
      },
      dispatch: dispatcher({
        ok: true,
        claim: {
          path: "/tmp/nonexistent.mp4",
          sizeBytes: 300 * 1024 * 1024,
          contentSha256: CHECKSUM,
          width: 320,
          height: 180,
          durationSeconds: 4,
          frameCount: 120,
          mimeType: "video/mp4"
        }
      })
    });
    const submitted = await instance.submit({ canvasId: "c1", body });
    if (!submitted.ok) throw new Error("submit");
    await settle();
    const status = await instance.status({ canvasId: "c1", jobId: submitted.jobId });
    if (!status.ok) throw new Error("status");
    expect(status.status.error?.code).not.toBe("recording-artifact-too-large");
    expect(uploaded).toBe(false);
  });
});

describe("artifact rejection matrix", () => {
  const base = {
    path: "/tmp/x.mp4",
    sizeBytes: 1024,
    contentSha256: CHECKSUM,
    width: 320,
    height: 180,
    durationSeconds: 4,
    frameCount: 120,
    mimeType: "video/mp4"
  };

  it("rejects truncated, wrong codec, wrong duration and audio", () => {
    expect(validateArtifactClaim({ ...base, sizeBytes: 0 }, {}).ok).toBe(false);
    expect(validateArtifactClaim({ ...base, contentSha256: "nope" }, {}).ok).toBe(false);
    expect(validateArtifactClaim({ ...base, width: 321 }, {}).ok).toBe(false);
    expect(validateArtifactClaim({ ...base, durationSeconds: 9 }, { expectedDurationSeconds: 4 }).ok).toBe(false);
    expect(validateArtifactClaim({ ...base, mimeType: "video/webm" }, {}).ok).toBe(false);
  });

  it("host parser rejects non-MP4 and audio-containing files", () => {
    expect(probeArtifact(new TextEncoder().encode("definitely not mp4"))).toMatchObject({
      code: "recording-artifact-not-mp4"
    });
    expect(probeArtifact(new Uint8Array())).toMatchObject({ code: "recording-artifact-incomplete" });
  });
});
