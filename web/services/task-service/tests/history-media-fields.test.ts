/**
 * 历史脱敏白名单必须保留媒体准备态与安全错误分类
 * （change: 2026-11-06-fix-media-output-readiness，任务 1.3 / 2.2）。
 */
import { describe, expect, it } from "vitest";
import { sanitizeError, sanitizeResult } from "../src/repository/history-repository.js";

describe("媒体就绪字段的白名单", () => {
  it("result 保留 mediaState，成功前不携带任何 URL", () => {
    expect(
      sanitizeResult({ mediaKind: "video", mediaState: "materializing" })
    ).toEqual({ mediaKind: "video", mediaState: "materializing" });
  });

  it("error 保留安全 status/code，消息裁剪不引入 provider 地址", () => {
    expect(
      sanitizeError({
        name: "MediaImportError",
        message: "provider video 结果转存失败（HTTP 404）",
        status: 404,
        code: "media-not-found"
      })
    ).toEqual({
      name: "MediaImportError",
      message: "provider video 结果转存失败（HTTP 404）",
      status: 404,
      code: "media-not-found"
    });
  });
});

it("持久化动作采样率与骨架身份",()=>{
 const motion={fps:30,frameCount:120,skeletonId:"somaskel77",restPoseId:"kimodo-standard-tpose",formatVersion:"kimodo-soma-v1"};
 expect(sanitizeResult({mediaKind:"motion",fps:30,motion})).toMatchObject({fps:30,motion});
});

describe("多产物白名单（图层拆分）", () => {
  const KEY = (index: number): string => `generation-outputs/${`${index}`.repeat(64)}.png`;

  it("result.outputs 必须穿过白名单落库", () => {
    // 真实缺陷：转存日志写了 pending: 13，但写 result_json 时 outputs 被白名单整块丢掉，
    // 画布只拿到主产物一张白底板（用户看到「没有打组展示多个结果」）。
    const sanitized = sanitizeResult({
      mediaKind: "image",
      storageKey: KEY(0),
      contentType: "image/png",
      checksum: "a".repeat(64),
      size: 100,
      outputs: [
        { index: 0, storageKey: KEY(0), contentType: "image/png", checksum: "a".repeat(64), size: 100 },
        { index: 1, storageKey: KEY(1), contentType: "image/png", checksum: "b".repeat(64), size: 200, label: "layer_1" }
      ]
    });
    expect(sanitized.outputs?.map((entry) => entry.index)).toEqual([0, 1]);
    expect(sanitized.outputs?.[1]).toMatchObject({ storageKey: KEY(1), checksum: "b".repeat(64), label: "layer_1" });
  });

  it("逐项同样脱敏：没有 storageKey 的条目丢弃，签名 URL 一律不出现", () => {
    const sanitized = sanitizeResult({
      mediaKind: "image",
      storageKey: KEY(0),
      checksum: "a".repeat(64),
      outputs: [
        { index: 0, storageKey: KEY(0), checksum: "a".repeat(64) },
        // 缺 storageKey（例如只有临时地址）的条目不能留下来。
        { index: 1, storageKey: "", checksum: "b".repeat(64) } as never
      ]
    });
    expect(sanitized.outputs).toEqual([{ index: 0, storageKey: KEY(0), checksum: "a".repeat(64) }]);
    expect(JSON.stringify(sanitized)).not.toContain("http");
  });

  it("单产物结果不凭空出现 outputs 字段", () => {
    expect(sanitizeResult({ mediaKind: "image", storageKey: KEY(0), checksum: "a".repeat(64) }))
      .not.toHaveProperty("outputs");
  });
});
