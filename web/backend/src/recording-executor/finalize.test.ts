/**
 * 录制成片的上传与原子提交（任务 6.1 / 6.2 / 6.3）。
 *
 * 覆盖：声明自洽校验、上传失败/大小不符、提交拒绝、幂等重复回执、分块流式读取、
 * 以及「参考只登记资产、导出创建资产+节点」的整批原子性。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasCommand, ContentRecordingCommitRequest } from "@woohaa3/contracts";
import {
  finalizeRecording,
  readFileChunks,
  validateArtifactClaim,
  type RecordingArtifactClaim,
  type RecordingCommitDeps,
  type RecordingUploadedArtifact
} from "./finalize.js";
import { sha256Hex } from "./probe.js";

const CHECKSUM = "c".repeat(64);
const IDENTITY = {
  jobId: "job-1",
  attemptId: "attempt-1",
  executorInstanceId: "exec-1",
  executionEpoch: 1,
  snapshotHash: "snap",
  contentIdentity: "content",
  profileKey: "profile"
};

const LIMITS = { maxBytes: 256 * 1024 * 1024, expectedWidth: 1280, expectedHeight: 720, expectedDurationSeconds: 4, expectedFrameRate: 30 };

function claim(overrides: Partial<RecordingArtifactClaim> = {}): RecordingArtifactClaim {
  // checksum 必须与实际字节一致：宿主复核会重算并比对。
  const actual = artifactBytes();
  return {
    path: "/tmp/does-not-matter.mp4",
    sizeBytes: actual.byteLength,
    contentSha256: sha256Hex(actual),
    width: 1280,
    height: 720,
    durationSeconds: 4,
    frameCount: 120,
    mimeType: "video/mp4",
    ...overrides
  };
}

function commitRequest(overrides: Partial<ContentRecordingCommitRequest> = {}): ContentRecordingCommitRequest {
  return {
    requestId: "req-1",
    purpose: "export",
    canvasId: "c1",
    nodeId: "film",
    clipId: "clip-1",
    sourceIncarnation: "inc",
    contentIdentity: "content",
    profileKey: "profile",
    title: "片场 · 镜头 1",
    artifact: {
      storageKey: "unused",
      checksum: CHECKSUM,
      mimeType: "video/mp4",
      sizeBytes: 1024,
      width: 1280,
      height: 720,
      durationSeconds: 4,
      frameRate: 30,
      hasAudio: false
    },
    ...overrides
  };
}

function uploaded(overrides: Partial<RecordingUploadedArtifact> = {}): RecordingUploadedArtifact {
  const actual = artifactBytes();
  return {
    storageKey: `sha256-${sha256Hex(actual)}`,
    checksum: sha256Hex(actual),
    contentType: "video/mp4",
    size: actual.byteLength,
    ...overrides
  };
}

/** 最小 Fast Start H.264 MP4（与 probe.test.ts 的构造思路一致，够解析即可）。 */
function artifactBytes(options: { width?: number; height?: number; samples?: number; duration?: number } = {}): Uint8Array {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const samples = options.samples ?? 120;
  const duration = options.duration ?? 120;
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
    ...Array(6).fill(0),
    ...u16(1),
    ...Array(16).fill(0),
    ...u16(width),
    ...u16(height),
    ...u32(0x0048_0000),
    ...u32(0x0048_0000),
    ...u32(0),
    ...u16(1),
    ...Array(32).fill(0),
    ...u16(0x18),
    ...u16(0xffff),
    ...avcC
  ]);
  const stbl = box("stbl", [
    ...fullBox("stsd", 0, [...u32(1), ...avc1]),
    ...fullBox("stts", 0, [...u32(1), ...u32(samples), ...u32(1)]),
    ...fullBox("stsc", 0, [...u32(1), ...u32(1), ...u32(1), ...u32(1)]),
    ...fullBox("stsz", 0, [...u32(0), ...u32(samples), ...Array(samples).fill(0).flatMap(() => u32(4))]),
    ...fullBox("stco", 0, [...u32(1), ...u32(0)])
  ]);
  const minf = box("minf", [...fullBox("vmhd", 1, Array(8).fill(0)), ...stbl]);
  const mdia = box("mdia", [
    ...fullBox("mdhd", 0, [...u32(0), ...u32(0), ...u32(30), ...u32(duration), ...u16(0x55c4), ...u16(0)]),
    ...fullBox("hdlr", 0, [
      ...u32(0),
      ...[..."vide"].map(character => character.charCodeAt(0)),
      ...Array(12).fill(0),
      ...[..."VideoHandler\u0000"].map(character => character.charCodeAt(0))
    ]),
    ...minf
  ]);
  const tkhd = fullBox("tkhd", 3, [
    ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(duration),
    ...Array(8).fill(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(0x0001_0000), ...u32(0), ...u32(0),
    ...u32(0), ...u32(0x0001_0000), ...u32(0),
    ...u32(0), ...u32(0), ...u32(0x4000_0000),
    ...u32(width * 65_536), ...u32(height * 65_536)
  ]);
  const moov = box("moov", [
    ...fullBox("mvhd", 0, [
      ...u32(0), ...u32(0), ...u32(30), ...u32(duration),
      ...u32(0x0001_0000), ...u16(0x0100), ...Array(10).fill(0),
      ...u32(0x0001_0000), ...u32(0), ...u32(0),
      ...u32(0), ...u32(0x0001_0000), ...u32(0),
      ...u32(0), ...u32(0), ...u32(0x4000_0000),
      ...Array(24).fill(0), ...u32(2)
    ]),
    ...box("trak", [...tkhd, ...mdia])
  ]);
  const ftyp = box("ftyp", [...[..."isom"].map(c => c.charCodeAt(0)), ...u32(0x200), ...[..."isom"].map(c => c.charCodeAt(0))]);
  return new Uint8Array([...ftyp, ...moov, ...box("mdat", [...u32(4), 1, 2, 3, 4])]);
}

