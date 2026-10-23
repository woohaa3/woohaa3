#!/usr/bin/env node
/**
 * 通道域真实 WASM 主线冒烟（change: 2026-10-22-add-photocraft-channel-workflows，U25/U26）。
 *
 * 与 `scripts/check-feature-boundaries.mjs` 一样直接加载**真实**产物，不经 React；
 * 目的是让「创建 Alpha → 单通道落笔 → 载入选区 → 两源计算 → 工程重开 → 拆分/合并」
 * 这条主线有一条可重复执行的证据，而不是只核对命令字符串。
 *
 *   pnpm run wasm                       # 先产出 packages/editor/dist/wasm
 *   node tests/features/channels/wasm-smoke.mjs [--wasm-dir <dir>]
 *
 * 该脚本只在本机/CI 具备 wasm 产物时运行；缺少产物时以明确原因失败，不静默跳过。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const argIndex = process.argv.indexOf("--wasm-dir");
const wasmDir = resolve(root, argIndex >= 0 && process.argv[argIndex + 1] ? process.argv[argIndex + 1] : "packages/editor/dist/wasm");
const glue = join(wasmDir, "photocraft_editor.js");
const binary = join(wasmDir, "photocraft_editor_bg.wasm");
if (!existsSync(glue) || !existsSync(binary)) {
  console.error(`缺少 WASM 产物：${wasmDir}\n先运行 \`pnpm run wasm\`（或 \`pnpm run wasm:debug\`）。`);
  process.exit(2);
}

const { readFileSync } = await import("node:fs");
const init = (await import(pathToFileURL(glue).href)).default;
await init({ module_or_path: readFileSync(binary) });
const { WasmEditor } = await import(pathToFileURL(glue).href);

const results = [];
const check = (label, pass, detail = "") => results.push({ label, pass: Boolean(pass), detail });
const attempt = (run) => {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};
const must = (label, run) => {
  const result = attempt(run);
  if (!result.ok) {
    console.error(`FAIL ${label} :: ${result.error}`);
    process.exit(1);
  }
  return result.value;
};
const json = (label, run) => JSON.parse(must(label, run));

// ---------------------------------------------------------------- 文档准备

const editor = new WasmEditor();
must("file.new", () => editor.execute("file.new", JSON.stringify({ width: 32, height: 24 })));
must("layer.new.layer", () => editor.execute("layer.new.layer", JSON.stringify({})));
must("paint.stroke", () => editor.execute("paint.stroke", JSON.stringify({
  points: [[4, 4], [20, 16]], size: 4, hardness: 1, opacity: 1, flow: 1, color: "#3366cc", target: "pixels"
})));
must("select.rect", () => editor.execute("select.rect", JSON.stringify({ x: 4, y: 4, width: 12, height: 8 })));

// ---------------------------------------------------------------- U25 面板与通道操作

const created = json("channel.new", () => editor.channelCommand("channel.new", JSON.stringify({
  fill: "selection", name: "Alpha 主线", indicates: "selected", opacity: 30
})));
let snapshot = json("channelSnapshotJson", () => editor.channelSnapshotJson());
check("Alpha 通道由选区创建", created.channel === 0 && snapshot.alpha.length === 1, JSON.stringify(snapshot.alpha[0]));
check("创建后编辑目标指向该通道", snapshot.target.kind === "alpha" && snapshot.target.index === 0, JSON.stringify(snapshot.target));
check("「表示」按上游序列化为 selectedAreas", snapshot.alpha[0].indicates === "selectedAreas", snapshot.alpha[0].indicates);

must("channel.target", () => editor.channelCommand("channel.target", JSON.stringify({ channel: 0 })));
must("通道落笔", () => editor.execute("paint.stroke", JSON.stringify({
  points: [[6, 6], [10, 10]], size: 3, hardness: 1, opacity: 1, flow: 1, color: "#ffffff", target: { channel: 0 }
})));
const thumbnail = attempt(() => editor.channelThumbnail(JSON.stringify({ alpha: 0 }), 16));
check("通道缩略图按单边上限缩放", thumbnail.ok && thumbnail.value.width === 16 && thumbnail.value.height === 12,
  thumbnail.ok ? `${thumbnail.value.width}x${thumbnail.value.height}` : thumbnail.error);
thumbnail.value?.free?.();
const view = attempt(() => editor.channelViewPreview(24));
check("通道视图跟随目标（不改进编辑目标）", view.ok && view.value.width === 24,
  view.ok ? `${view.value.width}x${view.value.height}` : view.error);
view.value?.free?.();

// 主画布单通道视图：面板显示单通道时画布取的是灰度视图，而不是合成结果。
const channelViewGray = (() => {
  const preview = editor.channelViewPreview(48);
  let colored = 0;
  for (let i = 0; i < preview.pixels.length; i += 4) {
    if (preview.pixels[i] !== preview.pixels[i + 1] || preview.pixels[i] !== preview.pixels[i + 2]) colored++;
  }
  const size = `${preview.width}x${preview.height}`;
  preview.free?.();
  return { colored, size };
})();
check("单通道视图是灰度（主画布不再显示合成色）", channelViewGray.colored === 0, JSON.stringify(channelViewGray));

// 笔迹路由：面板把 `channel:i` 注入 target 后，像素只落在该 Alpha 通道，图层不被改写。
const layerBefore = must("activeLayer", () => JSON.parse(editor.stateJson()).document.activeLayer);
const paintAlpha = attempt(() => editor.execute("paint.stroke", JSON.stringify({
  points: [[3, 12], [8, 12]], size: 3, hardness: 1, opacity: 1, flow: 1, color: "#ffffff",
  spacing: 0.25, smoothing: 0.2, mode: "normal", erase: false, zoom: 1, target: { channel: 0 }
})));
check("按通道目标落笔成功", paintAlpha.ok, paintAlpha.ok ? "" : paintAlpha.error);
const litCount = (preview) => {
  let lit = 0;
  for (let i = 0; i < preview.pixels.length; i += 4) if (preview.pixels[i] > 128) lit++;
  return lit;
};
const alphaLit = attempt(() => editor.channelThumbnail(JSON.stringify({ alpha: 0 }), 64));
check("通道目标落笔写进该通道", alphaLit.ok && litCount(alphaLit.value) > 0, alphaLit.ok ? `lit=${litCount(alphaLit.value)}` : alphaLit.error);
alphaLit.value?.free?.();
// RGB 单分量：目标为 Green 时普通 pixels 落笔只改该分量（内核对 target:"pixels" 的限制）。
// 用干净文档，避免前面步骤留在其它分量上的像素让断言变成假阳性。
const colorProbe = new WasmEditor();
must("color file.new", () => colorProbe.execute("file.new", JSON.stringify({ width: 16, height: 16 })));
must("color layer.new.layer", () => colorProbe.execute("layer.new.layer", JSON.stringify({})));
const colorLit = (k) => {
  const preview = colorProbe.channelThumbnail(JSON.stringify({ color: k }), 64);
  let lit = 0;
  for (let i = 0; i < preview.pixels.length; i += 4) if (preview.pixels[i] > 128) lit++;
  preview.free?.();
  return lit;
};
check("分量初始为空", colorLit(0) === 0 && colorLit(1) === 0 && colorLit(2) === 0);
must("channel.target green", () => colorProbe.channelCommand("channel.target", JSON.stringify({ channel: { color: 1 } })));
must("分量落笔", () => colorProbe.execute("paint.stroke", JSON.stringify({
  points: [[3, 3], [9, 9]], size: 3, hardness: 1, opacity: 1, flow: 1, color: "#ffffff", target: "pixels"
})));
const green = colorLit(1), red = colorLit(0), blue = colorLit(2);
check("单分量落笔只改该分量", green > 0 && red === 0 && blue === 0, `green=${green} red=${red} blue=${blue}`);
colorProbe.free();
// 图层缩略图必须带单边上限：省略会被钳成 1×1，那样的「0 个亮点」不能证明图层没被写。
const layerLit = attempt(() => editor.layerThumbnail(layerBefore, false, 64));
check("通道目标落笔不改图层像素",
  layerLit.ok && layerLit.value.width > 1 && litCount(layerLit.value) === 0,
  layerLit.ok ? `${layerLit.value.width}x${layerLit.value.height} lit=${litCount(layerLit.value)}` : layerLit.error);
layerLit.value?.free?.();

must("select.loadSelection", () => editor.execute("select.loadSelection", JSON.stringify({ channel: { alpha: 0 } })));
const loaded = json("stateJson", () => editor.stateJson());
check("通道可载入为选区", loaded.document.hasSelection === true, JSON.stringify(loaded.document.selectionFrame));

const spot = json("channel.newSpot", () => editor.channelCommand("channel.newSpot", JSON.stringify({
  name: "专色绿", color: "#00ff00", solidity: 60, fromSelection: false
})));
check("专色通道创建", spot.channel === 1);
snapshot = json("channelSnapshotJson#2", () => editor.channelSnapshotJson());
check("专色保留屏幕替代色与密度",
  snapshot.alpha[1].kind === "spot" && Math.abs(snapshot.alpha[1].spot.solidity - 0.6) < 1e-6,
  JSON.stringify(snapshot.alpha[1]));

must("channel.options", () => editor.channelCommand("channel.options", JSON.stringify({ channel: 1, color: "#0000ff", solidity: 25 })));
must("channel.rename", () => editor.channelCommand("channel.rename", JSON.stringify({ channel: 1, name: "专色蓝" })));
must("channel.move", () => editor.channelCommand("channel.move", JSON.stringify({ channel: 1, to: 0 })));
snapshot = json("channelSnapshotJson#3", () => editor.channelSnapshotJson());
check("排序改变通道顺序", snapshot.alpha.map((row) => row.name).join(",") === "专色蓝,Alpha 主线", snapshot.alpha.map((row) => row.name).join(","));
must("channel.duplicate", () => editor.channelCommand("channel.duplicate", JSON.stringify({ channel: 1, name: "副本", invert: true })));

const hashBeforeVisibility = must("contentHash", () => editor.contentHash());
const visibleBefore = json("channelSnapshotJson#4", () => editor.channelSnapshotJson()).alpha[0].visible;
must("channel.setVisible", () => editor.channelCommand("channel.setVisible", JSON.stringify({ channel: 0, visible: false })));
const visibleAfter = json("channelSnapshotJson#5", () => editor.channelSnapshotJson()).alpha[0].visible;
check("显隐是查看态：不改内容指纹", visibleBefore === true && visibleAfter === false
  && must("contentHash#2", () => editor.contentHash()) === hashBeforeVisibility, `${visibleBefore} → ${visibleAfter}`);
must("channel.setVisible#2", () => editor.channelCommand("channel.setVisible", JSON.stringify({ channel: 0, visible: true })));

// ---------------------------------------------------------------- U26 应用图像 / 计算 / 亮度选区

const illegal = attempt(() => editor.channelCommand("image.applyImage", JSON.stringify({ blending: "dissolve" })));
check("非法混合模式在任何写入前被拒绝", !illegal.ok && illegal.error.includes("dissolve"), illegal.error);

// 受控 fixture：选区造一个已知大小的 Alpha 源，写进另一个 Alpha 目标。
// 断言预览的候选像素与**确认后**目标的真实缩略图逐字节一致（预览不是另算一套）。
const fixture = new WasmEditor();
must("fixture file.new", () => fixture.execute("file.new", JSON.stringify({ width: 24, height: 16 })));
must("fixture layer", () => fixture.execute("layer.new.layer", JSON.stringify({ name: "L" })));
must("fixture select.rect", () => fixture.execute("select.rect", JSON.stringify({ x: 3, y: 3, width: 10, height: 8, mode: "replace" })));
must("fixture source", () => fixture.channelCommand("channel.new", JSON.stringify({ name: "源", fill: "selection", indicates: "selected" })));
must("fixture target", () => fixture.channelCommand("channel.new", JSON.stringify({ name: "目标" })));
const litPixels = (pixels) => {
  let lit = 0;
  for (let index = 0; index < pixels.length; index += 4) if (pixels[index] > 128) lit += 1;
  return lit;
};
const sourceThumb = must("fixture source thumb", () => fixture.channelThumbnail(JSON.stringify({ alpha: 0 }), 24));
const fixtureParams = JSON.stringify({ source: { channel: { alpha: 0 } }, target: { channel: 1 }, blending: "normal", opacity: 100 });
const fixturePreview = fixture.channelCalcPreview("image.applyImage", fixtureParams, 24);
const previewPixels = Array.from(fixturePreview.pixels);
fixturePreview.free?.();
must("fixture commit", () => fixture.channelCommand("image.applyImage", fixtureParams));
const fixtureThumb = must("fixture target thumb", () => fixture.channelThumbnail(JSON.stringify({ alpha: 1 }), 24));
const committedPixels = Array.from(fixtureThumb.pixels);
const sourcePixels = Array.from(sourceThumb.pixels);
let fixtureDiff = 0;
for (let index = 0; index < previewPixels.length; index += 1) if (previewPixels[index] !== committedPixels[index]) fixtureDiff += 1;
const fixtureLit = litPixels(previewPixels);
check("受控 fixture：预览候选与确认结果逐字节一致",
  previewPixels.length === committedPixels.length && fixtureDiff === 0
  && fixtureLit === litPixels(sourcePixels) && fixtureLit > 0,
  `预览 lit=${fixtureLit} 源 lit=${litPixels(sourcePixels)} 差异字节=${fixtureDiff}`);
sourceThumb.free?.();
fixtureThumb.free?.();
fixture.free();

const stateBeforePreview = must("stateJson#2", () => editor.stateJson());
const hashBeforePreview = must("contentHash#3", () => editor.contentHash());
const historyBeforePreview = JSON.parse(stateBeforePreview).document.history.length;
const applyParams = JSON.stringify({
  source: { channel: { color: 0 } }, target: { channel: 1 }, blending: "normal", opacity: 80
});
const preview = attempt(() => editor.channelCalcPreview("image.applyImage", applyParams, 24));
const summary = json("channelCalcPreviewJson", () => editor.channelCalcPreviewJson("image.applyImage", applyParams, 24));
check("预览返回有界像素", preview.ok && preview.value.width > 0,
  preview.ok ? `${preview.value.width}x${preview.value.height}` : preview.error);
preview.value?.free?.();
check("预览不改正式状态/指纹/历史",
  must("stateJson#3", () => editor.stateJson()) === stateBeforePreview
  && must("contentHash#4", () => editor.contentHash()) === hashBeforePreview
  && JSON.parse(must("stateJson#4", () => editor.stateJson())).document.history.length === historyBeforePreview,
  JSON.stringify({ revisionChanged: summary.revisionChanged }));

must("image.applyImage", () => editor.channelCommand("image.applyImage", applyParams));
const applied = json("stateJson#5", () => editor.stateJson());
check("确认只产生一步历史", applied.document.history.length === historyBeforePreview + 1,
  `${historyBeforePreview} → ${applied.document.history.length}`);

// 「只改目标」：应用图像写到 Alpha 时，图层像素、选区与其他通道都不动。
const targeted = new WasmEditor();
must("targeted file.new", () => targeted.execute("file.new", JSON.stringify({ width: 12, height: 12 })));
must("targeted layer", () => targeted.execute("layer.new.layer", JSON.stringify({ name: "L" })));
must("targeted paint", () => targeted.execute("paint.stroke", JSON.stringify({
  points: [[2, 2], [9, 9]], size: 4, hardness: 1, opacity: 1, flow: 1, color: "#3366cc", target: "pixels"
})));
must("targeted select.rect", () => targeted.execute("select.rect", JSON.stringify({ x: 1, y: 1, width: 6, height: 6, mode: "replace" })));
must("targeted source", () => targeted.channelCommand("channel.new", JSON.stringify({ name: "源", fill: "selection", indicates: "selected" })));
must("targeted target", () => targeted.channelCommand("channel.new", JSON.stringify({ name: "目标" })));
const targetStateBefore = json("targeted state before", () => targeted.stateJson()).document;
const targetLayerBefore = must("targeted layer thumb before", () => targeted.layerThumbnail(targetStateBefore.activeLayer, null, 64));
const targetLayerPixels = JSON.stringify(Array.from(targetLayerBefore.pixels));
targetLayerBefore.free?.();
const targetSourceBefore = must("targeted source before", () => targeted.channelThumbnail(JSON.stringify({ alpha: 0 }), 32));
const targetSourcePixels = JSON.stringify(Array.from(targetSourceBefore.pixels));
targetSourceBefore.free?.();
must("targeted apply", () => targeted.channelCommand("image.applyImage", JSON.stringify({
  source: { channel: { alpha: 0 } }, target: { channel: 1 }, blending: "normal", opacity: 100
})));
const targetStateAfter = json("targeted state after", () => targeted.stateJson()).document;
const targetLayerAfter = must("targeted layer thumb after", () => targeted.layerThumbnail(targetStateAfter.activeLayer, null, 64));
const targetLayerAfterPixels = JSON.stringify(Array.from(targetLayerAfter.pixels));
targetLayerAfter.free?.();
const targetSourceAfter = must("targeted source after", () => targeted.channelThumbnail(JSON.stringify({ alpha: 0 }), 32));
const targetSourceAfterPixels = JSON.stringify(Array.from(targetSourceAfter.pixels));
targetSourceAfter.free?.();
const targetWritten = must("targeted target thumb", () => targeted.channelThumbnail(JSON.stringify({ alpha: 1 }), 32));
const targetWrittenLit = litPixels(targetWritten.pixels);
targetWritten.free?.();
check("应用图像只改目标通道，图层像素/选区/来源通道都不动",
  targetLayerAfterPixels === targetLayerPixels
  && targetSourceAfterPixels === targetSourcePixels
  && targetWrittenLit > 0
  && JSON.stringify(targetStateAfter.selectionFrame) === JSON.stringify(targetStateBefore.selectionFrame),
  JSON.stringify({ layerSame: targetLayerAfterPixels === targetLayerPixels, sourceSame: targetSourceAfterPixels === targetSourcePixels, targetLit: targetWrittenLit }));
targeted.free();

const calculated = json("image.calculations", () => editor.channelCommand("image.calculations", JSON.stringify({
  source1: { channel: 0 }, source2: { channel: 2 }, blending: "multiply", result: "newChannel", name: "计算结果"
})));
check("两源计算新增通道", typeof calculated.channel === "number"
  && json("channelSnapshotJson#6", () => editor.channelSnapshotJson()).alpha.some((row) => row.name === "计算结果"));
const calculatedSelection = attempt(() => editor.channelCommand("image.calculations", JSON.stringify({
  source1: { channel: 0 }, source2: { channel: 2 }, blending: "screen", result: "selection"
})));
check("计算结果可输出为选区", calculatedSelection.ok, calculatedSelection.ok ? "" : calculatedSelection.error);

// 受控算术：源 1 = 左半白（选区造的已知形状），源 2 = 全黑。
// multiply(白,黑)=黑、screen(白,黑)=白，两者都必须与**确认后**新通道的真实值一致。
const arithmetic = new WasmEditor();
must("arith file.new", () => arithmetic.execute("file.new", JSON.stringify({ width: 8, height: 8 })));
must("arith layer", () => arithmetic.execute("layer.new.layer", JSON.stringify({})));
must("arith select.rect", () => arithmetic.execute("select.rect", JSON.stringify({ x: 0, y: 0, width: 4, height: 8, mode: "replace" })));
must("arith source1", () => arithmetic.channelCommand("channel.new", JSON.stringify({ name: "S1", fill: "selection", indicates: "selected" })));
must("arith source2", () => arithmetic.channelCommand("channel.new", JSON.stringify({ name: "S2" })));
const arithSource = must("arith source thumb", () => arithmetic.channelThumbnail(JSON.stringify({ alpha: 0 }), 16));
const arithSourceLit = litPixels(arithSource.pixels);
arithSource.free?.();
for (const [blending, expectedLit] of [["multiply", 0], ["screen", null]]) {
  const params = JSON.stringify({
    source1: { channel: { alpha: 0 } }, source2: { channel: { alpha: 1 } },
    blending, opacity: 100, result: "newChannel", name: `R_${blending}`
  });
  const before = arithmetic.channelCalcPreview("image.calculations", params, 24);
  const beforePixels = Array.from(before.pixels);
  before.free?.();
  must(`arith ${blending}`, () => arithmetic.channelCommand("image.calculations", params));
  const rowIndex = json(`arith snapshot ${blending}`, () => arithmetic.channelSnapshotJson())
    .alpha.findIndex((row) => row.name === `R_${blending}`);
  const committed = must(`arith thumb ${blending}`, () => arithmetic.channelThumbnail(JSON.stringify({ alpha: rowIndex }), 24));
  const committedPixels = Array.from(committed.pixels);
  committed.free?.();
  let diff = 0;
  for (let index = 0; index < beforePixels.length; index += 1) if (beforePixels[index] !== committedPixels[index]) diff += 1;
  const wanted = expectedLit === null ? arithSourceLit : expectedLit;
  check(`计算 ${blending} 的实际像素值正确且预览与确认一致`,
    rowIndex > 0 && diff === 0 && litPixels(committedPixels) === wanted && arithSourceLit > 0,
    `期望 lit=${wanted} 实际 lit=${litPixels(committedPixels)} 差异字节=${diff}`);
}
arithmetic.free();

// `result:"newDocument"` 是唯一会改变会话文档数的输出：必须新建并切到新文档，而不是改写来源。
const calc = new WasmEditor();
must("calc file.new", () => calc.execute("file.new", JSON.stringify({ width: 16, height: 16 })));
must("calc layer", () => calc.execute("layer.new.layer", JSON.stringify({})));
must("calc channel", () => calc.channelCommand("channel.new", JSON.stringify({ name: "A", fill: "white" })));
const calcDocsBefore = json("calc snapshot", () => calc.channelSnapshotJson()).documents.length;
const calcHashBefore = must("calc hash", () => calc.contentHash());
const calcNew = json("calc newDocument", () => calc.channelCommand("image.calculations", JSON.stringify({
  source1: { channel: 0 }, source2: { channel: { color: 1 } }, blending: "multiply", result: "newDocument", name: "计算文档"
})));
const calcSnapshot = json("calc snapshot#2", () => calc.channelSnapshotJson());
check("计算结果输出为新文档并切换过去",
  typeof calcNew.document === "number" && calcSnapshot.documents.length === calcDocsBefore + 1
  && calcSnapshot.documents.find((row) => row.active)?.name === "计算文档",
  JSON.stringify({ document: calcNew.document, docs: calcSnapshot.documents.map((row) => [row.index, row.name, row.active]) }));
const calcBudget = new WasmEditor();
must("budget file.new", () => calcBudget.execute("file.new", JSON.stringify({ width: 8, height: 8 })));
for (let index = 0; index < 7; index += 1) must(`budget file.new#${index}`, () => calcBudget.execute("file.new", JSON.stringify({ width: 8, height: 8 })));
const budgetFull = json("budget snapshot", () => calcBudget.channelSnapshotJson());
const overBudget = attempt(() => calcBudget.channelCommand("image.calculations", JSON.stringify({ result: "newDocument" })));
check("新文档输出超过会话上限被拒绝且不写入",
  budgetFull.documents.length === budgetFull.maxOpenDocuments
  && !overBudget.ok && overBudget.error.includes("不能超过")
  && json("budget snapshot#2", () => calcBudget.channelSnapshotJson()).documents.length === budgetFull.documents.length,
  overBudget.ok ? "未拒绝" : overBudget.error);
calcBudget.free();
calc.free();

const luminosity = new WasmEditor();
must("lum file.new", () => luminosity.execute("file.new", JSON.stringify({ width: 32, height: 32, background: "transparent" })));
must("lum paint.stroke", () => luminosity.execute("paint.stroke", JSON.stringify({
  points: [[4, 4], [10, 10]], size: 4, hardness: 1, opacity: 1, flow: 1, color: "#ffffff", target: "pixels"
})));
must("select.loadLuminosity", () => luminosity.channelCommand("select.loadLuminosity", "null"));
const luminosityState = json("lum stateJson", () => luminosity.stateJson());
const selectionThumbnail = attempt(() => luminosity.channelThumbnail(JSON.stringify("selection"), 32));
let lit = 0;
let dark = 0;
if (selectionThumbnail.ok) {
  const { pixels } = selectionThumbnail.value;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] > 200) lit += 1;
    else if (pixels[index] === 0) dark += 1;
  }
  selectionThumbnail.value.free?.();
}
check("亮度选区不是简单全选", luminosityState.document.hasSelection === true && lit > 0 && dark > 0,
  `lit=${lit} dark=${dark} frame=${JSON.stringify(luminosityState.document.selectionFrame)}`);

// ---------------------------------------------------------------- 工程重开（通道内容与元数据）

const savedNames = json("channelSnapshotJson#7", () => editor.channelSnapshotJson()).alpha.map((row) => row.name).join(",");
const bundle = must("exportBundle", () => editor.exportBundle());
const project = bundle.project;
bundle.free?.();
const reopened = new WasmEditor();
must("openProject", () => reopened.openProject(project, ""));
const reopenedSnapshot = json("reopened channelSnapshotJson", () => reopened.channelSnapshotJson());
check("重开后通道与元数据保留", reopenedSnapshot.alpha.map((row) => row.name).join(",") === savedNames,
  `${reopenedSnapshot.alpha.map((row) => row.name).join(",")}（保存前 ${savedNames}）`);
check("重开后专色密度保留",
  reopenedSnapshot.alpha.some((row) => row.kind === "spot" && Math.abs(row.spot.solidity - 0.25) < 1e-6),
  JSON.stringify(reopenedSnapshot.alpha.filter((row) => row.kind === "spot")));
check("重开后内容指纹一致",
  must("reopened contentHash", () => reopened.contentHash()) === must("saved contentHash", () => editor.contentHash()));

// ---------------------------------------------------------------- 拆分 / 合并与预算

const splitAlphaCount = json("split alpha count", () => editor.channelSnapshotJson()).alpha.length;
const split = json("channel.split", () => editor.channelCommand("channel.split", JSON.stringify({ closeOriginal: true })));
check("拆分得到同尺寸灰度文档", Array.isArray(split.documents) && split.documents.length >= 2, JSON.stringify(split.documents));
// 拆分语义：RGB 分量各一个 + 每个 Alpha/专色一个；`closeOriginal` 为真时原文档被关闭，
// 因此会话里不应再留下任何非灰度文档。
const splitSession = json("split snapshot", () => editor.channelSnapshotJson());
check("拆分关闭原文档并按分量/通道各建灰度文档",
  splitSession.documents.length === splitAlphaCount + 3
  && splitSession.documents.every((row) => row.grayscale)
  && splitSession.documents.filter((row) => row.active).length === 1,
  JSON.stringify({ expected: splitAlphaCount + 3, documents: splitSession.documents.map((row) => [row.index, row.name, row.grayscale, row.active]) }));

// 反向：不关闭原文档时原文档仍在会话里，新增的是分量拷贝。
const keepOriginal = new WasmEditor();
must("splitkeep file.new", () => keepOriginal.execute("file.new", JSON.stringify({ width: 16, height: 16 })));
must("splitkeep layer", () => keepOriginal.execute("layer.new.layer", JSON.stringify({})));
must("splitkeep split", () => keepOriginal.channelCommand("channel.split", JSON.stringify({ closeOriginal: false })));
const keepSession = json("splitkeep snapshot", () => keepOriginal.channelSnapshotJson());
check("不关闭原文档时原文档保留",
  keepSession.documents.length === 4 && keepSession.documents.some((row) => !row.grayscale),
  JSON.stringify(keepSession.documents.map((row) => [row.index, row.name, row.grayscale])));
keepOriginal.free();

// 拆分预算：一次要新增 3 个文档，超限时必须整条拒绝且不留半个结果。
const splitBudget = new WasmEditor();
must("splitbudget file.new", () => splitBudget.execute("file.new", JSON.stringify({ width: 8, height: 8 })));
for (let index = 0; index < 6; index += 1) must(`splitbudget file.new#${index}`, () => splitBudget.execute("file.new", JSON.stringify({ width: 8, height: 8 })));
const splitBudgetBefore = json("splitbudget snapshot", () => splitBudget.channelSnapshotJson()).documents.length;
const splitOverBudget = attempt(() => splitBudget.channelCommand("channel.split", JSON.stringify({ closeOriginal: true })));
check("拆分超过会话上限被拒绝且不留半个结果",
  !splitOverBudget.ok && splitOverBudget.error.includes("不能超过")
  && json("splitbudget snapshot#2", () => splitBudget.channelSnapshotJson()).documents.length === splitBudgetBefore,
  splitOverBudget.ok ? "未拒绝" : splitOverBudget.error);
splitBudget.free();
// 拆分后是灰度文档：复合行折叠成唯一的 Gray 分量，不再列出不存在的 RGB 分量。
const splitGray = json("splitgray snapshot", () => editor.channelSnapshotJson());
check("灰度文档的通道行折叠成单一 Gray 分量",
  splitGray.composite === "Gray" && splitGray.colors.length === 1
  && splitGray.colors[0].reference === "composite",
  JSON.stringify({ composite: splitGray.composite, colors: splitGray.colors }));
check("灰度文档的复合缩略图与通道视图仍可渲染", (() => {
  const thumbnail = editor.channelThumbnail(JSON.stringify("composite"), 32);
  const view = editor.channelViewPreview(32);
  const ok = thumbnail.width > 1 && view.width > 1;
  thumbnail.free?.();
  view.free?.();
  return ok;
})(), "灰度复合缩略图与视图均有界可渲染");

const merged = attempt(() => editor.channelCommand("channel.merge", JSON.stringify({ mode: "rgb", documents: split.documents.slice(0, 3) })));
check("RGB 合并成功", merged.ok, merged.ok ? "" : merged.error);
// CMYK/Lab 属于 NON_GOAL 的多色彩管理与印刷分色：面板不提供，内核也拒绝。
for (const mode of ["cmyk", "lab"]) {
  const refused = attempt(() => editor.channelCommand("channel.merge", JSON.stringify({ mode })));
  check(`${mode} 合并拒绝（多色彩管理不在范围）`, !refused.ok && refused.error.includes("CMYK/Lab"), refused.error);
}

// ---------------------------------------------------------------- 拒绝路径

const quickMask = attempt(() => editor.channelCommand("channel.target", JSON.stringify({ channel: "quickMask" })));
check("快速蒙版目标明确拒绝（选区蒙版 change 负责）", !quickMask.ok && quickMask.error.includes("快速蒙版"), quickMask.error);
const vectorMask = attempt(() => editor.channelCommand("channel.target", JSON.stringify({ channel: "vectorMask" })));
check("矢量蒙版目标明确拒绝（共享端口未接入）", !vectorMask.ok && vectorMask.error.includes("矢量蒙版"), vectorMask.error);
// 通道目标只接受复合 / RGB 分量 / Alpha 行；图层蒙版与不存在的 Alpha 都拒绝，不猜引用。
const layerMaskTarget = attempt(() => editor.channelCommand("channel.target", JSON.stringify({ channel: { layerMask: 0 } })));
check("图层蒙版目标不是合法通道引用", !layerMaskTarget.ok, layerMaskTarget.ok ? "未拒绝" : layerMaskTarget.error);
const missingAlphaTarget = attempt(() => editor.channelCommand("channel.target", JSON.stringify({ channel: { alpha: 0 } })));
check("不存在的 Alpha 目标被拒绝", !missingAlphaTarget.ok, missingAlphaTarget.ok ? "未拒绝" : missingAlphaTarget.error);
const missing = attempt(() => editor.channelCommand("channel.delete", JSON.stringify({ channel: 9 })));
check("缺通道时拒绝且不写入", !missing.ok && missing.error.toLowerCase().includes("alpha"), missing.error);

// 来源文档：尺寸不匹配与已失效索引分别拒绝（主线的「切来源文档、来源关闭」）。
const sources = new WasmEditor();
must("src file.new", () => sources.execute("file.new", JSON.stringify({ width: 32, height: 24 })));
must("src layer.new.layer", () => sources.execute("layer.new.layer", JSON.stringify({})));
must("src file.new#2", () => sources.execute("file.new", JSON.stringify({ width: 8, height: 8 })));
const sizeMismatch = attempt(() => sources.channelCommand("image.applyImage", JSON.stringify({
  source: { document: 0, channel: { color: 0 } }, blending: "normal", opacity: 100
})));
check("来源尺寸不匹配拒绝", !sizeMismatch.ok && sizeMismatch.error.includes("must match the target size"), sizeMismatch.error);
const closedSource = attempt(() => sources.channelCommand("image.applyImage", JSON.stringify({
  source: { document: 5, channel: { color: 0 } }, blending: "normal", opacity: 100
})));
check("来源索引失效拒绝", !closedSource.ok && closedSource.error.includes("no open document"), closedSource.error);

// 非活动来源文档：面板要能在不切文档的前提下列出它的分量与 Alpha 名，
// 并按名直接计算（切换文档会丢当前目标与草稿）。
const named = new WasmEditor();
must("named file.new", () => named.execute("file.new", JSON.stringify({ width: 16, height: 16 })));
must("named alpha", () => named.channelCommand("channel.new", JSON.stringify({ fill: "white", name: "来源 Alpha" })));
must("named file.new#2", () => named.execute("file.new", JSON.stringify({ width: 16, height: 16 })));
const namedRows = json("named channelSnapshotJson", () => named.channelSnapshotJson());
const namedSource = namedRows.documents.find((row) => row.active !== true) ?? {};
check("非活动来源文档自报分量与 Alpha 行",
  Array.isArray(namedSource.colorNames) && namedSource.colorNames.length === 3
  && namedSource.alpha.some((row) => row.name === "来源 Alpha" && row.kind === "alpha"),
  JSON.stringify(namedSource));
const namedApply = attempt(() => named.channelCommand("image.applyImage", JSON.stringify({
  source: { document: namedSource.index, channel: "来源 Alpha" }, blending: "normal", opacity: 100
})));
check("按名从非活动来源文档计算", namedApply.ok, namedApply.ok ? "" : namedApply.error);

// 「无变化不新增历史」：改名成同一个名字、选项与当前值全等都不写文档。
const history = (instance) => JSON.parse(instance.stateJson()).document.history;
const quiet = new WasmEditor();
must("quiet file.new", () => quiet.execute("file.new", JSON.stringify({ width: 16, height: 12 })));
must("quiet alpha", () => quiet.channelCommand("channel.new", JSON.stringify({ name: "Alpha 静默", opacity: 50 })));
const quietSteps = history(quiet).length;
const quietRevision = JSON.parse(quiet.stateJson()).document.revision;
must("quiet rename", () => quiet.channelCommand("channel.rename", JSON.stringify({ channel: 0, name: "  Alpha 静默  " })));
must("quiet options", () => quiet.channelCommand("channel.options", JSON.stringify({ channel: 0, name: "Alpha 静默", opacity: 50, indicates: "masked" })));
// 只给部分字段、且与当前值相同，同样不算变化（逐字段比较，不是「缺省即重写」）。
must("quiet options partial", () => quiet.channelCommand("channel.options", JSON.stringify({ channel: 0, opacity: 50 })));
check("无变化的改名/选项不新增历史",
  history(quiet).length === quietSteps && JSON.parse(quiet.stateJson()).document.revision === quietRevision,
  `hist ${quietSteps} -> ${history(quiet).length}`);
// 但只要有一个字段真的不同，就必须是正常的一步写入（短路不能吞掉真实修改）。
must("quiet options real", () => quiet.channelCommand("channel.options", JSON.stringify({ channel: 0, opacity: 45 })));
check("真正改动的选项仍是一步历史", history(quiet).length === quietSteps + 1, history(quiet).join("|"));
const quietAfterWrites = history(quiet).length;// 专色行的「不透明度/密度」落在同一字段上：相同值短路、真实改动仍写入、转回 Alpha 是结构变化。
const quietSpot = new WasmEditor();
must("quietspot file.new", () => quietSpot.execute("file.new", JSON.stringify({ width: 12, height: 12 })));
must("quietspot spot", () => quietSpot.channelCommand("channel.newSpot", JSON.stringify({ name: "S", color: "#00ff00", solidity: 30 })));
const quietSpotSteps = history(quietSpot).length;
must("quietspot same", () => quietSpot.channelCommand("channel.options", JSON.stringify({ channel: 0, solidity: 30, color: "#00ff00" })));
check("专色相同密度/颜色不新增历史", history(quietSpot).length === quietSpotSteps, history(quietSpot).join("|"));
must("quietspot changed", () => quietSpot.channelCommand("channel.options", JSON.stringify({ channel: 0, solidity: 31 })));
check("专色真实改动仍写入一步历史", history(quietSpot).length === quietSpotSteps + 1, history(quietSpot).join("|"));
const quietSpotKind = json("quietspot snapshot", () => quietSpot.channelSnapshotJson()).alpha[0];
check("专色改密度写进专色字段而不是不透明度",
  quietSpotKind.kind === "spot" && Math.abs(quietSpotKind.spot.solidity - 0.31) < 1e-6,
  JSON.stringify({ kind: quietSpotKind.kind, spot: quietSpotKind.spot }));
const quietSpotSteps2 = history(quietSpot).length;
must("quietspot to alpha", () => quietSpot.channelCommand("channel.options", JSON.stringify({ channel: 0, indicates: "selected" })));
const quietSpotAlpha = json("quietspot snapshot#2", () => quietSpot.channelSnapshotJson()).alpha[0];
check("专色给「表示」转回 Alpha 是结构变化",
  quietSpotAlpha.kind === "alpha" && quietSpotAlpha.spot === null
  && history(quietSpot).length === quietSpotSteps2 + 1,
  JSON.stringify({ kind: quietSpotAlpha.kind, spot: quietSpotAlpha.spot }));
quietSpot.free();

must("quiet visible", () => quiet.channelCommand("channel.setVisible", JSON.stringify({ channel: 0, visible: false })));
check("显隐仍是查看态（不新增历史）", history(quiet).length === quietAfterWrites);
must("quiet rename real", () => quiet.channelCommand("channel.rename", JSON.stringify({ channel: 0, name: "Alpha 真改" })));
check("真改名仍是一步历史", history(quiet).length === quietAfterWrites + 1, history(quiet).join("|"));

// 旧工程兼容：本 change 之前保存的通道行只有 name/surface/spot，缺叠层字段也要能重开与继续编辑。
const legacy = new WasmEditor();
must("legacy file.new", () => legacy.execute("file.new", JSON.stringify({ width: 16, height: 12 })));
must("legacy alpha", () => legacy.channelCommand("channel.new", JSON.stringify({ name: "Alpha 旧", fill: "white" })));
const legacyBytes = must("legacy save", () => legacy.saveProject());
const legacyRow = JSON.parse(legacy.channelSnapshotJson()).alpha[0];
check("旧通道行在新内核下带默认叠层元数据",
  legacyRow.opacity === 0.5 && legacyRow.indicates === "maskedAreas" && Array.isArray(legacyRow.color),
  JSON.stringify({ opacity: legacyRow.opacity, indicates: legacyRow.indicates }));
const reopenedLegacy = new WasmEditor();
must("legacy reopen", () => reopenedLegacy.openProject(legacyBytes, ""));
check("旧工程重开后通道仍可编辑",
  (() => { reopenedLegacy.channelCommand("channel.rename", JSON.stringify({ channel: 0, name: "Alpha 重开" }));
    return JSON.parse(reopenedLegacy.channelSnapshotJson()).alpha[0].name === "Alpha 重开"; })());

// ---------------------------------------------------------------- U25 其余结构操作（真实产物）

// 只读列表：`channel.list` 不改文档，且报出复合/RGB 分量的可见性与目标。
const listing = new WasmEditor();
must("list file.new", () => listing.execute("file.new", JSON.stringify({ width: 12, height: 12 })));
must("list channel.new", () => listing.channelCommand("channel.new", JSON.stringify({ name: "列出我" })));
const listBefore = JSON.parse(listing.stateJson()).document;
const listed = json("channel.list", () => listing.channelCommand("channel.list", "null"));
check("只读列表报出通道行且不改文档",
  listed.alpha.length === 1 && listed.alpha[0].name === "列出我"
  && JSON.parse(listing.stateJson()).document.revision === listBefore.revision
  && JSON.parse(listing.stateJson()).document.history.length === listBefore.history.length,
  JSON.stringify({ rows: listed.alpha.map((row) => row.name), cols: listed.colors.length }));
listing.free();

// 专色并入像素：一步历史、专色行消失、图层像素内容改变（不是只翻查看态）。
const merging = new WasmEditor();
must("mergespot file.new", () => merging.execute("file.new", JSON.stringify({ width: 16, height: 16 })));
must("mergespot layer", () => merging.execute("layer.new.layer", JSON.stringify({})));
must("mergespot spot", () => merging.channelCommand("channel.newSpot", JSON.stringify({ name: "待并入", color: "#00ff00", solidity: 100 })));
must("mergespot target", () => merging.channelCommand("channel.target", JSON.stringify({ channel: { alpha: 0 } })));
must("mergespot paint", () => merging.execute("paint.stroke", JSON.stringify({
  points: [[4, 4], [11, 11]], size: 6, hardness: 1, opacity: 1, flow: 1, color: "#ffffff", target: { channel: 0 }
})));
const mergeSpotHash = must("mergespot hash", () => merging.contentHash());
const mergeSpotHistory = JSON.parse(merging.stateJson()).document.history.length;
must("channel.mergeSpot", () => merging.channelCommand("channel.mergeSpot", JSON.stringify({ channel: 0 })));
const afterMergeSpot = JSON.parse(merging.channelSnapshotJson());
const mergeSpotHistoryAfter = JSON.parse(merging.stateJson()).document.history;
check("专色并入像素是一步历史且移除专色行",
  afterMergeSpot.alpha.length === 0 && mergeSpotHistoryAfter.length === mergeSpotHistory + 1
  && mergeSpotHistoryAfter.at(-1) === "Merge Spot Channel",
  JSON.stringify({ rows: afterMergeSpot.alpha.length, history: mergeSpotHistoryAfter.at(-1) }));
check("专色并入改变了图层像素内容",
  must("mergespot hash#2", () => merging.contentHash()) !== mergeSpotHash);
merging.free();

// 删除：目标跟着索引移动；删掉不存在的索引必须拒绝且不写文档。
const deleting = new WasmEditor();
must("delete file.new", () => deleting.execute("file.new", JSON.stringify({ width: 12, height: 12 })));
must("delete alpha A", () => deleting.channelCommand("channel.new", JSON.stringify({ name: "A" })));
must("delete alpha B", () => deleting.channelCommand("channel.new", JSON.stringify({ name: "B" })));
must("delete target B", () => deleting.channelCommand("channel.target", JSON.stringify({ channel: { alpha: 1 } })));
must("delete lower index", () => deleting.channelCommand("channel.delete", JSON.stringify({ channel: { alpha: 0 } })));
const afterDelete = JSON.parse(deleting.channelSnapshotJson());
check("删除低索引通道后目标仍指向同一个通道",
  afterDelete.alpha.length === 1 && afterDelete.alpha[0].name === "B"
  && afterDelete.target.kind === "alpha" && afterDelete.target.index === 0,
  JSON.stringify({ rows: afterDelete.alpha.map((row) => row.name), target: afterDelete.target }));
const staleDelete = attempt(() => deleting.channelCommand("channel.delete", JSON.stringify({ channel: { alpha: 1 } })));
check("删除不存在的索引被拒绝且不动文档",
  !staleDelete.ok && staleDelete.error.includes("no alpha channel")
  && JSON.parse(deleting.channelSnapshotJson()).alpha.length === 1,
  staleDelete.error);
deleting.free();

// 名称上限按**字符**（不是字节）计：200 个中文可以，201 个拒绝且不写文档。
const naming = new WasmEditor();
must("naming file.new", () => naming.execute("file.new", JSON.stringify({ width: 8, height: 8 })));
const namingBefore = JSON.parse(naming.channelSnapshotJson()).alpha.length;
const longName = attempt(() => naming.channelCommand("channel.new", JSON.stringify({ name: "通".repeat(200) })));
check("200 个中文字符的通道名可创建", longName.ok
  && JSON.parse(naming.channelSnapshotJson()).alpha[0].name.length === 200,
  longName.ok ? "" : longName.error);
const tooLong = attempt(() => naming.channelCommand("channel.new", JSON.stringify({ name: "通".repeat(201) })));
check("201 个字符的通道名被拒绝且不写文档",
  !tooLong.ok && tooLong.error.includes("200")
  && JSON.parse(naming.channelSnapshotJson()).alpha.length === namingBefore + 1,
  tooLong.ok ? "未拒绝" : tooLong.error);
naming.free();

// 来源图层：面板用名称输入；按名称与按 id 都能解析，未知名称必须拒绝而不是静默用合并图像。
const layering = new WasmEditor();
must("layer file.new", () => layering.execute("file.new", JSON.stringify({ width: 16, height: 16 })));
must("layer base", () => layering.execute("layer.new.layer", JSON.stringify({ name: "底" })));
must("layer top", () => layering.execute("layer.new.layer", JSON.stringify({ name: "目标" })));
const layerBase = JSON.parse(layering.stateJson()).document.layers.find((row) => row.name === "底");
const byName = attempt(() => layering.channelCommand("image.applyImage", JSON.stringify({
  source: { layer: "底", channel: "composite" }, blending: "normal", opacity: 100
})));
check("应用图像按图层名解析来源", byName.ok, byName.ok ? "" : byName.error);
const byId = attempt(() => layering.channelCommand("image.applyImage", JSON.stringify({
  source: { layer: layerBase.id, channel: "composite" }, blending: "normal", opacity: 100
})));
check("应用图像按图层 id 解析来源", byId.ok, byId.ok ? "" : byId.error);
const unknownLayer = attempt(() => layering.channelCommand("image.applyImage", JSON.stringify({
  source: { layer: "不存在的图层", channel: "composite" }, blending: "normal", opacity: 100
})));
check("未知来源图层被拒绝（不静默退化成合并图像）",
  !unknownLayer.ok && unknownLayer.error.includes("no source layer named"), unknownLayer.error);
layering.free();

// 「存储选区为通道」是「载入通道为选区」的反向路径：有选区才写，无选区明确拒绝。
const saving = new WasmEditor();
must("save file.new", () => saving.execute("file.new", JSON.stringify({ width: 16, height: 16 })));
must("save layer", () => saving.execute("layer.new.layer", JSON.stringify({})));
const noSelection = attempt(() => saving.execute("select.saveSelection", JSON.stringify({ channel: "new", operation: "new" })));
check("无选区时存储选区被拒绝且不新增通道",
  !noSelection.ok && noSelection.error.includes("no selection")
  && JSON.parse(saving.channelSnapshotJson()).alpha.length === 0,
  noSelection.ok ? "未拒绝" : noSelection.error);
must("save select.rect", () => saving.execute("select.rect", JSON.stringify({ x: 2, y: 2, width: 8, height: 8, mode: "replace" })));
const saveHistory = JSON.parse(saving.stateJson()).document.history.length;
const savedRow = json("save selection", () => saving.execute("select.saveSelection", JSON.stringify({ channel: "new", operation: "new" })));
const savedAlpha = json("save snapshot", () => saving.channelSnapshotJson()).alpha;
check("存储选区为通道新增一行且是一步历史",
  typeof savedRow.channel === "number" && savedAlpha.length === 1 && savedAlpha[0].name === "Alpha 1"
  && JSON.parse(saving.stateJson()).document.history.length === saveHistory + 1,
  JSON.stringify({ channel: savedRow.channel, names: savedAlpha.map((row) => row.name) }));
saving.free();

// 笔画进行中：通道结构命令与预览都必须拒绝，取消后不补交半笔。
const stroking = new WasmEditor();
must("stroke file.new", () => stroking.execute("file.new", JSON.stringify({ width: 16, height: 16 })));
must("stroke layer", () => stroking.execute("layer.new.layer", JSON.stringify({ name: "L" })));
must("stroke alpha", () => stroking.channelCommand("channel.new", JSON.stringify({ name: "A" })));
const strokeHash = must("stroke hash", () => stroking.contentHash());
const strokeHistory = JSON.parse(stroking.stateJson()).document.history.length;
must("stroke begin", () => stroking.beginStroke(JSON.stringify({
  points: [[3, 3], [12, 12]], size: 3, hardness: 1, opacity: 1, flow: 1, color: "#ffffff", target: { channel: 0 }
})));
const strokeCommand = attempt(() => stroking.channelCommand("channel.new", JSON.stringify({ name: "不该创建" })));
check("笔画进行中拒绝通道结构命令", !strokeCommand.ok && strokeCommand.error.includes("笔迹"), strokeCommand.error);
const strokePreview = attempt(() => stroking.channelCalcPreview("image.applyImage", JSON.stringify({
  source: { channel: { alpha: 0 } }, target: { channel: 0 }
}), 16));
check("笔画进行中拒绝通道预览", !strokePreview.ok && strokePreview.error.includes("笔迹"), strokePreview.error);
must("stroke cancel", () => stroking.cancelStroke());
check("取消笔画不补交半笔也不改通道",
  must("stroke hash#2", () => stroking.contentHash()) === strokeHash
  && JSON.parse(stroking.stateJson()).document.history.length === strokeHistory
  && JSON.parse(stroking.channelSnapshotJson()).alpha.length === 1,
  "取消后指纹/历史/通道行均不变");
stroking.free();

// 图层蒙版目标：内核只写图层像素，必须明确拒绝而不是静默错写。
const maskTarget = attempt(() => quiet.channelCommand("image.applyImage", JSON.stringify({
  source: { channel: { color: 1 } }, blending: "normal", opacity: 100, target: "mask"
})));
check("图层蒙版目标明确拒绝（不静默写像素）",
  !maskTarget.ok && maskTarget.error.includes("图层蒙版目标"), maskTarget.error);

let failed = 0;
for (const item of results) {
  if (!item.pass) failed += 1;
  console.log(`${item.pass ? "PASS" : "FAIL"} ${item.label}${item.detail ? ` :: ${item.detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (failed) process.exitCode = 1;
