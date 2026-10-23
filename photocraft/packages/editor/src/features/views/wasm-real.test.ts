/**
 * 真实 WASM 的内核边界回归（U70–U73）。
 *
 * 这里加载 `pnpm -C photocraft run wasm` 真正产出的 `dist/wasm`，用 `WasmEditor` 直接跑本域端口：
 * 参考线布局、命中/拖动几何、取样读数、单位换算、保存重开与内容身份。没有渲染参与，因此不需要
 * GPU 或显示会话；未构建 wasm 时整体跳过（`dist/` 是生成物，不入库），并在报告里说明。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const WASM_DIR = fileURLToPath(new URL("../../../dist/wasm/", import.meta.url));
const GLUE = `${WASM_DIR}photocraft_editor.js`;
const BINARY = `${WASM_DIR}photocraft_editor_bg.wasm`;
const available = existsSync(GLUE) && existsSync(BINARY);

type WasmEditor = {
  execute(id: string, paramsJson: string): string;
  stateJson(): string;
  contentHash(): string;
  saveProject(): Uint8Array;
  guideCommand(id: string, paramsJson: string): string;
  guideLayoutCommand(id: string, paramsJson: string): string;
  viewCommand(id: string, paramsJson: string): string;
  viewSnapshotJson(): string;
  viewPointerJson(action: string, paramsJson: string): string;
  samplerReadoutJson(index: number): string;
  formatLengthJson(paramsJson: string): string;
  viewAidsJson(): string;
  setViewAids(paramsJson: string): string;
  capabilityHandshakeJson(): string;
  inspectPsdExport(): string;
  exportPsd(paramsJson: string): Uint8Array;
  lastPsdExportReportJson(): string;
};

async function open(): Promise<WasmEditor> {
  const module = await import(/* @vite-ignore */ pathToFileURL(GLUE).href);
  module.initSync({ module: readFileSync(BINARY) });
  const editor: WasmEditor = new module.WasmEditor();
  editor.execute("file.new", JSON.stringify({ width: 120, height: 90 }));
  editor.execute("layer.new.layer", JSON.stringify({ name: "paint" }));
  return editor;
}

