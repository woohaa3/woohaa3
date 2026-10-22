/**
 * 视频 dialog definition / payload 校验测试
 * （change: port-video-editing-dialogs，任务 2.1 / 4.1；design D2）。
 */
import { describe, expect, it } from "vitest";
import { validateVideoDialogPayload, videoEditDefinition, frameCaptureDefinition } from "./definitions.js";
import { VIDEO_EDIT_DIALOG_ID, VIDEO_FRAME_CAPTURE_DIALOG_ID } from "./ids.js";

const STORAGE_KEY = `sha256-${"a".repeat(64)}`;
const VALID = {
  videoAssetId: "asset-1",
  videoStorageKey: STORAGE_KEY,
  videoUrl: "/api/media/sha256-video",
  targetNodeId: "node-1",
  title: "视频"
};

describe("视频 dialog id", () => {
  it("id 稳定且唯一", () => {
    expect(VIDEO_FRAME_CAPTURE_DIALOG_ID).toBe("canvas-video-frame-capture");
    expect(VIDEO_EDIT_DIALOG_ID).toBe("canvas-video-edit");
    expect(VIDEO_FRAME_CAPTURE_DIALOG_ID).not.toBe(VIDEO_EDIT_DIALOG_ID);
  });
});

describe("payload 校验", () => {
  it("接受稳定身份与同源播放 URL", () => {
    const result = validateVideoDialogPayload(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.targetNodeId).toBe("node-1");
  });

  it("拒绝非稳定 storageKey / 缺 target 的 payload", () => {
    expect(validateVideoDialogPayload({ ...VALID, videoStorageKey: "blob:http://x" }).ok).toBe(false);
    expect(validateVideoDialogPayload({ ...VALID, targetNodeId: "" }).ok).toBe(false);
    expect(validateVideoDialogPayload({ ...VALID, videoUrl: "" }).ok).toBe(false);
    expect(validateVideoDialogPayload(null).ok).toBe(false);
  });

  it("定义不可 singleton 且可隐式关闭", () => {
    expect(frameCaptureDefinition.singleton).toBe(false);
    expect(videoEditDefinition.singleton).toBe(false);
    expect(frameCaptureDefinition.dismissible).toBe(true);
    expect(videoEditDefinition.dismissible).toBe(true);
  });
});
