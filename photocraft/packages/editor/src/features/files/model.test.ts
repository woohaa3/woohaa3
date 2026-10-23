/**
 * 本域界面模型的解码回归（change: 2026-10-22-add-photocraft-file-workflows，U01–U04）。
 *
 * 内核 JSON 一律当作不可信输入：结构错、尺寸对不上、字段超限都必须在进入界面之前失败，
 * 不能渲染半截数据或把坏条目当成「没有预设」。
 */
import { describe, expect, it } from "vitest";
import { FILE_INFO_LIMITS, NEW_DOCUMENT_LIMITS } from "@woohaa3/photocraft-protocol";
import {
  canCreateInSession,
  decodeCreateDocumentReport,
  decodeCreateFromImageReport,
  decodeFileInfo,
  decodePresetList,
  decodeRecentList,
  decodeRestoreReport,
  fileInfoToForm,
  formToFileInfoPatch,
  kernelParamsFromSpec,
  presetParams,
  recentSettingsParams,
  sameFileInfoForm,
  specFromKernelSettings
} from "./model.js";

const SPEC = {
  width: 640,
  height: 480,
  resolution: 72,
  mode: "rgb",
  depth: 8,
  background: "white",
  name: "未命名"
} as const;

describe("U01 新建结果必须与内核真实状态一致", () => {
  it("解码尺寸、分辨率、背景与最近簿记结果", () => {
    const decoded = decodeCreateDocumentReport({
      name: "海报",
      width: 640,
      height: 480,
      resolution: 300,
      mode: "rgb",
      depth: 8,
      background: "transparent",
      recentRecorded: true,
      state: { document: { width: 640, height: 480, name: "海报" } }
    });
    expect(decoded).toEqual({
      ok: true,
      value: {
        name: "海报",
        width: 640,
        height: 480,
        resolution: 300,
        background: "transparent",
        documentName: "海报",
        recentRecorded: true
      }
    });
  });

  it("内核文档尺寸与报告不一致时拒绝，而不是显示期望值", () => {
    expect(decodeCreateDocumentReport({
      width: 640,
      height: 480,
      resolution: 72,
      state: { document: { width: 641, height: 480 } }
    })).toEqual({ ok: false, error: "新建结果与内核文档尺寸不一致" });
  });

  it("缺尺寸/分辨率或非对象一律失败", () => {
    expect(decodeCreateDocumentReport({ width: 640, height: 480 })).toMatchObject({ ok: false });
    expect(decodeCreateDocumentReport({ width: "640", height: 480, resolution: 72 })).toMatchObject({ ok: false });
    expect(decodeCreateDocumentReport(null)).toMatchObject({ ok: false });
    expect(decodeCreateDocumentReport([])).toMatchObject({ ok: false });
  });

  it("簿记失败不影响已创建文档，但如实报告 recentRecorded=false", () => {
    const decoded = decodeCreateDocumentReport({ width: 8, height: 8, resolution: 72, recentRecorded: false });
    expect(decoded.ok && decoded.value.recentRecorded).toBe(false);
  });

  it("来源图片报告丢弃非字符串告警并拒绝非法尺寸", () => {
    expect(decodeCreateFromImageReport({ name: "剪贴板", width: 40, height: 24, warnings: ["a", 3] }))
      .toEqual({ ok: true, value: { name: "剪贴板", width: 40, height: 24, warnings: ["a"] } });
    expect(decodeCreateFromImageReport({ width: 0, height: 24 })).toEqual({ ok: false, error: "图片尺寸无效" });
    expect(decodeCreateFromImageReport({ width: 40 })).toMatchObject({ ok: false });
  });

  it("新建参数只带内核认识的键，预设/最近设置去掉文档名并带显示单位", () => {
    const spec = { ...SPEC, width: 1080, height: 1080 } as never;
    expect(kernelParamsFromSpec(spec)).toEqual({
      width: 1080, height: 1080, resolution: 72, mode: "rgb", depth: 8, background: "white", name: "未命名"
    });
    // `DocumentSettings` 不接受 `name`：预设名在外层，最近设置没有名字。带上会被内核整体拒绝。
    expect(presetParams(spec)).toEqual({
      width: 1080, height: 1080, resolution: 72, mode: "rgb", depth: 8, background: "white",
      unit: "px", resolutionUnit: "in"
    });
    expect(recentSettingsParams(spec)).toEqual({
      width: 1080, height: 1080, resolution: 72, mode: "rgb", depth: 8, background: "white"
    });
    expect(presetParams(spec)).not.toHaveProperty("name");
    expect(recentSettingsParams(spec)).not.toHaveProperty("name");
  });

  it("有文档的会话不能直接新建（需要独立文档槽位）", () => {
    expect(canCreateInSession(false)).toEqual({ ok: true });
    const refused = canCreateInSession(true);
    expect(refused.ok).toBe(false);
    expect(refused).toMatchObject({ reason: expect.stringContaining("独立文档槽位") });
  });
});