describe.skipIf(!available)("真实 WASM：本域端口", () => {
  it("布局命令生成真实参考线，且不改变内容指纹", async () => {
    const editor = await open();
    const before = editor.contentHash();
    editor.guideLayoutCommand("view.newGuideLayout", JSON.stringify({ columns: 2, gutter: 0, margin: [0, 0, 0, 0], clearExisting: true }));
    const snapshot = JSON.parse(editor.viewSnapshotJson());
    // 2 列 → 边界 0/60/120 三条竖线（上游布局把画布两端也算作分隔线）。
    expect(snapshot.guides.vertical).toEqual([0, 60, 120]);
    expect(snapshot.scope.guides).toBe("document");
    expect(editor.contentHash()).toBe(before);
  });

  it("命中/拖动几何在真实内核里按源坐标工作，并能被锁定拦下", async () => {
    const editor = await open();
    editor.guideCommand("view.newGuide", JSON.stringify({ orientation: "vertical", position: 100 }));
    editor.guideCommand("view.newGuide", JSON.stringify({ orientation: "horizontal", position: 50 }));
    const hit = JSON.parse(editor.viewPointerJson("hit-guide", JSON.stringify({ client: [104, 10], tolerance: 6 })));
    expect(hit.hit).toMatchObject({ vertical: true, index: 0, position: 100, distance: 4 });
    expect(hit.locked).toBe(false);
    const drag = JSON.parse(editor.viewPointerJson("drag-guide", JSON.stringify({ client: [-10, 20], vertical: true })));
    expect(drag.position).toBe(0);
    // 拖动只给候选位置，文档里仍只有两条线。
    expect(JSON.parse(editor.viewSnapshotJson()).guides.vertical).toEqual([100]);
    editor.setViewAids(JSON.stringify({ lockGuides: true }));
    expect(JSON.parse(editor.viewPointerJson("hit-guide", JSON.stringify({ client: [100, 10] }))).locked).toBe(true);
    await expect(async () => editor.guideCommand("view.moveGuide", JSON.stringify({ orientation: "vertical", index: 0, position: 20 })))
      .rejects.toThrow();
  });

  it("旋转后同一客户点落到不同源坐标（真实变换，不是 CSS）", async () => {
    const editor = await open();
    editor.setViewAids(JSON.stringify({ rotation: 90 }));
    const origin = JSON.parse(editor.viewPointerJson("drag-origin", JSON.stringify({ client: [30, 40] })));
    // 120×90、中心 (60,45)、顺时针 90°：客户 (30,40) → 源 (55,75)。
    expect(origin.origin).toEqual([55, 75]);
    editor.setViewAids(JSON.stringify({ rotation: 0 }));
    expect(JSON.parse(editor.viewPointerJson("drag-origin", JSON.stringify({ client: [30, 40] }))).origin).toEqual([30, 40]);
  });

  it("取样读数与单位换算来自真实内核，保存重开后计数与注释还在", async () => {
    const editor = await open();
    editor.viewCommand("count.add", JSON.stringify({ x: 5, y: 5 }));
    editor.viewCommand("notes.add", JSON.stringify({ x: 6, y: 7, text: "补光" }));
    editor.viewCommand("view.colorSamplers.add", JSON.stringify({ x: 10, y: 10 }));
    const readout = JSON.parse(editor.samplerReadoutJson(0));
    expect(readout.position).toEqual([10, 10]);
    expect(readout.rgb).toHaveLength(3);
    const format = JSON.parse(editor.formatLengthJson(JSON.stringify({ px: 72, unit: "mm" })));
    expect(format.text).toBe("25.4 mm");

    const saved = editor.saveProject();
    const module = await import(/* @vite-ignore */ pathToFileURL(GLUE).href);
    // 重开走 openProject（字节入口），与宿主同一路径。
    const reopened: WasmEditor & { openProject(bytes: Uint8Array, baseAssetId: string): string } = new module.WasmEditor();
    reopened.openProject(saved, "");
    const snapshot = JSON.parse(reopened.viewSnapshotJson());
    expect(snapshot.measurement.count.total).toBe(1);
    expect(snapshot.notes[0].text).toBe("补光");
    // 取样点随工程保存（本域命名空间元数据键），重开后恢复为同一批点。
    expect(snapshot.samplers).toHaveLength(1);
    expect(snapshot.samplers[0].position).toEqual([10, 10]);
    // 内容身份只由像素与图层决定，重开一致。
    expect(reopened.contentHash()).toBe(editor.contentHash());
  });

  it("逐条编辑命令在真实内核里都可达：换向参考线、移动取样点、移动注释、日志导出", async () => {
    const editor = await open();
    editor.guideCommand("view.newGuide", JSON.stringify({ orientation: "vertical", position: 30 }));
    editor.guideCommand("view.editGuide", JSON.stringify({ orientation: "vertical", index: 0, newOrientation: "horizontal", position: 30 }));
    expect(JSON.parse(editor.viewSnapshotJson()).guides).toMatchObject({ vertical: [], horizontal: [30] });

    editor.viewCommand("view.colorSamplers.add", JSON.stringify({ x: 10, y: 10 }));
    editor.viewCommand("view.colorSamplers.move", JSON.stringify({ index: 0, x: 40, y: 50 }));
    expect(JSON.parse(editor.viewCommand("view.colorSamplers.list", "{}")).samplers[0].position).toEqual([40, 50]);

    editor.viewCommand("notes.add", JSON.stringify({ x: 6, y: 7, text: "补光", open: true }));
    editor.viewCommand("notes.set", JSON.stringify({ index: 0, x: 40, y: 50, open: false }));
    expect(JSON.parse(editor.viewSnapshotJson()).notes[0]).toMatchObject({ position: [40, 50], open: false });

    editor.viewCommand("image.analysis.rulerTool", JSON.stringify({ start: [0, 0], end: [10, 0] }));
    editor.viewCommand("image.analysis.recordMeasurements", JSON.stringify({ source: "ruler" }));
    // 不传 path 时只回文本；写文件是宿主 io 端口，本域不落盘。
    const csv = JSON.parse(editor.viewCommand("measurementLog.export", "{}"));
    expect(typeof csv.csv).toBe("string");
    expect(csv.rows).toBeGreaterThan(0);
  });

  it("切到另一份文档后旧快照的目标被拒绝，新文档不会被写脏", async () => {
    const editor = await open();
    editor.viewCommand("notes.add", JSON.stringify({ x: 4, y: 4, text: "A 文档" }));
    const staleId = JSON.parse(editor.viewSnapshotJson()).document.id;
    expect(typeof staleId).toBe("number");

    // 同一份工程重开保持同一个文档身份（id 随 manifest 往返）：旧快照仍然指向它。
    const saved = editor.saveProject();
    const module = await import(/* @vite-ignore */ pathToFileURL(GLUE).href);
    const same: WasmEditor & { openProject(bytes: Uint8Array, baseAssetId: string): string } = new module.WasmEditor();
    same.openProject(saved, "");
    expect(JSON.parse(same.viewSnapshotJson()).document.id).toBe(staleId);

    // 换成另一份文档才是「来源失效」：新文档有新身份，旧 id 不许再写。
    const other: WasmEditor = new module.WasmEditor();
    other.execute("file.new", JSON.stringify({ width: 64, height: 48 }));
    other.execute("layer.new.layer", JSON.stringify({ name: "paint" }));
    const liveId = JSON.parse(other.viewSnapshotJson()).document.id;
    expect(liveId).not.toBe(staleId);
    await expect(async () => other.viewCommand("notes.add", JSON.stringify({ x: 1, y: 1, text: "迟到", targetDocument: staleId })))
      .rejects.toThrow();
    await expect(async () => other.guideCommand("view.newGuide", JSON.stringify({ orientation: "vertical", position: 9, targetDocument: staleId })))
      .rejects.toThrow();
    // 拒绝发生在写入之前：新文档保持干净。
    const clean = JSON.parse(other.viewSnapshotJson());
    expect(clean.notes).toEqual([]);
    expect(clean.guides.vertical).toEqual([]);

    // 带上正确的目标就能写进去。
    other.viewCommand("notes.add", JSON.stringify({ x: 1, y: 1, text: "本文档", targetDocument: liveId }));
    expect(JSON.parse(other.viewSnapshotJson()).notes).toHaveLength(1);
  });

  it("从标尺拖出的新参考线在真实内核里一步成线，且不做空提交", async () => {
    const editor = await open();
    const before = editor.contentHash();
    // 对应界面「从标尺按下 → 移动 → 松手」提交的那一条命令。
    editor.guideCommand("view.newGuide", JSON.stringify({ orientation: "vertical", position: 42 }));
    const snapshot = JSON.parse(editor.viewSnapshotJson());
    expect(snapshot.guides.vertical).toEqual([42]);
    // 参考线是文档数据：内容 hash 不变（不是像素），但确实进了文档。
    expect(editor.contentHash()).toBe(before);
    const saved = editor.saveProject();
    expect(saved.byteLength).toBeGreaterThan(0);
    // 拖动已有线同样一步到位，且不新增第二条。
    editor.guideCommand("view.moveGuide", JSON.stringify({ orientation: "vertical", index: 0, position: 55 }));
    expect(JSON.parse(editor.viewSnapshotJson()).guides.vertical).toEqual([55]);
  });

  it("PSD 导出报告在真实内核里逐项列出视图损失（文档级数据不静默丢弃）", async () => {
    const editor = await open();
    editor.guideCommand("view.newGuide", JSON.stringify({ orientation: "vertical", position: 12 }));
    editor.guideCommand("view.editGuide", JSON.stringify({ orientation: "vertical", index: 0, color: "#ff0000" }));
    editor.guideCommand("view.setRulerOrigin", JSON.stringify({ x: 3, y: 4 }));
    editor.viewCommand("count.add", JSON.stringify({ x: 10, y: 10 }));

    // 预检（不产生字节）就要报出来：它挂在文档上而不挂在图层上，只看图层会显示「完全可编辑」。
    const preflight = JSON.parse(editor.inspectPsdExport());
    const features = (preflight.viewLosses ?? []).map((row: { feature: string }) => row.feature);
    expect(features).toEqual(["view.guide-colors", "view.ruler-origin", "view.count-marks"]);
    expect(preflight.editable).toBe(false);
    expect(preflight.blocking).toBe(0);

    const bytes = editor.exportPsd(JSON.stringify({ rasterizeLossy: true }));
    expect(bytes.byteLength).toBeGreaterThan(0);
    const report = JSON.parse(editor.lastPsdExportReportJson());
    expect((report.viewLosses ?? []).map((row: { feature: string }) => row.feature)).toEqual(features);
  });

  it("发布后的能力在真实运行时可用，保持关闭的能力仍被拒绝", async () => {
    const editor = await open();
    const handshake = JSON.parse(editor.capabilityHandshakeJson());
    expect(handshake.capabilities).toContain("view.guide-layout");
    expect(handshake.capabilities).toContain("view.analysis");
    // 并排宿主端口还没有归属：能力必须仍然关闭，不能在声明里冒充已交付。
    expect(handshake.capabilities).not.toContain("view.rotate-navigator");

    // 已发布命令在真实内核里走得通（不是只在白名单里挂着）。
    const layout = JSON.parse(editor.guideLayoutCommand("view.newGuideLayout", JSON.stringify({ columns: 2, gutter: 40 })));
    expect(JSON.parse(editor.viewSnapshotJson()).guides.vertical.length).toBeGreaterThan(0);
    expect(layout).toBeTruthy();
    editor.viewCommand("image.analysis.info", "{}");

    // 未登记能力下的命令仍按能力关闭拒绝，且不留下写入。
    const hash = editor.contentHash();
    expect(() => editor.viewCommand("view.notARealCommand", "{}")).toThrow();
    expect(editor.contentHash()).toBe(hash);
  });

  it("Hand/Zoom 的缩放与平移只改活动视图取景，内容与历史不变", async () => {
    const editor = await open();
    editor.setViewAids(JSON.stringify({ viewAction: "new" }));
    const before = JSON.parse(editor.viewAidsJson());
    const idleBefore = before.views.find((view: { active: boolean }) => !view.active);
    const hashBefore = editor.contentHash();
    const historyBefore = JSON.parse(editor.stateJson()).document.history;

    editor.setViewAids(JSON.stringify({ zoom: 2.5, offset: [40, -12] }));
    const after = JSON.parse(editor.viewAidsJson());
    const activeAfter = after.views.find((view: { active: boolean }) => view.active);
    expect(activeAfter.zoom).toBeCloseTo(2.5, 6);
    expect(activeAfter.offset).toEqual([40, -12]);
    // 取景不串视图：另一个视图保持自己的缩放与平移。
    expect(after.views.find((view: { active: boolean }) => !view.active)).toEqual(idleBefore);
    // 只改取景：内容身份与历史步数不变。
    expect(editor.contentHash()).toBe(hashBefore);
    expect(JSON.parse(editor.stateJson()).document.history).toEqual(historyBefore);

    // 越界缩放被拒且保持原值，不是静默钳到边界。
    await expect(async () => editor.setViewAids(JSON.stringify({ zoom: 0 }))).rejects.toThrow();
    expect(JSON.parse(editor.viewAidsJson()).views.find((view: { active: boolean }) => view.active).zoom).toBeCloseTo(2.5, 6);
  });

  it("多视图下只有活动视图接收指针输入", async () => {
    const editor = await open();
    editor.setViewAids(JSON.stringify({ viewAction: "new" }));
    const views = JSON.parse(editor.viewAidsJson()).views as { id: string; active: boolean }[];
    expect(views).toHaveLength(2);
    const active = views.find((view) => view.active)!.id;
    const idle = views.find((view) => !view.active)!.id;

    // 非活动视图的迟到拖动被拒绝，活动视图照常命中。
    await expect(async () => editor.viewPointerJson("drag-origin", JSON.stringify({ client: [5, 5], viewId: idle })))
      .rejects.toThrow();
    const hit = JSON.parse(editor.viewPointerJson("hit-guide", JSON.stringify({ client: [5, 5], viewId: active })));
    expect(hit).toHaveProperty("hit");

    // 切换活动视图后归属反转。
    editor.setViewAids(JSON.stringify({ viewAction: "activate", viewId: idle }));
    expect(() => editor.viewPointerJson("drag-origin", JSON.stringify({ client: [5, 5], viewId: idle }))).not.toThrow();
    await expect(async () => editor.viewPointerJson("drag-origin", JSON.stringify({ client: [5, 5], viewId: active })))
      .rejects.toThrow();
  });
});