function deps(overrides: Partial<RecordingCommitDeps> = {}): RecordingCommitDeps {
  const commands: CanvasCommand[] = [
    { type: "asset.upsert", asset: { id: "asset-1" } as never },
    { type: "node.add", node: { id: "node-1" } as never }
  ];
  return {
    openArtifact: async () => (async function* () {})(),
    upload: async () => ({ ok: true, artifact: uploaded() }),
    submit: async () => ({ ok: true, duplicate: false }),
    planCommit: async () => ({ ok: true, commands, commandId: "cmd-1", nodeId: "node-1" }),
    ...overrides
  };
}

describe("validateArtifactClaim", () => {
  it("accepts a coherent H.264 MP4 claim", () => {
    expect(validateArtifactClaim(claim(), LIMITS)).toEqual({ ok: true });
  });

  it("rejects empty, oversized and unverified artifacts", () => {
    expect(validateArtifactClaim(claim({ sizeBytes: 0 }), LIMITS)).toMatchObject({ code: "recording-artifact-empty" });
    expect(validateArtifactClaim(claim({ sizeBytes: LIMITS.maxBytes + 1 }), LIMITS)).toMatchObject({
      code: "recording-artifact-too-large"
    });
    expect(validateArtifactClaim(claim({ contentSha256: "not-a-hash" }), LIMITS)).toMatchObject({
      code: "recording-artifact-unverified"
    });
  });

  it("rejects wrong size, duration, frame count and container", () => {
    expect(validateArtifactClaim(claim({ width: 1281 }), LIMITS)).toMatchObject({ code: "recording-artifact-wrong-size" });
    expect(validateArtifactClaim(claim({ width: 640 }), LIMITS)).toMatchObject({ code: "recording-artifact-wrong-size" });
    expect(validateArtifactClaim(claim({ durationSeconds: 0 }), LIMITS)).toMatchObject({
      code: "recording-artifact-wrong-duration"
    });
    expect(validateArtifactClaim(claim({ durationSeconds: 10 }), LIMITS)).toMatchObject({
      code: "recording-artifact-wrong-duration"
    });
    expect(validateArtifactClaim(claim({ frameCount: 0 }), LIMITS)).toMatchObject({ code: "recording-artifact-empty" });
    expect(validateArtifactClaim(claim({ mimeType: "video/webm" }), LIMITS)).toMatchObject({
      code: "recording-artifact-wrong-container"
    });
  });

  it("tolerates a fractional final frame within one frame duration", () => {
    // 4 秒片段的末帧可能短于一帧；±1/30 秒内仍接受。
    expect(validateArtifactClaim(claim({ durationSeconds: 4 - 1 / 60 }), LIMITS)).toEqual({ ok: true });
  });
});

