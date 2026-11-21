import { describe, expect, it, vi } from "vitest";
import { TextureUploadBoundary } from "./texture-upload-boundary.js";
import { RuntimeIssues } from "./runtime-issues.js";
import type { CanvasScope } from "./canvas-scope.js";

describe("纹理失败隔离", () => {
  it("提交不是应用，换源和重建丢弃旧回执", () => {
    const boundary = new TextureUploadBoundary(new RuntimeIssues());
    const submit = (sourceKey: string) => boundary.upload("node", "n", 1, 1, new Uint8Array(4), () => {}, { sourceKey });
    submit("old");
    expect(boundary.applied("node", "n", 1, 1, "old")).toBe(false);
    submit("new");
    boundary.acceptReceipts(JSON.stringify([["node", "n", 1, 1, "old"]]));
    expect(boundary.applied("node", "n", 1, 1, "new")).toBe(false);
    boundary.acceptReceipts(JSON.stringify([["node", "n", 1, 1, "new"]]));
    expect(boundary.applied("node", "n", 1, 1, "new")).toBe(true);
    boundary.reset();
    expect(boundary.applied("node", "n", 1, 1, "new")).toBe(false);
  });
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
    expect(boundary.upload("node", "n", 4096, 1, new Uint8Array(4096 * 4), invoke)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(issues.getSnapshot()[0]?.retainedPreview).toBe(false);
    boundary.retain(new Set(), new Set());
    expect(issues.getSnapshot()).toEqual([]);
  });
});

describe("纹理零拷贝复用标记", () => {
  const scope = (token: string): CanvasScope => Object.freeze({ canvasId: `canvas-${token}`, token, sequence: Number(token) });
  /** 绑定一次并回传 runtime 侧收到的 alreadyShared：true 表示该源/尺寸的像素已上传过，只需轻量绑定。 */
  const bind = (boundary: TextureUploadBoundary, input: { nodeId: string; sourceKey?: string; scope?: CanvasScope; width?: number; height?: number; channel?: "node" | "plane" }): boolean | undefined => {
    const width = input.width ?? 4, height = input.height ?? 4;
    let alreadyShared: boolean | undefined;
    const source = input.sourceKey !== undefined
      ? { sourceKey: input.sourceKey, ...(input.scope ? { scope: input.scope } : {}) }
      : undefined;
    const accepted = boundary.upload(input.channel ?? "node", input.nodeId, width, height, new Uint8Array(width * height * 4),
      shared => { alreadyShared = shared; },
      source);
    expect(accepted).toBe(true);
    return alreadyShared;
  };

  it("同一 scope 下两个节点绑定同源同尺寸纹理：首次全量，第二次命中复用", () => {
    const boundary = new TextureUploadBoundary(new RuntimeIssues());
    const current = scope("1");
    expect(bind(boundary, { nodeId: "n1", sourceKey: "sha256-video", scope: current })).toBe(false);
    expect(bind(boundary, { nodeId: "n2", sourceKey: "sha256-video", scope: current })).toBe(true);
    // 已共享的源再次绑回首个节点也走轻量路径。
    expect(bind(boundary, { nodeId: "n1", sourceKey: "sha256-video", scope: current })).toBe(true);
  });

  it("源标识、尺寸、scope 或通道不同都不算复用", () => {
    const boundary = new TextureUploadBoundary(new RuntimeIssues());
    const current = scope("1");
    expect(bind(boundary, { nodeId: "n1", sourceKey: "sha256-video", scope: current })).toBe(false);
    expect(bind(boundary, { nodeId: "n2", sourceKey: "sha256-other", scope: current })).toBe(false);
    expect(bind(boundary, { nodeId: "n3", sourceKey: "sha256-video", scope: current, width: 8, height: 8 })).toBe(false);
    expect(bind(boundary, { nodeId: "n4", sourceKey: "sha256-video", scope: scope("2") })).toBe(false);
    // 平面通道与按像素身份（无 sourceKey）的绑定不进入共享表。
    expect(bind(boundary, { nodeId: "p1", sourceKey: "sha256-video", scope: current, channel: "plane" })).toBe(false);
    expect(bind(boundary, { nodeId: "p1", sourceKey: "sha256-video", scope: current, channel: "plane" })).toBe(false);
    expect(bind(boundary, { nodeId: "anon-1" })).toBe(false);
    expect(bind(boundary, { nodeId: "anon-2" })).toBe(false);
  });

  it("reset、retry 或 scope 清空（retain 空集合）后复用标记重新归零", () => {
    const boundary = new TextureUploadBoundary(new RuntimeIssues());
    const current = scope("1");
    const rebind = () => bind(boundary, { nodeId: "n", sourceKey: "sha256-video", scope: current });
    expect(rebind()).toBe(false);
    expect(rebind()).toBe(true);
    boundary.reset();
    expect(rebind()).toBe(false);
    expect(rebind()).toBe(true);
    boundary.retry();
    expect(rebind()).toBe(false);
    expect(rebind()).toBe(true);
    boundary.retain(new Set(), new Set());
    expect(rebind()).toBe(false);
  });

  it("失败的上传不写入共享表：同源后续节点仍按首次上传", () => {
    const issues = new RuntimeIssues();
    const boundary = new TextureUploadBoundary(issues);
    const current = scope("1");
    const failing = vi.fn(() => { throw "Invalid texture"; });
    expect(boundary.upload("node", "bad", 4, 4, new Uint8Array(4 * 4 * 4), failing, { sourceKey: "sha256-video", scope: current })).toBe(false);
    expect(failing).toHaveBeenCalledWith(false);
    expect(issues.getSnapshot()).toHaveLength(1);
    expect(bind(boundary, { nodeId: "n1", sourceKey: "sha256-video", scope: current })).toBe(false);
    expect(bind(boundary, { nodeId: "n2", sourceKey: "sha256-video", scope: current })).toBe(true);
  });
});