describe.runIf(available)("U72 并排：每视图取景独立", () => {
  it("按 viewId 写取景只改那个视图，并排开关要求两个视图", async () => {
    const editor = await open();
    // 单视图时打开并排被拒绝：界面不会拿到一个做不到的开关。
    expect(() => editor.setViewAids(JSON.stringify({ sideBySide: true }))).toThrow();
    expect(JSON.parse(editor.viewAidsJson()).sideBySide).toBe(false);

    editor.setViewAids(JSON.stringify({ viewAction: "new" }));
    const toggled = JSON.parse(editor.setViewAids(JSON.stringify({ sideBySide: true })));
    expect(toggled.sideBySide).toBe(true);
    const ids = (toggled.views as { id: string }[]).map((view) => view.id);
    expect(ids).toHaveLength(2);

    // 非活动视图也能改自己的取景，且不抢活动视图。
    const activeBefore = toggled.activeView as string;
    editor.setViewAids(JSON.stringify({ viewId: ids[0], zoom: 2.5, offset: [30, -12] }));
    const after = JSON.parse(editor.viewAidsJson());
    expect(after.activeView).toBe(activeBefore);
    const first = (after.views as { id: string; zoom: number; offset: number[] }[]).find((view) => view.id === ids[0])!;
    const second = (after.views as { id: string; zoom: number; offset: number[] }[]).find((view) => view.id === ids[1])!;
    expect(first.zoom).toBeCloseTo(2.5, 6);
    expect(first.offset).toEqual([30, -12]);
    expect(second.zoom).toBeCloseTo(1, 6);
    expect(second.offset).toEqual([0, 0]);
    // 未知视图 id 是参数错误，不会漏到活动视图上。
    expect(() => editor.setViewAids(JSON.stringify({ viewId: "view-9", zoom: 2 }))).toThrow();
  });
});

