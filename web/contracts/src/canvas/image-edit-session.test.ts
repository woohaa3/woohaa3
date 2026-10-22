/**
 * 编辑会话完成协议契约测试
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 1.4）。
 */
import { describe, expect, it } from "vitest";
import {
  decodeEditSessionBeginRequest,
  decodeEditSessionCompleteRequest,
  decodeEditSessionStatusRequest,
  decodeExpectedCurrentIdentity,
  decodeImageEditCompleteMedia,
  editCompletePayloadFingerprint,
  editCompletionKey,
  isEditCompletionStatus,
  type EditSessionCompleteRequest
} from "./image-edit-session.js";
import { IMAGE_EDIT_DOCUMENT_VERSION, type ImageEditDocument } from "./image-edit.js";

const baseStorageKey = "sha256-" + "a".repeat(64);
const outputStorageKey = "generation-outputs/" + "b".repeat(64) + ".png";

const imageEdit: ImageEditDocument = {
  version: IMAGE_EDIT_DOCUMENT_VERSION,
  baseAssetId: "asset-base",
  sourceWidth: 100,
  sourceHeight: 80,
  shapes: [
    {
      id: "s1",
      tool: "pen",
      color: "#ff3b30",
      widthInSourcePixels: 2,
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.2 }
      ]
    }
  ]
};

const completeImage: EditSessionCompleteRequest = {
  canvasId: "canvas-1",
  nodeId: "node-1",
  sessionId: "session-1",
  requestId: "req-1",
  kind: "image",
  baselineContentIdentity: `media:${baseStorageKey}`,
  media: {
    baseAssetId: "asset-base",
    baseStorageKey,
    sourceWidth: 100,
    sourceHeight: 80,
    outputAssetId: "asset-out",
    outputStorageKey,
    checksum: "c".repeat(64),
    contentType: "image/png",
    size: 1234,
    baseChecksum: "a".repeat(64),
    baseContentType: "image/png",
    baseSize: 10,
    imageEdit
  }
};

describe("begin 请求", () => {
  it("接受合法请求", () => {
    const result = decodeEditSessionBeginRequest({
      canvasId: "c",
      nodeId: "n",
      sessionId: "s",
      requestId: "r",
      kind: "image",
      baselineContentIdentity: "media:x"
    });
    expect(result.ok).toBe(true);
  });

  it("拒绝非法 kind 与超长基线", () => {
    expect(
      decodeEditSessionBeginRequest({ canvasId: "c", nodeId: "n", sessionId: "s", requestId: "r", kind: "video", baselineContentIdentity: "x" }).ok
    ).toBe(false);
    expect(
      decodeEditSessionBeginRequest({
        canvasId: "c",
        nodeId: "n",
        sessionId: "s",
        requestId: "r",
        kind: "image",
        baselineContentIdentity: "x".repeat(513)
      }).ok
    ).toBe(false);
  });
});

describe("complete 请求", () => {
  it("接受合法图片完成请求", () => {
    const result = decodeEditSessionCompleteRequest(completeImage);
    expect(result.ok).toBe(true);
  });

  it("拒绝 imageEdit 源尺寸与 media metadata 不一致", () => {
    const result = decodeEditSessionCompleteRequest({
      ...completeImage,
      media: { ...completeImage.media, sourceWidth: 200 }
    });
    expect(result.ok).toBe(false);
  });

  it("拒绝非法存储键", () => {
    const result = decodeEditSessionCompleteRequest({
      ...completeImage,
      media: { ...completeImage.media, outputStorageKey: "http://evil/x.png" }
    });
    expect(result.ok).toBe(false);
  });

  it("接受模型完成请求", () => {
    const result = decodeEditSessionCompleteRequest({
      canvasId: "c",
      nodeId: "n",
      sessionId: "s",
      requestId: "r",
      kind: "model",
      baselineContentIdentity: "model-source:abc",
      model: { baselineSourceHash: "abc", finalSourceHash: "def" }
    });
    expect(result.ok).toBe(true);
  });

  it("同 requestId 不同 payload 指纹不同（服务端据此返回冲突）", () => {
    const other = decodeEditSessionCompleteRequest({
      ...completeImage,
      media: { ...completeImage.media, outputStorageKey: "generation-outputs/" + "e".repeat(64) + ".png" }
    });
    expect(other.ok).toBe(true);
    if (other.ok) {
      expect(editCompletePayloadFingerprint(completeImage)).not.toBe(editCompletePayloadFingerprint(other.value));
    }
  });

  it("幂等键包含 canvas/node/request", () => {
    expect(editCompletionKey({ canvasId: "c", nodeId: "n", requestId: "r" })).toBe("c\u0000n\u0000r");
  });
});

describe("status 与恢复并发保护", () => {
  it("status 请求校验", () => {
    expect(decodeEditSessionStatusRequest({ canvasId: "c", nodeId: "n", requestId: "r" }).ok).toBe(true);
    expect(decodeEditSessionStatusRequest({ canvasId: "c", nodeId: "n" }).ok).toBe(false);
  });

  it("expectedCurrentIdentity 可选且长度受限", () => {
    expect(decodeExpectedCurrentIdentity(undefined).ok).toBe(true);
    expect(decodeExpectedCurrentIdentity("media:x")).toEqual({ ok: true, value: "media:x" });
    expect(decodeExpectedCurrentIdentity("x".repeat(513)).ok).toBe(false);
  });

  it("回执状态枚举", () => {
    expect(isEditCompletionStatus("completed")).toBe(true);
    expect(isEditCompletionStatus("history-pending")).toBe(true);
    expect(isEditCompletionStatus("bogus")).toBe(false);
  });
});

describe("decodeImageEditCompleteMedia", () => {
  it("允许缺省 imageEdit（纯媒体）", () => {
    const { imageEdit: _omit, ...rest } = completeImage.media;
    const result = decodeImageEditCompleteMedia(rest);
    expect(result.ok).toBe(true);
  });

  it("保留 base metadata（checksum/contentType/size）", () => {
    const result = decodeImageEditCompleteMedia(completeImage.media);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseChecksum).toBe("a".repeat(64));
      expect(result.value.baseContentType).toBe("image/png");
      expect(result.value.baseSize).toBe(10);
    }
  });
});
