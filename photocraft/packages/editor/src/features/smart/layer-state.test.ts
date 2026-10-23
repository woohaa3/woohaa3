/**
 * 智能层可用性投影的消费侧回归（U65/U66）。
 *
 * 只校验解码：不可用入口必须带原因，越界/自相矛盾的投影整体拒绝。
 */
import { describe, expect, it } from "vitest";
import { FALLBACK_SOURCE_NAME, decodeSmartLayerState, isDeliverableSourceName } from "./layer-state.js";

const valid = {
  layer: 7,
  smart: true,
  contentsId: 12,
  source: { kind: "embedded", fileName: "contents.pcraft", bytes: 512 },
  childOpen: false,
  canExport: true,
  canReplace: true,
  canEditContents: true,
  canConvertToLayers: true,
  exportReason: "",
  replaceReason: "",
  convertReason: "",
  editReason: "",
  reason: ""
} as const;

describe("智能层状态解码", () => {
  it("接受完整的可用状态", () => {
    expect(decodeSmartLayerState(valid)).toEqual({
      ...valid,
      source: { kind: "embedded", fileName: "contents.pcraft", bytes: 512 }
    });
  });

  it("不可用的入口必须给出自己的原因", () => {
    expect(decodeSmartLayerState({ ...valid, canReplace: false })).toBeNull();
    expect(decodeSmartLayerState({ ...valid, canExport: false })).toBeNull();
    expect(decodeSmartLayerState({ ...valid, canConvertToLayers: false })).toBeNull();
    expect(decodeSmartLayerState({ ...valid, canEditContents: false })).toBeNull();
    expect(
      decodeSmartLayerState({ ...valid, canConvertToLayers: false, convertReason: "子文档仍在编辑中" })
    ).toMatchObject({ canConvertToLayers: false, convertReason: "子文档仍在编辑中" });
  });

  it("替换/导出与子会话状态解耦：childOpen 不影响父层入口", () => {
    const open = decodeSmartLayerState({ ...valid, childOpen: true });
    expect(open).toMatchObject({ childOpen: true, canReplace: true, canExport: true });
  });

  it("拒绝越界、错误类型、路径名与缺失字段", () => {
    for (const state of [
      null,
      [],
      "smart",
      { ...valid, layer: -1 },
      { ...valid, layer: 1.5 },
      { ...valid, contentsId: undefined },
      { ...valid, source: { kind: "embedded", fileName: "contents.pcraft" } },
      { ...valid, source: { kind: "embedded", fileName: "", bytes: 4 } },
      { ...valid, source: { kind: "embedded", fileName: "a/b.pcraft", bytes: 4 } },
      { ...valid, source: { kind: "remote", fileName: "a.pcraft", bytes: 4 } },
      { ...valid, childOpen: "no" },
      { ...valid, reason: 42 },
      { ...valid, replaceReason: "x".repeat(201) }
    ]) {
      expect(decodeSmartLayerState(state)).toBeNull();
    }
  });

  it("非智能图层返回结构化原因而不是成功态", () => {
    const plain = decodeSmartLayerState({
      layer: 3,
      smart: false,
      reason: "请先选择智能对象图层"
    });
    expect(plain).toMatchObject({ layer: 3, smart: false, canExport: false, canConvertToLayers: false });
    expect(decodeSmartLayerState({ layer: 3, smart: false, reason: "" })).toBeNull();
    expect(decodeSmartLayerState({ layer: 3, smart: false })).toBeNull();
  });

  it("外链源不报告字节数，仍保留拒绝原因", () => {
    const linked = decodeSmartLayerState({
      ...valid,
      source: { kind: "linked", fileName: "shared.psd" },
      canReplace: false,
      replaceReason: "外链智能对象保持 NON_GOALS，仅支持嵌入源",
      canExport: false,
      exportReason: "外链智能对象保持 NON_GOALS，仅支持嵌入源",
      canConvertToLayers: false,
      convertReason: "外链智能对象保持 NON_GOALS，仅支持嵌入源",
      reason: "外链智能对象保持 NON_GOALS，仅支持嵌入源"
    });
    expect(linked?.source).toEqual({ kind: "linked", fileName: "shared.psd" });
    expect(linked?.canReplace).toBe(false);
  });
});

describe("导出源文件名", () => {
  it("接受普通工程名，拒绝路径与控制字符", () => {
    for (const name of ["contents.pcraft", "source.psd", "图 1.png"]) expect(isDeliverableSourceName(name)).toBe(true);
    for (const name of ["", "  ", "a/b.pcraft", "a\\b.pcraft", "C:name.pcraft", "a\u0000b.pcraft", "noext", null, 3]) {
      expect(isDeliverableSourceName(name)).toBe(false);
    }
  });

  it("兜底名本身可交付", () => {
    expect(isDeliverableSourceName(FALLBACK_SOURCE_NAME)).toBe(true);
  });
});