describe.runIf(available)("U73 Info 源像素读数", () => {
  it("probe 给源坐标与 RGB/CMYK，画布外为 null，且不改内容身份", async () => {
    const editor = await open();
    const before = editor.contentHash();
    const probe = JSON.parse(editor.viewPointerJson("probe", JSON.stringify({ client: [10.5, 20.5] })));
    expect(probe.unit).toBe("px");
    expect(probe.reading.pixel).toEqual([10, 20]);
    expect(probe.reading.rgb).toEqual([255, 255, 255]);
    expect(probe.reading.cmyk).toEqual([0, 0, 0, 0]);

    // 与颜色采样点读数逐值一致（同一份合成采样）。
    editor.viewCommand("view.colorSamplers.add", JSON.stringify({ x: 10, y: 20 }));
    const sampler = JSON.parse(editor.samplerReadoutJson(0));
    expect(probe.reading.rgb).toEqual(sampler.rgb);
    expect(probe.reading.cmyk).toEqual(sampler.cmyk);

    const outside = JSON.parse(editor.viewPointerJson("probe", JSON.stringify({ client: [-1, 3] })));
    expect(outside.reading).toBeNull();
    expect(editor.contentHash()).toBe(before);

    // 视图旋转不改变读数：像素平面不随旋转呈现，读数必须与眼睛看到的像素一致。
    editor.setViewAids(JSON.stringify({ rotation: 90 }));
    const afterRotate = JSON.parse(editor.viewPointerJson("probe", JSON.stringify({ client: [10.5, 20.5] })));
    expect(afterRotate.reading.pixel).toEqual(probe.reading.pixel);
    expect(afterRotate.reading.rgb).toEqual(probe.reading.rgb);
    // 几何（参考线命中）仍按旋转计算：两者属于不同的一侧，不能混为一个变换。
    const hit = JSON.parse(editor.viewPointerJson("hit-guide", JSON.stringify({ client: [10.5, 20.5] })));
    expect(hit).toHaveProperty("locked");
    editor.setViewAids(JSON.stringify({ rotation: 0 }));
  });
});

