/**
 * 通道域纯函数回归（change: 2026-10-22-add-photocraft-channel-workflows，U25/U26）。
 *
 * 只锁定「快照解码 / 引用编码 / 参数编译」；真实像素与事务在 Rust 域测试里，
 * 面板事件在 `panel.test.tsx` 里。
 */
import { expect, it } from "vitest";
import {
  BLENDINGS,
  activeDocumentIndex,
  applyImageParams,
  calculationsParams,
  channelReference,
  decodeChannelSnapshot,
  defaultApplyImageForm,
  defaultCalculationsForm,
  referenceCode,
  sourceChannelOptions,
  targetCode,
  targetSelectionReference,
  usesScaleOffset,
  type ChannelSnapshot
} from "./model.js";

const SNAPSHOT = {
  composite: "RGB",
  compositeVisible: true,
  colors: [
    { index: 0, name: "Red", visible: true, reference: { color: 0 } },
    { index: 1, name: "Green", visible: true, reference: { color: 1 } },
    { index: 2, name: "Blue", visible: true, reference: { color: 2 } }
  ],
  alpha: [
    { index: 0, name: "Alpha 1", visible: true, kind: "alpha", color: [1, 0, 0], opacity: 0.5, indicates: "maskedAreas", spot: null, reference: { alpha: 0 } },
    { index: 1, name: "专色绿", visible: false, kind: "spot", color: [0, 1, 0], opacity: 0.5, indicates: "maskedAreas", spot: { color: [0, 1, 0], solidity: 0.6 } }
  ],
  target: { kind: "composite" },
  documents: [
    { index: 0, name: "art", width: 8, height: 6, grayscale: false, sameSize: true, active: true,
      colorNames: ["Red", "Green", "Blue"],
      alpha: [{ index: 0, name: "Alpha 1", kind: "alpha" }, { index: 1, name: "专色绿", kind: "spot" }] },
    { index: 1, name: "art_R", width: 8, height: 6, grayscale: true, sameSize: true, active: false },
    { index: 2, name: "other", width: 4, height: 4, grayscale: true, sameSize: false, active: false }
  ],
  documentId: 3,
  revision: 12,
  maxOpenDocuments: 8,
  spotCount: 1,
  hasSelection: true,
  quickMask: null
};

function decoded(): ChannelSnapshot {
  const snapshot = decodeChannelSnapshot(SNAPSHOT);
  expect(snapshot).not.toBeNull();
  return snapshot!;
}

it("解码通道快照：颜色行、Alpha/专色、目标与来源文档", () => {
  const snapshot = decoded();
  expect(snapshot.composite).toBe("RGB");
  expect(snapshot.colors.map((row) => row.name)).toEqual(["Red", "Green", "Blue"]);
  expect(snapshot.alpha[0]).toMatchObject({ kind: "alpha", color: "#ff0000", opacity: 50, indicates: "masked" });
  expect(snapshot.alpha[1]).toMatchObject({ kind: "spot", spot: { color: "#00ff00", solidity: 60 } });
  expect(snapshot.target).toEqual({ kind: "composite", index: null });
  expect(snapshot.documents.map((row) => row.sameSize)).toEqual([true, true, false]);
  expect(snapshot).toMatchObject({ documentId: 3, revision: 12, spotCount: 1, hasSelection: true, maxOpenDocuments: 8 });
});

it("非法快照整体拒绝，不渲染半截通道行", () => {
  expect(decodeChannelSnapshot(null)).toBeNull();
  expect(decodeChannelSnapshot("rgb")).toBeNull();
  expect(decodeChannelSnapshot({ ...SNAPSHOT, target: { kind: "channel" } })).toBeNull();
  expect(decodeChannelSnapshot({ ...SNAPSHOT, colors: [{ index: 0, visible: true }] })).toBeNull();
  expect(decodeChannelSnapshot({ ...SNAPSHOT, alpha: [{ index: 0, name: "A", visible: "yes" }] })).toBeNull();
  expect(decodeChannelSnapshot({ ...SNAPSHOT, documents: [{ index: 0, name: "a" }] })).toBeNull();
  // 预算行数越界同样拒绝（内核不会产出，但界面不能因此渲染超量行）。
  expect(decodeChannelSnapshot({ ...SNAPSHOT, documents: new Array(9).fill(SNAPSHOT.documents[0]) })).toBeNull();
});

