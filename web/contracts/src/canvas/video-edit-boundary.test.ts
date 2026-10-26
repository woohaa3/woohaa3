import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
/**
 * 视频编辑 intent 的 canonical 边界测试
 * （change: port-video-editing-dialogs，任务 1.3 / design D6）。
 *
 * 验证 Y.Doc 投影 / nodeData / 剪贴板 / task history 均不接受 Blob、data URL、
 * object URL 或临时签名 URL 作为 video edit intent 或 annotation preview。
 */
import { describe, expect, it } from "vitest";

import { normalizeCanvas } from "./domain/normalization";
import { sanitizeNodeDataForClipboard } from "./domain/runtime-node-data";
import { containsForbiddenHistoryKey } from "../task/history";
import type { ServerCanvas, StoredAsset } from "./domain/types";

const STORAGE_KEY = `sha256-${"a".repeat(64)}`;
const CHECKSUM = "a".repeat(64);

const FORBIDDEN_STRINGS = ["data:", "blob:", "http://", "https://", "base64"];

function canvasFixture(): ServerCanvas {
  const asset: StoredAsset = {
    id: "asset-video",
    title: "视频",
    mediaKind: "video",
    source: "uploaded",
    status: "ready",
    createdAt: "2026-09-27T00:00:00.000Z",
    url: "/api/media/sha256-video",
    metadata: { storageKey: STORAGE_KEY, checksum: CHECKSUM, contentType: "video/mp4", size: 10 }
  };
  return {
    id: "canvas-1",
    title: "画布",
    revision: 1,
    document: {
      schemaVersion: "asset-canvas-v1",
      nodes: [
        { id: "n1", type: "video", position: { x: 0, y: 0 }, width: 320, height: 200 },
        { id: "n2", type: "video", position: { x: 400, y: 0 }, width: 320, height: 200 }
      ],
      edges: [],
      updatedAt: "2026-09-27T00:00:00.000Z"
    },
    nodeData: { n1: { title: "源视频", outputAssetId: "asset-video", resourceKind: "video", taskStatus: "successed" } },
    assets: [asset],
    jobs: [],
    updatedAt: "2026-09-27T00:00:00.000Z"
  };
}

function validIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: "i1",
    startSeconds: 2,
    endSeconds: 2.5,
    prompt: "转身",
    annotationShapes: [
      { id: "s1", tool: "pen", color: "#ffffff", strokeWidth: 1, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }
    ],
    annotationPreview: { assetId: "preview-asset", storageKey: STORAGE_KEY, mediaType: "image/png" },
    frameWidth: 1920,
    frameHeight: 1080,
    ...overrides
  };
}

describe("canonical nodeData 视频编辑 intent 边界", () => {
  it("normalizeCanvas 接受稳定 intent 并稳定排序", () => {
    const canvas = applyCanvasCommands(canvasFixture(), [
      {
        type: "nodeData.patch",
        nodeId: "n2",
        value: {
          videoEditIntents: [
            validIntent({ id: "b", startSeconds: 9, endSeconds: 9.5 }) as never,
            validIntent({ id: "a", startSeconds: 1, endSeconds: 1.5 }) as never
          ]
        }
      }
    ]);
    expect(canvas.ok).toBe(true);
    if (!canvas.ok) return;
    const intents = canvas.canvas.nodeData.n2!.videoEditIntents!;
    expect(intents.map((intent) => intent.id)).toEqual(["a", "b"]);
    const serialized = JSON.stringify(canvas.canvas);
    for (const forbidden of FORBIDDEN_STRINGS) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("normalizeCanvas 丢弃含 data URL preview 的 intent", () => {
    const normalized = normalizeCanvas({
      ...canvasFixture(),
      nodeData: {
        n1: {
          ...canvasFixture().nodeData.n1,
          videoEditIntents: [
            validIntent({
              annotationPreview: { assetId: "", storageKey: "data:image/png;base64,AAAA", mediaType: "image/png" }
            })
          ]
        }
      }
    } as ServerCanvas);
    expect(normalized.nodeData.n1!.videoEditIntents ?? []).toEqual([]);
  });

  it("nodeData.patch 含危险 preview/Blob 时整批以稳定错误失败，不写规范状态", () => {
    const result = applyCanvasCommands(canvasFixture(), [
      {
        type: "nodeData.patch",
        nodeId: "n2",
        value: {
          videoEditIntents: [
            validIntent({ annotationPreview: { assetId: "", storageKey: "blob:http://localhost/x", mediaType: "image/png" } }),
            validIntent({ id: "i2", annotationPreview: { assetId: "", storageKey: "https://cos/x?sign=1", mediaType: "image/png" } })
          ] as never
        }
      }
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe("invalid-video-edit-intent");
  });

  it("未知二进制字段被剥离，合法 intent 保留稳定 preview", () => {
    const result = applyCanvasCommands(canvasFixture(), [
      {
        type: "nodeData.patch",
        nodeId: "n2",
        value: {
          videoEditIntents: [{ ...validIntent({ id: "i3" }), annotationImageDataUrl: "data:image/png;base64,AAAA" }] as never
        }
      }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const intents = result.canvas.nodeData.n2!.videoEditIntents ?? [];
    expect(intents.map((intent) => intent.id)).toEqual(["i3"]);
    expect(JSON.stringify(result.canvas)).not.toContain("data:");
    expect(JSON.stringify(result.canvas)).not.toContain("blob:");
  });

  it("剪贴板复制剥离危险 videoEditIntents", () => {
    const cleaned = sanitizeNodeDataForClipboard({
      title: "保留",
      videoEditIntents: [
        validIntent({ annotationPreview: { assetId: "", storageKey: "data:image/png;base64,AAAA", mediaType: "image/png" } })
      ]
    });
    expect(cleaned).toHaveProperty("title", "保留");
    expect(cleaned.videoEditIntents ?? []).toEqual([]);
  });
});

describe("task history 拒绝临时媒体字段", () => {
  it("递归检测 data URL / blob / 二进制键", () => {
    expect(containsForbiddenHistoryKey({ request: { annotationImageDataUrl: "data:image/png;base64,AAAA" } })).toBe(true);
    expect(containsForbiddenHistoryKey({ nested: { bytes: [1, 2, 3] } })).toBe(true);
    expect(containsForbiddenHistoryKey({ parameters: { generationMode: "edit_video" } })).toBe(false);
  });

  it("含 prompt/二进制 payload 的视频编辑 request 被判定为需裁剪", () => {
    expect(
      containsForbiddenHistoryKey({
        request: { prompt: "编辑", parameters: { videoEditIntents: [validIntent()] } }
      })
    ).toBe(true);
  });
});