describe("U04 预设/最近设置解码逐条容错", () => {
  it("跳过坏条目与重复名称，保留可用的预设", () => {
    const decoded = decodePresetList({
      presets: [
        { name: "  方形  ", settings: { width: 1080, height: 1080, resolution: 300 } },
        { name: "方形", settings: { width: 10, height: 10 } },
        { name: "坏尺寸", settings: { width: 0, height: 10 } },
        { name: "  ", settings: { width: 10, height: 10 } },
        { name: "x".repeat(NEW_DOCUMENT_LIMITS.maxNameChars + 1), settings: { width: 10, height: 10 } },
        null,
        "x"
      ]
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.map((preset) => preset.name)).toEqual(["方形"]);
    expect(decoded.value[0]?.settings).toMatchObject({ width: 1080, height: 1080, resolution: 300, mode: "rgb", depth: 8 });
  });

  it("列表结构不对时明确失败，不冒充空列表", () => {
    expect(decodePresetList({})).toEqual({ ok: false, error: "预设列表结构非法" });
    expect(decodePresetList(null)).toMatchObject({ ok: false });
    expect(decodeRecentList({ recent: "20" })).toMatchObject({ ok: false });
  });

  it("最近设置保持内核给出的最新在前顺序、按设置去重且有界", () => {
    const entries = [
      { width: 64, height: 32, resolution: 150 },
      { width: 64, height: 32, resolution: 150 },
      { width: 8, height: 8 },
      { width: 0, height: 8 }
    ];
    for (let width = 200; width < 240; width += 1) entries.push({ width, height: 10 } as never);
    const decoded = decodeRecentList({ recent: entries });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // 顺序由内核决定（它已经是最新在前），界面只去重并截断，不重新排序冒充更近。
    expect(decoded.value).toHaveLength(NEW_DOCUMENT_LIMITS.maxRecent);
    expect(decoded.value[0]).toMatchObject({ width: 64, height: 32 });
    expect(decoded.value[1]).toMatchObject({ width: 8, height: 8 });
    expect(decoded.value.filter((entry) => entry.width === 64)).toHaveLength(1);
    expect(decoded.value.some((entry) => entry.width === 0)).toBe(false);
  });

  it("不认识的模式/位深按不可用处理", () => {
    expect(specFromKernelSettings({ width: 10, height: 10, mode: "cmyk" })).toBeNull();
    expect(specFromKernelSettings({ width: 10, height: 10, depth: 16 })).toBeNull();
    expect(specFromKernelSettings({ width: 10, height: 10 })).toMatchObject({ width: 10, resolution: 72 });
    expect(specFromKernelSettings("10×10")).toBeNull();
  });
});

describe("U04 File Info 有界读写", () => {
  it("解码已知字段与只读相机块，未知键丢弃", () => {
    const decoded = decodeFileInfo({
      title: "封面",
      author: "摄影组",
      keywords: ["a", 3, "b"],
      camera: { make: "Canon", model: "R5", iso: "400", unknown: "x" },
      unknownField: "ignored"
    });
    expect(decoded).toEqual({
      ok: true,
      value: {
        title: "封面",
        author: "摄影组",
        keywords: ["a", "b"],
        camera: { make: "Canon", model: "R5", iso: "400" }
      }
    });
  });

  it("引擎把关键字写成单串时按分隔符拆开", () => {
    const decoded = decodeFileInfo({ keywords: "海报; 样张,封面" });
    expect(decoded).toMatchObject({ ok: true, value: { keywords: ["海报", "样张", "封面"] } });
  });

  it("超长或类型错误的字段整体拒绝（不静默截断）", () => {
    expect(decodeFileInfo({ title: "x".repeat(FILE_INFO_LIMITS.maxFieldChars + 1) }))
      .toEqual({ ok: false, error: "File Info 字段超长" });
    expect(decodeFileInfo({ title: 42 })).toEqual({ ok: false, error: "File Info 字段结构非法" });
    expect(decodeFileInfo({ keywords: 42 })).toEqual({ ok: false, error: "File Info 关键字结构非法" });
    expect(decodeFileInfo([])).toMatchObject({ ok: false });
  });

  it("表单↔内核 patch 往返保留关键字与版权状态", () => {
    const form = fileInfoToForm({ title: "封面", keywords: ["海报", "样张"], copyrightStatus: "copyrighted" });
    expect(form).toEqual({ title: "封面", keywords: "海报; 样张", copyrightStatus: "copyrighted" });
    const patch = formToFileInfoPatch(form);
    expect(patch).toEqual({
      ok: true,
      value: { title: "封面", keywords: ["海报", "样张"], copyrightStatus: "copyrighted" }
    });
  });

  it("只提交表单里真正存在的字段，超限值在调用前就被拒绝", () => {
    expect(formToFileInfoPatch({ title: "封面" })).toEqual({ ok: true, value: { title: "封面" } });
    expect(formToFileInfoPatch({})).toEqual({ ok: true, value: {} });
    const tooLong = formToFileInfoPatch({ title: "x".repeat(FILE_INFO_LIMITS.maxFieldChars + 1) });
    expect(tooLong.ok).toBe(false);
    expect(formToFileInfoPatch({ copyrightStatus: "maybe" })).toMatchObject({ ok: false });
  });

  it("无变化判定按内核语义比较，而不是按原始字符串", () => {
    const base = fileInfoToForm({ title: "封面", keywords: ["海报", "样张"], copyrightStatus: "copyrighted" });
    // 同一份读取结果原样提交：无变化。
    expect(sameFileInfoForm(base, { ...base })).toBe(true);
    // 关键字的空白与分隔符差异落到同一个数组，仍属无变化。
    expect(sameFileInfoForm(base, { ...base, keywords: "海报;样张" })).toBe(true);
    // 文字字段的空白填充落到同一个读回值，也属无变化。
    expect(sameFileInfoForm(base, { ...base, author: "  " })).toBe(true);
    // 真正改变内容必须被识别为变化。
    expect(sameFileInfoForm(base, { ...base, title: "封面（改）" })).toBe(false);
    expect(sameFileInfoForm(base, { ...base, keywords: "海报" })).toBe(false);
    expect(sameFileInfoForm(base, { ...base, copyrightStatus: "publicDomain" })).toBe(false);
    // 非法表单不冒充「无变化」（宁可多报一次写入）。
    expect(sameFileInfoForm(base, { ...base, copyrightStatus: "maybe" })).toBe(false);
  });
});

describe("U03 恢复报告", () => {
  it("解码实际尺寸、层数、修订与内容指纹", () => {
    expect(decodeRestoreReport({
      restored: true, width: 24, height: 18, layers: 3, revision: 7, documentContentHash: "abc"
    })).toEqual({
      ok: true,
      value: { restored: true, width: 24, height: 18, layers: 3, revision: 7, documentContentHash: "abc" }
    });
  });

  it("缺尺寸/层数/修订时拒绝，restored 只在严格为 true 时为真", () => {
    expect(decodeRestoreReport({ width: 24, height: 18, layers: 3 })).toMatchObject({ ok: false });
    expect(decodeRestoreReport({ width: 24, height: 18, layers: 3, revision: 1, restored: "yes" }))
      .toMatchObject({ ok: true, value: { restored: false } });
    expect(decodeRestoreReport("ok")).toMatchObject({ ok: false });
  });
});