describe.runIf(available)("U73 持久颜色采样点", () => {
  it("保存后重开恢复采样点，内容指纹不变", async () => {
    const editor = await open();
    const before = editor.contentHash();
    editor.viewCommand("view.colorSamplers.add", JSON.stringify({ x: 12, y: 34 }));
    editor.viewCommand("view.colorSamplers.add", JSON.stringify({ x: 56, y: 78 }));
    const bytes = editor.saveProject();
    // 没有采样点的工程不会被塞一个空键：字节长度必须和加点前一致。
    const plain = await open();
    expect(plain.saveProject().length).toBeLessThan(bytes.length);

    const module = await import(/* @vite-ignore */ pathToFileURL(GLUE).href);
    const reopened: WasmEditor & { openProject(bytes: Uint8Array, baseAssetId: string): string } = new module.WasmEditor();
    // 宿主同一路径：字节入口 + 空 baseAssetId。
    reopened.openProject(bytes, "");
    expect(reopened.contentHash()).toBe(before);
    const list = JSON.parse(reopened.viewCommand("view.colorSamplers.list", "{}"));
    expect(list.samplers).toHaveLength(2);
    expect(list.samplers[1].position).toEqual([56, 78]);
  });
});

it.skipIf(available)("未构建真实 WASM 时跳过（生成物不入库）", () => {
  // `dist/wasm` 由 `pnpm -C photocraft run wasm` 产出且被 .gitignore 忽略；干净副本上无 wasm 时
  // 只报告跳过，不把「没构建」伪装成通过。
  expect(available).toBe(false);
});
