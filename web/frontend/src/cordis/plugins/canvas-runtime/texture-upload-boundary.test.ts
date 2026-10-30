import { describe, expect, it, vi } from "vitest";
import { TextureUploadBoundary } from "./texture-upload-boundary.js";
import { RuntimeIssues } from "./runtime-issues.js";

describe("纹理失败隔离", () => {
  it("失败来源只上传一次，其他来源继续；手动重试成功只清除当前问题", () => {
    const issues = new RuntimeIssues();
    const boundary = new TextureUploadBoundary(issues);
    const pixels = new Uint8Array(4);
    const fail = vi.fn(() => { throw "Invalid texture"; });
    for (let frame = 0; frame < 3; frame++) expect(boundary.upload("node", "bad", 1, 1, new Uint8Array(4), fail, { sourceKey: "same-video" })).toBe(false);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(boundary.upload("node", "good", 1, 1, pixels, () => undefined)).toBe(true);
    expect(issues.getSnapshot()).toHaveLength(1);
    boundary.upload("node", "other", 1, 1, pixels, fail);
    boundary.retry();
    expect(boundary.upload("node", "bad", 1, 1, pixels, () => undefined, { sourceKey: "same-video" })).toBe(true);
    expect(issues.getSnapshot().map(issue => issue.nodeId)).toEqual(["other"]);
  });
  it("换源后可恢复；卡片回退保留聚焦错误，退出恢复后清除", () => {
    const issues = new RuntimeIssues();
    const boundary = new TextureUploadBoundary(issues);
    const pixels = new Uint8Array(4);
    boundary.upload("node", "n", 1, 1, pixels, () => undefined, { sourceKey: "card" });
    boundary.upload("node", "n", 1, 1, pixels, () => { throw "focus failed"; }, { sourceKey: "focus" });
    boundary.upload("node", "n", 1, 1, pixels, () => undefined, { sourceKey: "card", preserveFailure: true });
    expect(issues.getSnapshot()[0]?.retainedPreview).toBe(true);
    boundary.upload("node", "n", 1, 1, pixels, () => undefined, { sourceKey: "replacement" });
    expect(issues.getSnapshot()).toEqual([]);
  });
  it("非法尺寸在调用前拒绝，未成功上传不宣称有旧预览；删除清理故障缓存", () => {
    const issues = new RuntimeIssues();
    const boundary = new TextureUploadBoundary(issues);
    const invoke = vi.fn();
    // 超过 Bevy 纹理硬上限（4096）的尺寸必须在调用前拒绝。
    expect(boundary.upload("node", "n", 8192, 1, new Uint8Array(8192 * 4), invoke)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(issues.getSnapshot()[0]?.retainedPreview).toBe(false);
    boundary.retain(new Set(), new Set());
    expect(issues.getSnapshot()).toEqual([]);
  });
});
