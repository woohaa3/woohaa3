/**
 * 视频 dialogs 会话服务测试
 * （change: port-video-editing-dialogs，任务 2.4 / 3.4 / 4.1；design D3/D6/D7）。
 *
 * 用内存 fake 注入 Dialogs/Media/Canvas 依赖，验证：
 * - 截帧逐帧上传 + 原子提交、部分失败保留成功项、重试不重复导入；
 * - 编辑确认只把稳定 preview identity 写入 nodeData，不上传无标注 intent 的 preview；
 * - 危险 intent 使确认以稳定错误失败；
 * - dispose 关闭打开实例并释放 session。
 */
import { describe, expect, it } from "vitest";
import type { CanvasNodeData, CanvasCommand, VideoEditIntent } from "@woohaa3/contracts";
import { VideoDialogsSession } from "./session.js";
import { OpenCaptureFrames } from "./capture-frames.js";
import type { CapturedFrameEntry, VideoDialogPayload } from "./types.js";
import type { CanvasSession, DialogsService, MediaRemoteService, UploadMediaResult } from "../../contracts.js";

const STORAGE_KEY = `sha256-${"a".repeat(64)}`;

type SubmittedBatch = { commands: readonly CanvasCommand[]; commandId: string };

function makeHarness(options: { writable?: boolean; upload?: (name: string) => UploadMediaResult } = {}) {
  const submitted: SubmittedBatch[] = [];
  const opened: string[] = [];
  const closed: string[] = [];
  let writeable = options.writable ?? true;

  const dialogs = {
    open(request: { dialogId: string; payload?: unknown }) {
      const instanceId = `instance-${opened.length + 1}`;
      opened.push(request.dialogId);
      return { ok: true as const, instance: { instanceId, dialogId: request.dialogId, payload: request.payload, parentInstanceId: null, dismissible: true, busy: false } };
    },
    close(instanceId: string) {
      closed.push(instanceId);
      return true;
    }
  } as unknown as DialogsService;

  const mediaRemote = {
    async upload({ file }: { file: File }) {
      if (options.upload) return options.upload(file.name);
      return {
        ok: true as const,
        media: { storageKey: STORAGE_KEY, checksum: "a".repeat(64), contentType: "image/png", size: file.size, url: `/api/media/${STORAGE_KEY}`, deduplicated: false }
      };
    }
  } as unknown as MediaRemoteService;

  const session = {
    isWritable: () => writeable,
    submitCommands(commands: readonly CanvasCommand[], commandId: string) {
      submitted.push({ commands, commandId });
      return { ok: true as const, handle: { commandId } as never };
    }
  } as unknown as CanvasSession;

  const videoSession = new VideoDialogsSession({
    dialogs,
    mediaRemote,
    session,
    readNodeIntents: () => []
  });
  const captureFrames = new OpenCaptureFrames({
    mediaRemote,
    session,
    resolveNodePosition: () => ({ x: 10, y: 20 })
  });

  return { videoSession, captureFrames, submitted, opened, closed, setWritable: (value: boolean) => { writeable = value; } };
}

function frame(id: string, timeSeconds: number): CapturedFrameEntry {
  return { id, blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), timeSeconds, url: `blob:${id}`, selected: true };
}

function payload(): VideoDialogPayload {
  return { videoAssetId: "asset-v", videoStorageKey: STORAGE_KEY, videoUrl: "/api/media/sha256-video", targetNodeId: "node-1" };
}

function intent(overrides: Partial<VideoEditIntent> = {}): VideoEditIntent {
  return {
    id: "i1",
    startSeconds: 1,
    endSeconds: 1.5,
    prompt: "转身",
    annotationShapes: [{ id: "s1", tool: "pen", color: "#ffffff", strokeWidth: 1, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }],
    frameWidth: 1920,
    frameHeight: 1080,
    ...overrides
  };
}