it("通道编码与内核 parse_ref 形状一一对应，未知引用返回 null", () => {
  expect(channelReference("composite")).toBe("composite");
  expect(channelReference("color:1")).toEqual({ color: 1 });
  expect(channelReference("alpha:2")).toEqual({ alpha: 2 });
  expect(channelReference("mask")).toBe("mask");
  expect(channelReference("color:-1")).toBeNull();
  expect(channelReference("color:x")).toBeNull();
  expect(channelReference("alpha:1.5")).toBeNull();
  expect(channelReference("vectorMask")).toBeNull();
  expect(referenceCode({ color: 3 })).toBe("color:3");
  expect(referenceCode({ alpha: 0 })).toBe("alpha:0");
  expect(referenceCode("selection")).toBe("selection");
  expect(referenceCode("bogus")).toBeNull();
  expect(referenceCode({ spot: 1 })).toBeNull();
});

it("目标与载入选区引用来自同一条目标状态", () => {
  const snapshot = decoded();
  expect(targetCode(snapshot)).toBe("composite");
  expect(targetSelectionReference(snapshot)).toBe("composite");
  expect(targetCode({ ...snapshot, target: { kind: "color", index: 2 } })).toBe("color:2");
  expect(targetSelectionReference({ ...snapshot, target: { kind: "alpha", index: 1 } })).toEqual({ alpha: 1 });
  // 图层蒙版目标没有对应面板行，也不猜一个替代引用。
  expect(targetCode({ ...snapshot, target: { kind: "layerMask", index: null } })).toBeNull();
  expect(targetSelectionReference({ ...snapshot, target: { kind: "layerMask", index: null } })).toBeNull();
});

it("来源通道选项按所选来源文档自身展开，非活动文档也能选分量与 Alpha", () => {
  const snapshot = decoded();
  // 蒙版来源按**活动**文档解析，不跟源文档下拉走。
  expect(activeDocumentIndex(snapshot)).toBe(0);
  expect(activeDocumentIndex({ ...snapshot, documents: snapshot.documents.map((row) => ({ ...row, active: row.index === 2 })) })).toBe(2);
  expect(activeDocumentIndex({ ...snapshot, documents: [] })).toBe(0);
  const active = sourceChannelOptions(snapshot, 0).map((option) => option.value);
  expect(active).toContain("color:0");
  expect(active).toContain("alpha:1");
  expect(active).toContain("transparency");
  // 非活动灰度文档只给 Gray + 透明度，不借用活动文档的 RGB 名字。
  expect(sourceChannelOptions(snapshot, 1).map((option) => option.value)).toEqual(["composite", "transparency"]);
  expect(sourceChannelOptions(snapshot, 1)[0]!.label).toBe("Gray");
  // 内核按文档自报的清单优先：非活动文档自己的 Alpha 行可被选中。
  const withOwnAlpha = decodeChannelSnapshot({
    ...SNAPSHOT,
    documents: [
      SNAPSHOT.documents[0],
      { ...SNAPSHOT.documents[1], colorNames: ["Gray"], alpha: [{ index: 0, name: "源蒙版", kind: "alpha" }, { index: 1, name: "源专色", kind: "spot" }] }
    ]
  })!;
  expect(sourceChannelOptions(withOwnAlpha, 1).map((option) => option.value))
    .toEqual(["composite", "transparency", "alpha:0", "alpha:1"]);
  expect(sourceChannelOptions(withOwnAlpha, 1).at(-1)!.label).toBe("源专色（专色）");
});