describe("finalizeRecording", () => {
  it("uploads then commits a single batch", async () => {
    const uploadedSizes: number[] = [];
    const uploadedCanvases: string[] = [];
    const committed: Array<{ commandId: string; commands: CanvasCommand[] }> = [];
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim(),
      readArtifactBytes: async () => artifactBytes(),
      commitRequest: commitRequest(),
      sourcePosition: { x: 0, y: 0, width: 100 },
      limits: LIMITS,
      deps: deps({
        upload: async input => {
          uploadedSizes.push(input.sizeBytes);
          uploadedCanvases.push(input.canvasId);
          return { ok: true, artifact: uploaded() };
        },
        submit: async input => {
          committed.push({ commandId: input.commandId, commands: input.commands });
          return { ok: true, duplicate: false };
        }
      }),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(uploadedSizes).toEqual([artifactBytes().byteLength]);
    // 成片上传必须带上画布作用域：远端画布要写进托管存储，否则只有本机能读。
    expect(uploadedCanvases).toEqual(["c1"]);
    expect(committed).toHaveLength(1);
    expect(committed[0]!.commandId).toBe("cmd-1");
    expect(committed[0]!.commands).toHaveLength(2);
    expect(result.nodeId).toBe("node-1");
    expect(result.duplicate).toBe(false);
  });

  it("reports upload failures with the upload stage", async () => {
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim(),
      readArtifactBytes: async () => artifactBytes(),
      commitRequest: commitRequest(),
      sourcePosition: { x: 0, y: 0, width: 100 },
      limits: LIMITS,
      deps: deps({ upload: async () => ({ ok: false, code: "media-too-large", message: "too large" }) }),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("RECORDING_ERROR_STAGE_UPLOAD");
    expect(result.code).toBe("media-too-large");
  });

  it("rejects when uploaded bytes do not match the claim", async () => {
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim(),
      readArtifactBytes: async () => artifactBytes(),
      commitRequest: commitRequest(),
      sourcePosition: { x: 0, y: 0, width: 100 },
      limits: LIMITS,
      deps: deps({ upload: async () => ({ ok: true, artifact: uploaded({ size: 999 }) }) }),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("recording-upload-size-mismatch");
  });

  it("does not submit when the commit plan is rejected", async () => {
    let submitted = false;
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim(),
      readArtifactBytes: async () => artifactBytes(),
      commitRequest: commitRequest(),
      sourcePosition: null,
      limits: LIMITS,
      deps: deps({
        planCommit: async () => ({ ok: false, code: "recording-source-removed", message: "源已删除" }),
        submit: async () => {
          submitted = true;
          return { ok: true, duplicate: false };
        }
      }),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("RECORDING_ERROR_STAGE_COMMIT");
    expect(result.code).toBe("recording-source-removed");
    expect(submitted).toBe(false);
  });

  it("propagates a rejected commit without claiming success", async () => {
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim(),
      readArtifactBytes: async () => artifactBytes(),
      commitRequest: commitRequest(),
      sourcePosition: { x: 0, y: 0, width: 100 },
      limits: LIMITS,
      deps: deps({
        submit: async () => ({ ok: false, code: "asset-reference-invalid", message: "bad asset" })
      }),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("asset-reference-invalid");
    expect(result.stage).toBe("RECORDING_ERROR_STAGE_COMMIT");
  });

  it("treats a duplicate commit receipt as success", async () => {
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim(),
      readArtifactBytes: async () => artifactBytes(),
      commitRequest: commitRequest(),
      sourcePosition: { x: 0, y: 0, width: 100 },
      limits: LIMITS,
      deps: deps({ submit: async () => ({ ok: true, duplicate: true }) }),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.duplicate).toBe(true);
  });

  it("refuses to upload without host-side byte verification", async () => {
    let didUpload = false;
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim(),
      commitRequest: commitRequest(),
      sourcePosition: { x: 0, y: 0, width: 100 },
      limits: LIMITS,
      deps: deps({
        upload: async () => {
          didUpload = true;
          return { ok: true, artifact: uploaded() };
        }
      }),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("recording-artifact-unverified");
    expect(didUpload).toBe(false);
  });

  it("rejects bytes whose real dimensions disagree with the profile", async () => {
    let didUpload = false;
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim(),
      readArtifactBytes: async () => artifactBytes({ width: 1920, height: 1080 }),
      commitRequest: commitRequest(),
      sourcePosition: { x: 0, y: 0, width: 100 },
      limits: LIMITS,
      deps: deps({
        upload: async () => {
          didUpload = true;
          return { ok: true, artifact: uploaded() };
        }
      }),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("RECORDING_ERROR_STAGE_MUX");
      expect(result.code).toBe("recording-artifact-wrong-size");
    }
    expect(didUpload).toBe(false);
  });

  it("rejects bytes that are not an MP4 at all", async () => {
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim(),
      readArtifactBytes: async () => new TextEncoder().encode("not a container"),
      commitRequest: commitRequest(),
      sourcePosition: { x: 0, y: 0, width: 100 },
      limits: LIMITS,
      deps: deps(),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("recording-artifact-not-mp4");
  });

  it("rejects an incoherent claim before uploading", async () => {
    let didUpload = false;
    const result = await finalizeRecording({
      identity: IDENTITY,
      claim: claim({ width: 720, height: 1280 }),
      commitRequest: commitRequest(),
      sourcePosition: { x: 0, y: 0, width: 100 },
      limits: LIMITS,
      deps: deps({
        upload: async () => {
          didUpload = true;
          return { ok: true, artifact: uploaded() };
        }
      }),
      signal: new AbortController().signal
    });
    expect(result.ok).toBe(false);
    expect(didUpload).toBe(false);
  });
});

describe("readFileChunks", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wo-finalize-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("streams the file in bounded chunks without loading it whole", async () => {
    const path = join(dir, "artifact.mp4");
    const bytes = Buffer.alloc(2_500, 7);
    writeFileSync(path, bytes);
    const chunks: number[] = [];
    let total = 0;
    for await (const chunk of readFileChunks(path, bytes.length, 1024)) {
      chunks.push(chunk.byteLength);
      total += chunk.byteLength;
    }
    expect(total).toBe(2_500);
    expect(chunks).toEqual([1024, 1024, 452]);
  });

  it("stops at the declared size even if the file is longer", async () => {
    const path = join(dir, "larger.mp4");
    writeFileSync(path, Buffer.alloc(100, 1));
    let total = 0;
    for await (const chunk of readFileChunks(path, 40, 16)) total += chunk.byteLength;
    expect(total).toBe(40);
  });
});
