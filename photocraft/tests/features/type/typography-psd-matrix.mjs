/**
 * 本域排版字段的 PSD 往返实测（change: 2026-10-22-add-photocraft-typography-workflows）。
 *
 * 需要先构建真实内核：
 *
 *   pnpm -C photocraft run wasm
 *   node photocraft/tests/features/type/typography-psd-matrix.mjs
 *
 * 这是 tasks 3.2 中「跨文档/PSD 矩阵」里**本域可自动化**的那一半：PSD 的编解码属于
 * 兄弟域（`features/io`），本域不去改它，但要如实记录本域新增的持久排版字段在 PSD 上
 * 到底保不保得住，而不是笼统写「PSD 已支持文字」。
 *
 * 断言的是「写进去的排版字段能不能原样读回来」：
 * 1. 行距/字距/字偶距这类字符属性；
 * 2. OpenType 特性（`frac`，用上游 tag 而不是命令名）；
 * 3. 抗锯齿方式；
 * 4. Warp 变形（样式 + 弯曲值）。
 *
 * 它**不**证明其它域的对象类型、也不证明像素观感；那些各自有域内证据或待人工验证。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/editor/dist/wasm");
const glue = path.join(root, "photocraft_editor.js");
const wasm = path.join(root, "photocraft_editor_bg.wasm");
if (!fs.existsSync(glue) || !fs.existsSync(wasm)) {
  console.error(`缺少已构建内核：先运行 pnpm -C photocraft run wasm（${root}）`);
  process.exit(2);
}

const mod = await import(glue);
mod.initSync({ module: fs.readFileSync(wasm) });

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : ` → ${JSON.stringify(detail).slice(0, 300)}`}`);
};

const editor = new mod.WasmEditor();
editor.execute("file.new", JSON.stringify({ width: 300, height: 160, background: "white" }));
const layer = JSON.parse(editor.execute("type.create", JSON.stringify({ x: 20, y: 70, text: "Psd type", size: 24, font: "Inter" }))).layer;

// 逐项写入本域新增/接通的排版字段。
editor.execute("type.setStyle", JSON.stringify({ layer, leading: 30, tracking: 40, baselineShift: 2 }));
editor.typeCommand("type.openType.fractions", JSON.stringify({ layer, on: true }));
editor.typeCommand("type.antiAlias.smooth", JSON.stringify({ layer }));
editor.typeCommand("type.warpText", JSON.stringify({ layer, style: "arc", bend: 25 }));

const readInfo = (target, layerId) =>
  JSON.parse(target.typeQuery("type.info", JSON.stringify({ layer: layerId })));
const before = readInfo(editor, layer);

// 导出预检必须是「可编辑、无阻塞」：否则后面的往返结论没有意义。
const preflight = JSON.parse(editor.inspectPsdExport());
const rows = Array.isArray(preflight) ? preflight : (preflight.layers ?? []);
check("PSD 预检无阻塞项", (preflight.blocking ?? 0) === 0, preflight);
check("PSD 预检把文字层视为可编辑", preflight.editable !== false || rows.length === 0, preflight);

const psd = editor.exportPsd(JSON.stringify({}));
check("PSD 导出产生字节", psd.length > 0, psd.length);
const report = JSON.parse(editor.lastPsdExportReportJson());
check("PSD 导出没有把文字栅格化", report.rasterized === false, report);
check("PSD 导出没有丢字损失行", Array.isArray(report.lossy) && report.lossy.length === 0, report);

// 读回来：同一份文字层的排版字段必须逐项一致。
const reopened = new mod.WasmEditor();
reopened.importPsd(psd, JSON.stringify({}));
const state = JSON.parse(reopened.stateJson());
const textLayer = state.document.layers.find((item) => item.kind === "Type");
check("PSD 重开保留文字层", Boolean(textLayer), state.document.layers.map((item) => item.kind));
if (textLayer) {
  const after = readInfo(reopened, textLayer.id);
  check("PSD 往返保留正文", after.text === before.text, { before: before.text, after: after.text });
  check("PSD 往返保留字号", after.runs?.[0]?.style?.size_pt === before.runs?.[0]?.style?.size_pt);
  check("PSD 往返保留行距", after.runs?.[0]?.style?.leading_pt === 30, after.runs?.[0]?.style?.leading_pt);
  check("PSD 往返保留字距", after.runs?.[0]?.style?.tracking === 40, after.runs?.[0]?.style?.tracking);
  check("PSD 往返保留基线偏移", after.runs?.[0]?.style?.baseline_shift_pt === 2, after.runs?.[0]?.style?.baseline_shift_pt);
  const frac = (after.runs?.[0]?.style?.features ?? []).find((feature) => feature.tag === "frac");
  check("PSD 往返保留 OpenType 特性", frac?.value === 1, after.runs?.[0]?.style?.features);
  check("PSD 往返保留抗锯齿方式", after.antialias === "Smooth", after.antialias);
  check("PSD 往返保留 Warp 样式", after.warp?.style === "warpArc", after.warp);
  check("PSD 往返保留 Warp 弯曲值", after.warp?.value === 25, after.warp);
  // 内容身份由持久字段计算：往返后必须仍是可用的 16 位身份。
  const hash = reopened.contentHash();
  check("PSD 重开得到内容身份", typeof hash === "string" && hash.length === 16, hash);
}

reopened.free();
editor.free();

if (failures) {
  console.error(`PSD 排版字段往返实测失败 ${failures} 项`);
  process.exit(1);
}
console.log("PSD 排版字段往返实测通过：行距/字距/基线/OpenType/抗锯齿/Warp 原样读回，预检与导出均无损失项");
