/**
 * 图片预览 owner 回落顺序（change: default-image-focus-viewer）。
 *
 * 历史面板换旧版本时要有「把中央画面换成只读媒体」的能力。编辑器扩展（`imageEdit`）与宿主
 * 默认查看器（`imageView`）都提供同形子集；编辑器必须始终优先（它拥有文档与写回语义），
 * 两者都缺时返回 undefined 由调用方降级。
 */
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { IMAGE_EDIT_SERVICE, IMAGE_VIEW_SERVICE, resolveImagePreviewOwner } from "./service-keys.js";

function ctxWith(services: Record<string, unknown>): Context {
  return { get: (key: string) => services[key] } as unknown as Context;
}

const editor = { isActive: () => true, nodeId: () => "n1", setHistoryOverride: () => undefined, draftState: () => "saved" as const };
const viewer = { isActive: () => false, nodeId: () => null, setHistoryOverride: () => undefined, draftState: () => "saved" as const };

describe("图片预览 owner 回落", () => {
  it("编辑器在场时始终优先（查看器不抢）", () => {
    const ctx = ctxWith({ [IMAGE_EDIT_SERVICE]: editor, [IMAGE_VIEW_SERVICE]: viewer });
    expect(resolveImagePreviewOwner(ctx)).toBe(editor);
  });

  it("编辑器缺席时回落到宿主默认查看器", () => {
    const ctx = ctxWith({ [IMAGE_VIEW_SERVICE]: viewer });
    expect(resolveImagePreviewOwner(ctx)).toBe(viewer);
  });

  it("两者都缺席时返回 undefined（调用方按不可用降级）", () => {
    expect(resolveImagePreviewOwner(ctxWith({}))).toBeUndefined();
  });
});
