/**
 * 转换媒体输入装配（任务 2.2 / design D2）。
 *
 * 覆盖：图片原文件直接作为真实视觉输入、模型原生视频直传、多图模型服务端抽帧（时间戳/首尾覆盖）、
 * 预算不足（多图缺失/帧预算超限）拒绝而非静默截断。纯逻辑检查，不接触 provider SDK 或渲染。
 */
import { describe, expect, it } from "vitest";
import {
  readFilmSetConversionMediaInput,
  type FilmSetConversionAdapterCapabilities,
  type FilmSetConversionMediaReader
} from "./film-set-conversion.js";

function capabilities(overrides: Partial<FilmSetConversionAdapterCapabilities["input"]> = {}): FilmSetConversionAdapterCapabilities {
  return {
    structuredCandidateOutput: true,
    input: {
      imageInput: true,
      maxImages: 1,
      videoInput: false,
      maxFrames: 0,
      maxDurationSeconds: 0,
      ...overrides
    }
  };
}

function reader(overrides: Partial<FilmSetConversionMediaReader> = {}): FilmSetConversionMediaReader {
  return {
    readAsset: async (storageKey) => ({ bytes: new Uint8Array([1, 2, 3]), contentType: `${storageKey}` }),
    ...overrides
  };
}

describe("readFilmSetConversionMediaInput：真实视觉输入（任务 2.2）", () => {
  it("图片读取原文件作为单个真实附件，而非 URL 文本", async () => {
    const result = await readFilmSetConversionMediaInput({
      media: reader({ readAsset: async () => ({ bytes: new Uint8Array([9, 8, 7]), contentType: "image/png" }) }),
      sourceKind: "image",
      storageKey: "sha256-abc",
      contentType: "image/*",
      capabilities: capabilities()
    });
    expect(result.nativeVideo).toBe(false);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]!.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(result.attachments[0]!.contentType).toBe("image/png");
  });

  it("模型声明原生视频时直接传原件，不做抽帧", async () => {
    let frameCalls = 0;
    const result = await readFilmSetConversionMediaInput({
      media: reader({
        readAsset: async () => ({ bytes: new Uint8Array([4, 5]), contentType: "video/mp4" }),
        readVideoFrames: async () => { frameCalls += 1; return []; }
      }),
      sourceKind: "video",
      storageKey: "sha256-vid",
      contentType: "video/mp4",
      range: { startSeconds: 1, endSeconds: 3 },
      capabilities: capabilities({ videoInput: true, maxImages: 1 })
    });
    expect(result.nativeVideo).toBe(true);
    expect(frameCalls).toBe(0);
    expect(result.attachments[0]!.contentType).toBe("video/mp4");
  });

  it("多图模型在所选范围服务端抽帧，携带时间戳与所选范围", async () => {
    let seen: { range?: { startSeconds: number; endSeconds: number }; maxFrames: number } | null = null;
    const result = await readFilmSetConversionMediaInput({
      media: reader({
        readAsset: async () => ({ bytes: new Uint8Array([1]), contentType: "video/mp4" }),
        readVideoFrames: async (input) => {
          seen = { ...(input.range ? { range: input.range } : {}), maxFrames: input.maxFrames };
          return [
            { timestampSeconds: 2, bytes: new Uint8Array([10]), contentType: "image/jpeg" },
            { timestampSeconds: 4, bytes: new Uint8Array([11]), contentType: "image/jpeg" }
          ];
        }
      }),
      sourceKind: "video",
      storageKey: "sha256-vid",
      contentType: "video/mp4",
      range: { startSeconds: 2, endSeconds: 4 },
      durationSeconds: 10,
      capabilities: capabilities({ maxImages: 4, maxFrames: 4 })
    });
    expect(result.nativeVideo).toBe(false);
    expect(result.attachments).toHaveLength(2);
    expect(result.frameTimestamps).toEqual([2, 4]);
    expect(seen).not.toBeNull();
    expect(seen!.range).toEqual({ startSeconds: 2, endSeconds: 4 });
    expect(seen!.maxFrames).toBe(4);
  });

  it("帧预算取模型声明的 maxFrames 与 maxImages 的较小者", async () => {
    let maxFrames = 0;
    await readFilmSetConversionMediaInput({
      media: reader({
        readAsset: async () => ({ bytes: new Uint8Array([1]), contentType: "video/mp4" }),
        readVideoFrames: async (input) => {
          maxFrames = input.maxFrames;
          return [{ timestampSeconds: 0, bytes: new Uint8Array([1]), contentType: "image/jpeg" }];
        }
      }),
      sourceKind: "video",
      storageKey: "k",
      contentType: "video/mp4",
      capabilities: capabilities({ maxImages: 12, maxFrames: 6 })
    });
    expect(maxFrames).toBe(6);
  });

  it("仅单图能力处理视频时拒绝，且不静默降级为文字", async () => {
    await expect(readFilmSetConversionMediaInput({
      media: reader(),
      sourceKind: "video",
      storageKey: "k",
      contentType: "video/mp4",
      capabilities: capabilities({ maxImages: 1 })
    })).rejects.toThrow(/不支持视频或多图输入/);
  });

  it("模型未提供抽帧实现时拒绝，不静默截断", async () => {
    await expect(readFilmSetConversionMediaInput({
      media: reader({ readVideoFrames: undefined }),
      sourceKind: "video",
      storageKey: "k",
      contentType: "video/mp4",
      capabilities: capabilities({ maxImages: 8, maxFrames: 8 })
    })).rejects.toThrow(/不支持视频或多图输入/);
  });

  it("抽帧结果超过预算时拒绝并要求重选范围", async () => {
    await expect(readFilmSetConversionMediaInput({
      media: reader({
        readAsset: async () => ({ bytes: new Uint8Array([1]), contentType: "video/mp4" }),
        readVideoFrames: async () => [
          { timestampSeconds: 0, bytes: new Uint8Array([1]), contentType: "image/jpeg" },
          { timestampSeconds: 1, bytes: new Uint8Array([1]), contentType: "image/jpeg" },
          { timestampSeconds: 2, bytes: new Uint8Array([1]), contentType: "image/jpeg" }
        ]
      }),
      sourceKind: "video",
      storageKey: "k",
      contentType: "video/mp4",
      capabilities: capabilities({ maxImages: 2, maxFrames: 2 })
    })).rejects.toThrow(/预算超限|重新选择范围/);
  });
});