it("应用图像参数：来源、混合、scale/offset 只在加减时发送", () => {
  const snapshot = decoded();
  const form = defaultApplyImageForm(snapshot);
  expect(form.target).toBe("pixels");
  const base = applyImageParams({
    ...form,
    source: { document: 1, layer: "art_R", channel: "color:0", invert: true },
    blending: "multiply",
    opacity: 80
  });
  expect(base).toMatchObject({
    source: { document: 1, layer: "art_R", channel: { color: 0 }, invert: true },
    blending: "multiply",
    opacity: 80
  });
  expect(base).not.toHaveProperty("scale");
  expect(base).not.toHaveProperty("offset");
  // 数字图层写成图层 id，名字保持字符串。
  expect(applyImageParams({ ...form, source: { document: 0, layer: "12", channel: "composite", invert: false } }).source).toEqual({ document: 0, layer: 12, channel: "composite" });
  const add = applyImageParams({ ...form, blending: "add", scale: 2, offset: 12 });
  expect(add).toMatchObject({ blending: "add", scale: 2, offset: 12 });
  expect(usesScaleOffset("add")).toBe(true);
  expect(usesScaleOffset("subtract")).toBe(true);
  expect(usesScaleOffset("screen")).toBe(false);
});

it("应用图像参数：目标和蒙版使用可回传的引用形状", () => {
  const snapshot = decoded();
  const form = defaultApplyImageForm({ ...snapshot, target: { kind: "alpha", index: 1 } });
  // 通道目标是 Alpha 时默认写回该通道。
  expect(form.target).toBe("alpha:1");
  const params = applyImageParams({ ...form, maskChannel: "alpha:0", preserveTransparency: true });
  expect(params.target).toEqual({ channel: 1 });
  expect(params.mask).toEqual({ channel: { alpha: 0 } });
  expect(params.preserveTransparency).toBe(true);
  // 图层蒙版目标内核只写像素，界面不发送该目标（内核另有明确拒绝）。
  expect(applyImageParams({ ...form, target: "mask" }).target).toBeUndefined();
  // 越界数值收敛到内核接受的区间，而不是把非法值发过去。
  expect(applyImageParams({ ...form, opacity: 400, blending: "subtract", scale: 9, offset: -900 })).toMatchObject({ opacity: 100, scale: 2, offset: -255 });
});

it("计算参数：两源 + 输出 + 名称，未知混合回落到 multiply", () => {
  const snapshot = decoded();
  const form = defaultCalculationsForm(snapshot);
  expect(form.result).toBe("newChannel");
  const params = calculationsParams({
    ...form,
    source1: { document: 0, layer: "", channel: "alpha:0", invert: true },
    source2: { document: 0, layer: "", channel: "alpha:1", invert: false },
    blending: "screen",
    opacity: 50,
    result: "selection"
  });
  expect(params).toMatchObject({
    source1: { document: 0, channel: { alpha: 0 }, invert: true },
    source2: { document: 0, channel: { alpha: 1 } },
    blending: "screen",
    opacity: 50,
    result: "selection"
  });
  expect(params).not.toHaveProperty("name");
  expect(calculationsParams({ ...form, blending: "not-a-mode" }).blending).toBe("multiply");
  expect(calculationsParams({ ...form, name: "结果" }).name).toBe("结果");
  // 名称上限与内核 NAME_MAX 一致；更长时截断而不是让命令被拒绝。
  expect((calculationsParams({ ...form, name: "字".repeat(300) }).name as string).length).toBe(200);
});

it("混合模式清单全部是内核可解析的分离型模式", () => {
  expect(BLENDINGS).toContain("normal");
  expect(BLENDINGS).toContain("add");
  expect(BLENDINGS).toContain("subtract");
  // 不可分离模式（色相/饱和度/颜色/明度）不在清单里：内核会拒绝。
  for (const mode of ["hue", "saturation", "color", "luminosity", "dissolve", "passThrough"]) {
    expect(BLENDINGS).not.toContain(mode);
  }
});
