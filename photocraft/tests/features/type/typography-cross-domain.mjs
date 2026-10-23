/**
 * 跨域保存与核验的域内实测（change: 2026-10-22-add-photocraft-typography-workflows，tasks 5.2
 * 里**不依赖真实设备**的那一半）。
 *
 * 需要先构建真实内核与真实核验器：
 *
 *   pnpm -C photocraft run wasm
 *   pnpm -C photocraft run verifier
 *   node photocraft/tests/features/type/typography-cross-domain.mjs
 *
 * 它证明的是「文字域和兄弟域放在同一份工程里不会互相破坏」：
 * 1. 同文档里同时存在 Group / Adjustment / Shape / Type / Pixel，各自命令都能写；
 * 2. 文字域写入（OpenType、Warp、行距）与兄弟域写入交错执行后，兄弟域对象仍在、文字字段一致；
 * 3. 导出工程 → **用真实核验器二进制**（与编辑器共用同一解析实现）核验通过，且摘要里的
 *    图层数与画布尺寸与内核一致；
 * 4. 重开工程后文字排版与兄弟域对象都还在，内容身份可复算。
 *
 * 边界：这里**不**采集像素观感、帧率或 UI 交互——那些要真实设备与显示会话，属 4.2 待人工验证。
 * 本脚本也不替代 sibling 域自己的验收；它只证明「放在一起时本域不破坏它们」。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../packages/editor/dist/wasm");
const glue = path.join(root, "photocraft_editor.js");
const wasm = path.join(root, "photocraft_editor_bg.wasm");
const verifier = path.resolve(here, "../../../packages/project-verifier/dist/bin/photocraft-project-verify");

for (const [label, file] of [["内核", glue], ["内核 wasm", wasm], ["核验器", verifier]]) {
  if (!fs.existsSync(file)) {
    console.error(`缺少${label}：先运行 pnpm -C photocraft run wasm / run verifier（${file}）`);
    process.exit(2);
  }
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
editor.execute("file.new", JSON.stringify({ width: 400, height: 300, background: "white" }));

// 四个兄弟域对象 + 一个文字层，全部通过各自域的入口创建。
const textLayer = JSON.parse(
  editor.execute("type.create", JSON.stringify({ x: 20, y: 90, text: "Cross", size: 28, font: "Inter" }))
).layer;
const shapeLayer = JSON.parse(
  editor.execute("shape.create", JSON.stringify({ rect: [10, 10, 80, 50], fill: "#3366cc" }))
).layer;
const adjustmentLayer = JSON.parse(editor.execute("layer.newAdjustmentLayer.levels", JSON.stringify({}))).layer;
const groupLayer = JSON.parse(editor.execute("layer.new.group", JSON.stringify({ name: "组" }))).layer;
for (const [label, id] of [
  ["形状", shapeLayer],
  ["调整", adjustmentLayer],
  ["组", groupLayer],
  ["文字", textLayer]
]) {
  check(`创建${label}层`, typeof id === "number", id);
}

// 交错写入：文字域与兄弟域交替，验证双方都不把对方的状态清掉。
editor.typeCommand("type.openType.fractions", JSON.stringify({ layer: textLayer, on: true }));
editor.execute("layer.newAdjustmentLayer.vibrance", JSON.stringify({}));
editor.applyTypography(JSON.stringify({ layer: textLayer, leading: 34, tracking: 30 }));
editor.typeCommand("type.warpText", JSON.stringify({ layer: textLayer, style: "arc", bend: 15 }));
editor.execute("layer.new.group", JSON.stringify({ name: "组二" }));

const kinds = JSON.parse(editor.stateJson()).document.layers.map((layer) => layer.kind);
for (const kind of ["Group", "Adjustment", "Shape", "Type", "Pixel"]) {
  check(`工程里仍有 ${kind} 层`, kinds.includes(kind), kinds);
}

const textInfo = JSON.parse(editor.typeQuery("type.info", JSON.stringify({ layer: textLayer })));
check("文字层行距保住了本域写入", textInfo.runs?.[0]?.style?.leading_pt === 34, textInfo.runs?.[0]?.style?.leading_pt);
check("文字层字距保住了本域写入", textInfo.runs?.[0]?.style?.tracking === 30, textInfo.runs?.[0]?.style?.tracking);
check(
  "文字层 OpenType 特性保住了本域写入",
  (textInfo.runs?.[0]?.style?.features ?? []).some((feature) => feature.tag === "frac"),
  textInfo.runs?.[0]?.style?.features
);
check("文字层 Warp 保住了本域写入", textInfo.warp?.value === 15, textInfo.warp);

const shapeInfo = JSON.parse(editor.execute("shape.info", JSON.stringify({ layer: shapeLayer })));
check("形状层保住了兄弟域写入", shapeInfo.fill === "#3366cc", shapeInfo.fill);

// 真实核验器：字节只走 stdin，与编辑器共用同一解析实现。
const bundle = editor.exportBundle();
const project = Buffer.from(bundle.project);
bundle.free();
check("工程导出为非空字节", project.length > 0, project.length);

const verified = spawnSync(verifier, [], { input: project, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
check("核验器正常退出", verified.status === 0, { status: verified.status, stderr: String(verified.stderr).slice(0, 200) });
let report = null;
try {
  report = JSON.parse(verified.stdout);
} catch {
  check("核验器输出可解析", false, String(verified.stdout).slice(0, 200));
}
const summary = report?.summary ?? null;
if (report) {
  check("核验通过（ok:true）", report.ok === true, report);
  check("核验未报不支持的域对象", !String(report.message ?? "").includes("文字"), report.message);
}
if (summary) {
  // 图层数与画布直接取自同一份导出字节，所以必须与内核当前模型完全一致。
  const state = JSON.parse(editor.stateJson());
  check("核验图层数与内核一致", summary.layerCount === state.document.layers.length, {
    summary: summary.layerCount,
    kernel: state.document.layers.length
  });
  check("核验画布与内核一致", summary.canvasWidth === 400 && summary.canvasHeight === 300, {
    width: summary.canvasWidth,
    height: summary.canvasHeight
  });
  // 对象类型是核验器自己判定的：文字域的对象必须被识别成 text，而不是被降级或拒绝。
  for (const kind of ["text", "shape", "adjustment", "group", "raster"]) {
    check(`核验把 ${kind} 识别为支持对象`, (summary.objectKinds ?? []).includes(kind), summary.objectKinds);
  }
}

// 重开：排版与兄弟域对象都还在，内容身份可复算。
const reopened = new mod.WasmEditor();
try {
  reopened.openProject(project, "");
} catch (error) {
  check("重开跨域工程", false, String(error).slice(0, 240));
}
const reopenedState = JSON.parse(reopened.stateJson());
const reopenedKinds = reopenedState.document.layers.map((layer) => layer.kind);
for (const kind of ["Group", "Adjustment", "Shape", "Type"]) {
  check(`重开后仍有 ${kind} 层`, reopenedKinds.includes(kind), reopenedKinds);
}
const reopenedText = reopenedState.document.layers.find((layer) => layer.kind === "Type");
check("重开后文字层可定位", Boolean(reopenedText), reopenedKinds);
if (reopenedText) {
  const info = JSON.parse(reopened.typeQuery("type.info", JSON.stringify({ layer: reopenedText.id })));
  check("重开后正文一致", info.text === "Cross", info.text);
  check("重开后行距一致", info.runs?.[0]?.style?.leading_pt === 34, info.runs?.[0]?.style?.leading_pt);
  check("重开后 Warp 一致", info.warp?.value === 15, info.warp);
  check(
    "重开后 OpenType 一致",
    (info.runs?.[0]?.style?.features ?? []).some((feature) => feature.tag === "frac"),
    info.runs?.[0]?.style?.features
  );
}
const reopenedHash = reopened.contentHash();
check("重开后可复算内容身份", typeof reopenedHash === "string" && reopenedHash.length === 16, reopenedHash);

reopened.free();
editor.free();

if (failures) {
  console.error(`跨域保存/核验实测失败 ${failures} 项`);
  process.exit(1);
}
console.log(
  "跨域保存/核验实测通过：Group/Adjustment/Shape/Type/Pixel 共存、本域排版与兄弟域写入互不破坏、真实核验器通过、重开后身份可复算"
);
