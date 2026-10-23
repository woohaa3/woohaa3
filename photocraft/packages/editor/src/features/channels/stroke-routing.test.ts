// 通道目标的笔迹路由与主画布单通道视图（change: 2026-10-22-add-photocraft-channel-workflows，任务 2.1）。
//
// 这两条是「画布真的把像素写进当前通道」的域内保证：
// - Alpha/专色目标必须显式给出 `target:{channel:i}`，因为上游 `inject_target` 只在调用方
//   没有 `target` 时注入，而笔刷始终带 `target`；
// - RGB 分量目标不在这里限制，由内核按当前 `channel_view` 处理（`color_restriction`）。
import { describe, expect, it } from "vitest";
import { buildStroke, DEFAULT_BRUSH, type BrushSettings } from "../../photo-editor-tools.js";
import { channelTargetCode, decodeEditorState, type EditorChannelTarget } from "../../editor-view-model.js";

const points = [{ x: 2, y: 3 }];

describe("通道目标的笔迹参数", () => {
  it("Alpha/专色目标写进 target.channel，不落到图层像素", () => {
    const params = buildStroke(points, { ...DEFAULT_BRUSH, target: "pixels" }, { channel: 2 })!;
    expect(params.target).toEqual({ channel: 2 });
    // 不能同时存在像素目标：上游先看 `target` 是否已给，重复给会静默写错地方。
    expect(params.target).not.toBe("pixels");
  });

  it("没有通道目标时保持 pixels/mask 的原有行为", () => {
    expect(buildStroke(points, DEFAULT_BRUSH)!.target).toBe("pixels");
    expect(buildStroke(points, { ...DEFAULT_BRUSH, target: "mask" })!.target).toBe("mask");
    // 显式 undefined 与省略等价：面板没开通道时不能改变既有落笔目标。
    expect(buildStroke(points, DEFAULT_BRUSH, { channel: undefined })!.target).toBe("pixels");
  });

  it("通道目标覆盖笔刷的 mask 目标（通道与图层蒙版互斥）", () => {
    const brush: BrushSettings = { ...DEFAULT_BRUSH, target: "mask" };
    expect(buildStroke(points, brush, { channel: 0 })!.target).toEqual({ channel: 0 });
  });
});

describe("通道目标解码", () => {
  const document = (channels: unknown) => ({
    channelTarget: { kind: "composite" },

    name: "工程", width: 16, height: 16, mode: "RGB", depth: 8, activeLayer: 0, selectedLayers: [],
    hasSelection: false, editTarget: "pixels", channels, layers: [], revision: 1
  });

  it("复合/分量/Alpha/图层蒙版各自解码，非法值退化成复合", () => {
    const target = (channels: unknown) => decodeEditorState({ document: document(channels) })!.document!.channelTarget;
    expect(target({ target: { kind: "composite" } })).toEqual({ kind: "composite" });
    expect(target({ target: { kind: "color", index: 1 } })).toEqual({ kind: "color", index: 1 });
    expect(target({ target: { kind: "alpha", index: 0 } })).toEqual({ kind: "alpha", index: 0 });
    expect(target({ target: { kind: "layerMask" } })).toEqual({ kind: "layerMask" });
    // 缺字段、索引非法、未知种类都退化成复合：界面不能因为查看态坏掉而拒绝整份文档。
    expect(target(undefined)).toEqual({ kind: "composite" });
    expect(target({ target: null })).toEqual({ kind: "composite" });
    expect(target({ target: { kind: "alpha", index: -1 } })).toEqual({ kind: "composite" });
    expect(target({ target: { kind: "alpha" } })).toEqual({ kind: "composite" });
    expect(target({ target: { kind: "spot", index: 0 } })).toEqual({ kind: "composite" });
  });

  it("只有分量/Alpha 有目标编码；复合与图层蒙版没有可载入的通道引用", () => {
    const code = (target: EditorChannelTarget) => channelTargetCode(target);
    expect(code({ kind: "color", index: 2 })).toBe("color:2");
    expect(code({ kind: "alpha", index: 0 })).toBe("alpha:0");
    expect(code({ kind: "composite" })).toBeNull();
    expect(code({ kind: "layerMask" })).toBeNull();
  });
});
