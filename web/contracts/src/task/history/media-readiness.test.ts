import { describe, expect, it } from "vitest";
import { hasReadyMediaAsset, taskMediaReadiness } from "./media-readiness.js";

describe("taskMediaReadiness", () => {
  it("provider 执行期间是 pending，转存中是 preparing", () => {
    expect(taskMediaReadiness({ state: "running", modelType: "image" })).toBe("pending");
    expect(
      taskMediaReadiness({
        state: "running",
        modelType: "image",
        result: { mediaKind: "image", mediaState: "materializing" }
      })
    ).toBe("preparing");
  });

  it("succeeded 必须有稳定 storageKey 与 checksum 才算 ready", () => {
    expect(
      taskMediaReadiness({
        state: "succeeded",
        modelType: "image",
        result: { mediaKind: "image", storageKey: "generation-outputs/a.png", checksum: "a" }
      })
    ).toBe("ready");
    expect(
      taskMediaReadiness({
        state: "succeeded",
        modelType: "image",
        result: { mediaKind: "image" }
      })
    ).toBe("preparing");
    expect(
      taskMediaReadiness({
        state: "succeeded",
        modelType: "video",
        result: { mediaKind: "video", storageKey: "generation-outputs/a.mp4" }
      })
    ).toBe("preparing");
  });

  it("缺 modelType 时用结果媒体类型判定，失败/取消不开放入口", () => {
    expect(
      taskMediaReadiness({ state: "succeeded", result: { mediaKind: "audio", storageKey: "k", checksum: "c" } })
    ).toBe("ready");
    expect(taskMediaReadiness({ state: "failed", modelType: "video" })).toBe("failed");
    expect(taskMediaReadiness({ state: "cancelled", result: { mediaKind: "image" } })).toBe("failed");
  });

  it("文本结果没有媒体门禁", () => {
    expect(taskMediaReadiness({ state: "succeeded", modelType: "language" })).toBe("not-media");
    expect(taskMediaReadiness({ state: "succeeded", result: { mediaKind: "text" } })).toBe("not-media");
  });
});

describe("hasReadyMediaAsset", () => {
  it("只认 ready 且带稳定存储身份的资产（checksum 可缺省）", () => {
    expect(hasReadyMediaAsset({ status: "ready", metadata: { storageKey: "k", checksum: "c" } })).toBe(true);
    expect(hasReadyMediaAsset({ status: "ready", metadata: { storageKey: "k" } })).toBe(true);
    expect(hasReadyMediaAsset({ status: "ready", metadata: {} })).toBe(false);
    expect(hasReadyMediaAsset({ status: "pending", metadata: { storageKey: "k", checksum: "c" } })).toBe(false);
    expect(hasReadyMediaAsset(null)).toBe(false);
  });
});
