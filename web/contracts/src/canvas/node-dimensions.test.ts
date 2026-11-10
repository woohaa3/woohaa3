/**
 * 共享卡片尺寸规则（change: 2026-11-10-remove-legacy-model-card-nodes）。
 *
 * 尺寸只服务 2D 卡片：模型没有卡片，`effectiveCanvasNodeSize` 不再为 `model3d` 做
 * 248×232 / 196×64 的预览卡片扩展，也不再恢复模型最小预览高度。
 */
import { describe, expect, it } from "vitest";
import {
  COMPOSITE_ASSET_DEFAULT_SIZE,
  RICH_CONTENT_NODE_SIZE,
  compositeAssetNodeBoxSize,
  effectiveCanvasNodeSize,
} from "./node-dimensions.js";

describe("effectiveCanvasNodeSize", () => {
  it("文本卡片与复合资产使用各自尺寸", () => {
    expect(effectiveCanvasNodeSize({ type: "text" })).toEqual(RICH_CONTENT_NODE_SIZE);
    expect(effectiveCanvasNodeSize({ type: "text", width: 300, height: 250 })).toEqual({ width: 300, height: 250 });
    expect(effectiveCanvasNodeSize({ type: "composite-asset" })).toEqual(COMPOSITE_ASSET_DEFAULT_SIZE);
    expect(compositeAssetNodeBoxSize({})).toEqual(COMPOSITE_ASSET_DEFAULT_SIZE);
  });

  it("无卡片模型不做预览卡片扩展", () => {
    expect(effectiveCanvasNodeSize({ type: "model3d", width: 196, height: 64 })).toEqual({ width: 196, height: 64 });
    expect(effectiveCanvasNodeSize({ type: "model3d", width: 320, height: 117 })).toEqual({ width: 320, height: 117 });
    // 缺省只按共享最小尺寸与默认尺寸收敛，不会变成 196×64 或 248×232 的卡片。
    expect(effectiveCanvasNodeSize({ type: "model3d" })).toEqual(RICH_CONTENT_NODE_SIZE);
  });

  it("低于共享下限的尺寸收敛到下限", () => {
    expect(effectiveCanvasNodeSize({ type: "text", width: 10, height: 10 })).toEqual({ width: 180, height: 64 });
  });
});
