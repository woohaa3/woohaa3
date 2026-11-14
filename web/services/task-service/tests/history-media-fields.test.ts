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