describe("截帧添加", () => {
  it("逐帧上传并原子提交 asset.upsert + node.add", async () => {
    const harness = makeHarness();
    const receipts = await harness.captureFrames.addFrames([frame("f1", 1), frame("f2", 2)], "node-1");
    expect(receipts.every((receipt) => receipt.ok)).toBe(true);
    expect(harness.submitted).toHaveLength(2);
    const types = harness.submitted[0]!.commands.map((command) => command.type);
    expect(types).toEqual(["asset.upsert", "node.add"]);
    const asset = harness.submitted[0]!.commands[0] as Extract<CanvasCommand, { type: "asset.upsert" }>;
    expect(asset.asset.metadata?.storageKey).toBe(STORAGE_KEY);
    expect(JSON.stringify(asset.asset)).not.toContain("blob:");
  });

  it("部分失败保留成功项，重试只重试失败项不重复导入", async () => {
    let calls = 0;
    const harness = makeHarness({
      upload: () => {
        calls += 1;
        if (calls === 2) return { ok: false, error: "上传失败" };
        return { ok: true, media: { storageKey: STORAGE_KEY, checksum: "a".repeat(64), contentType: "image/png", size: 3, url: `/api/media/${STORAGE_KEY}`, deduplicated: false } };
      }
    });
    const first = await harness.captureFrames.addFrames([frame("f1", 1), frame("f2", 2)], "node-1");
    expect(first.map((receipt) => receipt.ok)).toEqual([true, false]);
    expect(harness.submitted).toHaveLength(1);
    // 重试全部：成功项走缓存，不产生新的提交；失败项重试一次。
    const retry = await harness.captureFrames.addFrames([frame("f1", 1), frame("f2", 2)], "node-1");
    expect(retry.map((receipt) => receipt.ok)).toEqual([true, true]);
    expect(harness.submitted).toHaveLength(2);
  });

  it("只读时拒绝添加", async () => {
    const harness = makeHarness({ writable: false });
    const receipts = await harness.captureFrames.addFrames([frame("f1", 1)], "node-1");
    expect(receipts[0]!.ok).toBe(false);
    expect(harness.submitted).toHaveLength(0);
  });
});

describe("编辑确认", () => {
  it("只把稳定 preview identity 写入 nodeData", async () => {
    const harness = makeHarness();
    const opened = harness.videoSession.openVideoEdit(payload());
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const previews = new Map([["i1", new Blob([new Uint8Array([9])], { type: "image/png" })]]);
    const result = await harness.videoSession.confirmVideoEdit({ instanceId: opened.instanceId, intents: [intent()], previews });
    expect(result.ok).toBe(true);
    expect(harness.submitted).toHaveLength(1);
    const batch = harness.submitted[0]!;
    expect(batch.commands.map((command) => command.type)).toEqual(["asset.upsert", "nodeData.patch"]);
    const patch = batch.commands[1] as Extract<CanvasCommand, { type: "nodeData.patch" }>;
    const value = patch.value as CanvasNodeData;
    expect(value.videoEditIntents?.[0]?.annotationPreview?.storageKey).toBe(STORAGE_KEY);
    expect(JSON.stringify(batch.commands)).not.toContain("blob:");
    expect(JSON.stringify(batch.commands)).not.toContain("data:");
  });

  it("无标注 intent 不上传 preview 且不携带 annotationPreview", async () => {
    let uploads = 0;
    const harness = makeHarness({
      upload: () => {
        uploads += 1;
        return { ok: true, media: { storageKey: STORAGE_KEY, checksum: "a".repeat(64), contentType: "image/png", size: 1, url: `/api/media/${STORAGE_KEY}`, deduplicated: false } };
      }
    });
    const opened = harness.videoSession.openFrameCapture(payload());
    expect(opened.ok).toBe(true);
    void opened;
    const edit = harness.videoSession.openVideoEdit(payload());
    if (!edit.ok) return;
    const result = await harness.videoSession.confirmVideoEdit({
      instanceId: edit.instanceId,
      intents: [intent({ annotationShapes: [] })],
      previews: new Map()
    });
    expect(result.ok).toBe(true);
    expect(uploads).toBe(0);
  });

  it("危险 intent（data URL preview）使确认以稳定错误失败", async () => {
    const harness = makeHarness();
    const opened = harness.videoSession.openVideoEdit(payload());
    if (!opened.ok) return;
    const result = await harness.videoSession.confirmVideoEdit({
      instanceId: opened.instanceId,
      intents: [{ ...intent(), annotationPreview: { assetId: "", storageKey: "data:image/png;base64,AAAA", mediaType: "image/png" } }] as never,
      previews: new Map()
    });
    expect(result.ok).toBe(false);
    expect(harness.submitted).toHaveLength(0);
  });

  it("上传失败时确认失败且不写 nodeData", async () => {
    const harness = makeHarness({ upload: () => ({ ok: false, error: "上传失败" }) });
    const opened = harness.videoSession.openVideoEdit(payload());
    if (!opened.ok) return;
    const result = await harness.videoSession.confirmVideoEdit({
      instanceId: opened.instanceId,
      intents: [intent()],
      previews: new Map([["i1", new Blob([new Uint8Array([1])], { type: "image/png" })]])
    });
    expect(result.ok).toBe(false);
    expect(harness.submitted).toHaveLength(0);
  });
});

describe("dispose", () => {
  it("关闭打开实例并释放", async () => {
    const harness = makeHarness();
    const opened = harness.videoSession.openFrameCapture(payload());
    expect(opened.ok).toBe(true);
    harness.videoSession.dispose();
    harness.captureFrames.dispose();
    expect(harness.closed.length).toBeGreaterThan(0);
    const after = await harness.captureFrames.addFrames([frame("f1", 1)], "node-1");
    expect(after[0]!.ok).toBe(false);
  });
});
