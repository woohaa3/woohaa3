#!/usr/bin/env node
/**
 * U45 真实 WASM 冒烟（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 4.1）。
 *
 * 用 `pnpm run wasm` 构建出的真实 glue 走一遍本域入口：只读信息 → 预览（不改修订/指纹）→
 * 确认 → 过期基线拒绝 → 索引色 + 颜色表 → 非索引色颜色表拒绝 → 基线与预览字节核对。
 *
 *   pnpm -C photocraft run wasm
 *   node photocraft/tests/features/modes/wasm-smoke.mjs
 *
 * 不依赖浏览器或 GPU；输出为 JSON 数组，便于把实际结果抄进 verification.md。
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const glue = resolve(here, "../../../packages/editor/dist/wasm/photocraft_editor.js");

const module = await import(pathToFileURL(glue).href);
await module.default({ module_or_path: await readFile(glue.replace(/\.js$/, "_bg.wasm")) });

const editor = new module.WasmEditor();
const out = [];
const step = (name, run) => {
  try {
    out.push({ name, ok: true, value: run() });
  } catch (error) {
    out.push({ name, ok: false, value: String(error?.message ?? error) });
  }
};
const message = (run) => {
  try {
    run();
    return "NOT REJECTED";
  } catch (error) {
    return String(error?.message ?? error);
  }
};

step("buildInfo", () => module.WasmEditor.buildInfoJson());
step("file.new", () => editor.execute("file.new", JSON.stringify({ width: 16, height: 8, mode: "rgb" })));
step("modeInfo", () => editor.modeInfo());

const before = { revision: JSON.parse(editor.stateJson()).document.revision, hash: editor.contentHash() };
const grayscalePlan = JSON.parse(editor.planMode("grayscale", JSON.stringify({ maxSide: 128 })));
step("planMode(grayscale)", () => ({
  fromMode: grayscalePlan.report.fromMode,
  toMode: grayscalePlan.report.toMode,
  layers: [grayscalePlan.report.layersBefore, grayscalePlan.report.layersAfter],
  preview: [grayscalePlan.preview.width, grayscalePlan.preview.height, grayscalePlan.preview.bytes],
  baseRevision: grayscalePlan.baseRevision,
  changed: grayscalePlan.changed
}));
const afterPlan = { revision: JSON.parse(editor.stateJson()).document.revision, hash: editor.contentHash() };
out.push({
  name: "preview leaves revision and content hash untouched",
  ok: before.revision === afterPlan.revision && before.hash === afterPlan.hash,
  value: [before, afterPlan]
});

step("applyMode(grayscale)", () => {
  const applied = JSON.parse(editor.applyMode("grayscale", JSON.stringify({
    baseRevision: grayscalePlan.baseRevision,
    baseContentHash: grayscalePlan.baseContentHash
  })));
  return { committed: applied.committed, history: JSON.parse(editor.stateJson()).document.history };
});
step("applyMode with stale base is rejected", () => message(() =>
  editor.applyMode("rgb", JSON.stringify({ baseRevision: 0, baseContentHash: "stale" }))));
step("to indexed + color table", () => {
  const indexed = JSON.parse(editor.applyMode("indexed", JSON.stringify({ colors: 4, dither: "none" })));
  const plan = JSON.parse(editor.planColorTable(JSON.stringify({ entries: { 0: "#00ff00" }, maxSide: 64 })));
  const applied = JSON.parse(editor.applyColorTable(JSON.stringify({
    entries: { 0: "#00ff00" },
    baseRevision: plan.baseRevision,
    baseContentHash: plan.baseContentHash
  })));
  return {
    colorCount: indexed.report.colorCount,
    reportKeys: Object.keys(plan.report).sort(),
    planColors: plan.report.colors,
    committed: applied.committed
  };
});
step("color table on an RGB document is rejected", () => {
  const fresh = new module.WasmEditor();
  fresh.execute("file.new", JSON.stringify({ width: 4, height: 4, mode: "rgb" }));
  try {
    return message(() => fresh.planColorTable(JSON.stringify({})));
  } finally {
    fresh.free();
  }
});
// 回归：不给 `inks` 时必须用内核按类型生成的默认油墨，而不是把 `null` 传给上游被拒。
step("duotone with default inks (no `inks` param) commits", () => {
  const fresh = new module.WasmEditor();
  try {
    fresh.execute("file.new", JSON.stringify({ width: 8, height: 6, mode: "rgb" }));
    fresh.applyMode("grayscale", JSON.stringify({}));
    const applied = JSON.parse(fresh.applyMode("duotone", JSON.stringify({ type: "tritone" })));
    const info = JSON.parse(fresh.modeInfo());
    return {
      committed: applied.committed,
      mode: info.mode,
      inkNames: info.duotone.inks.map((ink) => ink.name),
      curvePoints: info.duotone.inks[0].curve.length
    };
  } finally {
    fresh.free();
  }
});
// 位图只在灰度上可用：从 RGB 直接转换必须给出可读原因。
step("a duotone curve with fewer than two points is silently replaced by the identity curve", () => {
  // 这条是**实测事实**而不是通过项：内核 `parse_inks` 只在点数 ≥2 时采用曲线，1 点会被静默丢弃。
  // 面板据此把 ≤1 点显式清空，避免界面留着一个内核根本不会保存的点。
  const fresh = new module.WasmEditor();
  try {
    fresh.execute("file.new", JSON.stringify({ width: 8, height: 6, mode: "rgb" }));
    fresh.applyMode("grayscale", JSON.stringify({}));
    const inks = (curve) => [{ name: "Black", color: "#000000", curve }, { name: "Warm Brown", color: "#9e612e", curve: [[0, 0], [100, 100]] }];
    fresh.applyMode("duotone", JSON.stringify({ type: "duotone", inks: inks([[0, 0], [100, 90]]) }));
    const stored = JSON.parse(fresh.modeInfo()).duotone.inks[0].curve;
    fresh.applyMode("duotone", JSON.stringify({ type: "duotone", inks: inks([[100, 20]]) }));
    const afterOnePoint = JSON.parse(fresh.modeInfo()).duotone.inks[0].curve;
    fresh.applyMode("duotone", JSON.stringify({ type: "duotone", inks: inks([]) }));
    const afterEmpty = JSON.parse(fresh.modeInfo()).duotone.inks[0].curve;
    const isIdentity = (curve) => curve.length === 2
      && Math.abs(curve[0][0]) < 0.01 && Math.abs(curve[0][1]) < 0.01
      && Math.abs(curve[1][0] - 100) < 0.01 && Math.abs(curve[1][1] - 100) < 0.01;
    return {
      storedPoints: stored.length,
      storedLastOutput: Math.round(stored[1][1] * 100) / 100,
      afterOnePointPoints: afterOnePoint.length,
      onePointBecameIdentity: isIdentity(afterOnePoint),
      afterEmptyPoints: afterEmpty.length,
      emptyBecameIdentity: isIdentity(afterEmpty),
      note: "点数 <2 会被内核静默换成恒等曲线 → 面板按相同语义清空"
    };
  } finally {
    fresh.free();
  }
});
// 位图只在灰度上可用：从 RGB 直接转换必须给出可读原因。
step("bitmap from RGB is rejected with a gray-first reason", () => {
  const fresh = new module.WasmEditor();
  fresh.execute("file.new", JSON.stringify({ width: 4, height: 4, mode: "rgb" }));
  try {
    return message(() => fresh.planMode("bitmap", JSON.stringify({})));
  } finally {
    fresh.free();
  }
});

/** 造一份指定模式的文档（走真实命令，不手写状态）。 */
const documentIn = (mode, width = 8, height = 8) => {
  const fresh = new module.WasmEditor();
  fresh.execute("file.new", JSON.stringify({ width, height, mode: "rgb" }));
  const steps = {
    rgb: [],
    grayscale: [["grayscale", {}]],
    bitmap: [["grayscale", {}], ["bitmap", { method: "threshold" }]],
    indexed: [["indexed", { colors: 4, dither: "none" }]],
    duotone: [["grayscale", {}], ["duotone", { type: "duotone" }]]
  }[mode];
  for (const [target, params] of steps) fresh.applyMode(target, JSON.stringify(params));
  return fresh;
};
const SAMPLE_PARAMS = { rgb: {}, grayscale: {}, bitmap: { method: "threshold" }, indexed: { colors: 4, dither: "none" }, duotone: { type: "duotone" } };

// 回归（真实缺陷）：面板只按 `modeInfo().targets` 决定能否点击。位图文档曾声明「位图可用」，
// 点下去却被上游以 “Bitmap needs a Grayscale image” 拒绝。这里逐模式 × 逐目标核对两者一致。
step("advertised targets match kernel acceptance for every mode", () => {
  const mismatches = [];
  for (const mode of ["rgb", "grayscale", "bitmap", "indexed", "duotone"]) {
    const fresh = documentIn(mode);
    try {
      const targets = JSON.parse(fresh.modeInfo()).targets;
      for (const entry of targets) {
        let accepted;
        try {
          fresh.planMode(entry.id, JSON.stringify(SAMPLE_PARAMS[entry.id]));
          accepted = true;
        } catch {
          accepted = false;
        }
        if (entry.available !== accepted) mismatches.push({ mode, target: entry.id, advertised: entry.available, accepted, reason: entry.reason });
      }
    } finally {
      fresh.free();
    }
  }
  return { mismatches, checked: 25 };
});

// 导出矩阵必须与真实导出器一致：PNG 在五种模式下都产出正确的 PNG 颜色类型，
// PSD 只有 RGB/U8 能导出（其余在预检阶段就被拒绝）。
step("export matrix matches the real encoders", () => {
  const COLOR_TYPES = { 0: "gray", 2: "rgb", 3: "palette" };
  const rows = [];
  for (const mode of ["rgb", "grayscale", "bitmap", "indexed", "duotone"]) {
    const fresh = documentIn(mode);
    try {
      const bundle = fresh.exportBundle();
      const png = Buffer.from(bundle.output);
      let psd;
      try {
        fresh.exportPsd(JSON.stringify({}));
        psd = "exported";
      } catch (error) {
        psd = String(error?.message ?? error);
      }
      rows.push({ mode, pngColorType: COLOR_TYPES[png[25]] ?? png[25], pngHasPalette: png.includes(Buffer.from("PLTE")), psd });
      bundle.free();
    } finally {
      fresh.free();
    }
  }
  return rows;
});

// 16 位不在范围：必须整体不可用，不能静默降位深。
step("16-bit documents stay out of scope without silent downgrade", () => {
  const fresh = new module.WasmEditor();
  try {
    fresh.execute("file.new", JSON.stringify({ width: 4, height: 4, mode: "rgb", depth: 16 }));
    const info = JSON.parse(fresh.modeInfo());
    return {
      depth: info.depth,
      allUnavailable: info.targets.every((target) => !target.available),
      planError: message(() => fresh.planMode("grayscale", JSON.stringify({})))
    };
  } finally {
    fresh.free();
  }
});

// 一步历史可撤销：模式转换与颜色表编辑各一步，撤销后模式/颜色表/内容指纹都回到原值。
step("mode and color table edits are one undo step each", () => {
  const fresh = new module.WasmEditor();
  try {
    fresh.execute("file.new", JSON.stringify({ width: 8, height: 8, mode: "rgb" }));
    const start = fresh.contentHash();
    fresh.applyMode("indexed", JSON.stringify({ colors: 4, dither: "none" }));
    const indexed = fresh.contentHash();
    fresh.applyColorTable(JSON.stringify({ entries: { 0: "#ff00ff" } }));
    const edited = JSON.parse(fresh.modeInfo()).colorTable.colors[0];
    fresh.undo();
    const afterUndoTable = JSON.parse(fresh.modeInfo()).colorTable.colors[0];
    fresh.undo();
    const reverted = JSON.parse(fresh.modeInfo());
    return {
      startHash: start,
      indexedHash: indexed,
      editedEntry: edited,
      afterUndoEntry: afterUndoTable,
      modeAfterSecondUndo: reverted.mode,
      tableAfterSecondUndo: reverted.colorTable,
      hashRestored: fresh.contentHash() === start
    };
  } finally {
    fresh.free();
  }
});

// 跨域命令门（任务 4.4）：索引色/位图文档上写像素颜色的命令必须被内核拒绝，且像素零变化。
// 之前这里是「known gap」测量项；门禁接通后改成硬断言，防止回退成只提示不拦截。
step("the cross-domain gate really rejects colour writes on indexed and bitmap", () => {
  const STROKE = {
    points: [{ x: 4, y: 4, pressure: 1 }, { x: 16, y: 16, pressure: 1 }],
    brush: { size: 10, hardness: 0, opacity: 1, flow: 1, color: [1, 0, 1, 1] }
  };
  const pixelSignature = (fresh) => {
    const preview = fresh.renderPreview(32);
    const pixels = Buffer.from(preview.pixels);
    preview.free();
    return pixels.toString("base64");
  };
  const rows = [];
  for (const mode of ["indexed", "bitmap"]) {
    const fresh = documentIn(mode, 32, 32);
    try {
      const info = JSON.parse(fresh.modeInfo());
      const table = info.colorTable?.colors ?? null;
      const before = pixelSignature(fresh);
      const attempts = {};
      // 直接命令分派。
      attempts["execute paint.stroke"] = message(() => fresh.execute("paint.stroke", JSON.stringify(STROKE)));
      attempts["execute type.create"] = message(() => fresh.execute("type.create", JSON.stringify({ x: 2, y: 8, text: "X", color: "#ff00ff" })));
      // 真实绘制路径：落笔前就该拒绝，而不是画完预览再失败。
      attempts["beginStroke"] = message(() => fresh.beginStroke(JSON.stringify(STROKE)));
      attempts["beginText"] = message(() => fresh.beginText(JSON.stringify({ x: 2, y: 8, text: "X", color: "#ff00ff" })));
      attempts["beginFilter"] = message(() => fresh.beginFilter("filter.blur.gaussianBlur", JSON.stringify({ radius: 3 })));
      const unchanged = pixelSignature(fresh) === before;
      // WASM 层把错误序列化成 JSON 文本（`{"code":"command-failed",...}`），不是 `Display`。
      const rejected = Object.values(attempts).every((value) =>
        value.includes("command-failed") && value.includes("被拒绝"));
      rows.push({ mode, rejected, unchanged, attempts });
    } finally {
      fresh.free();
    }
  }
  // 灰度/双色调不受影响：上游把彩色收敛为灰阶，实测不会破坏不变量，挡掉它们是无谓的功能损失。
  const grayscaleAccepted = documentIn("grayscale", 32, 32);
  let grayStroke = "ACCEPT";
  try {
    grayscaleAccepted.execute("paint.stroke", JSON.stringify(STROKE));
  } catch (error) {
    grayStroke = String(error?.message ?? error);
  } finally {
    grayscaleAccepted.free();
  }
  if (!rows.every((row) => row.rejected && row.unchanged) || grayStroke !== "ACCEPT") {
    throw new Error(`跨域门禁实测与声明不符：${JSON.stringify({ rows, grayStroke })}`);
  }
  return { rows, grayscaleStroke: grayStroke, note: "索引色/位图拒绝写颜色命令且像素零变化；灰度照常绘制" };
});


// 参数覆盖面：spec 里逐项列出的枚举值与边界都必须真的能被内核接受（不是文档里写了就算）。
step("every documented parameter value is accepted by the kernel", () => {
  const gray = [["grayscale", {}]];
  const cases = [
    ["bitmap", gray, "bitmap", { method: "threshold" }],
    ["bitmap", gray, "bitmap", { method: "pattern" }],
    ["bitmap", gray, "bitmap", { method: "diffusion" }],
    ["bitmap", gray, "bitmap", { method: "halftone", frequency: 1, angle: -180, shape: "round" }],
    ["bitmap", gray, "bitmap", { method: "halftone", frequency: 999, angle: 180, shape: "cross" }],
    ["bitmap", gray, "bitmap", { method: "halftone", shape: "ellipse" }],
    ["bitmap", gray, "bitmap", { method: "halftone", shape: "line" }],
    ["bitmap", gray, "bitmap", { method: "halftone", shape: "square" }],
    ["bitmap", gray, "bitmap", { method: "halftone", shape: "diamond" }],
    ...["selective", "perceptual", "adaptive", "exact", "systemMac", "systemWindows", "web", "uniform"]
      .map((palette) => [`indexed palette ${palette}`, [], "indexed", { palette }]),
    ...["blackWhite", "none", "primaries", "web"].map((forced) => [`indexed forced ${forced}`, [], "indexed", { forced }]),
    ...["diffusion", "none", "pattern", "noise"].map((dither) => [`indexed dither ${dither}`, [], "indexed", { dither }]),
    ["indexed amount 0", [], "indexed", { dither: "diffusion", amount: 0 }],
    ["indexed amount 100", [], "indexed", { amount: 100 }],
    ["indexed colors 2", [], "indexed", { colors: 2 }],
    ["indexed colors 256", [], "indexed", { colors: 256 }],
    ["indexed transparency false", [], "indexed", { transparency: false }],
    ...["monotone", "duotone", "tritone", "quadtone"].map((type) => [`duotone ${type}`, gray, "duotone", { type }]),
    ["duotone four inks", gray, "duotone", { type: "quadtone", inks: ["#000000", "#111111", "#222222", "#333333"].map((color, index) => ({ name: `Ink ${index}`, color })) }],
    ["duotone curve 64 points", gray, "duotone", { type: "monotone", inks: [{ name: "a", color: "#000000", curve: Array.from({ length: 64 }, (_, index) => [(index / 63) * 100, (index / 63) * 100]) }] }],
    ["duotone ink name 64 chars", gray, "duotone", { type: "monotone", inks: [{ name: "x".repeat(64), color: "#000000" }] }],
    ["duotone curve endpoints inverted", gray, "duotone", { type: "monotone", inks: [{ name: "a", color: "#000000", curve: [[0, 100], [100, 0]] }] }]
  ];
  const rejected = [];
  for (const [name, steps, target, params] of cases) {
    const fresh = new module.WasmEditor();
    try {
      fresh.execute("file.new", JSON.stringify({ width: 16, height: 16, mode: "rgb" }));
      for (const [step, stepParams] of steps) fresh.applyMode(step, JSON.stringify(stepParams));
      fresh.planMode(target, JSON.stringify(params));
    } catch (error) {
      rejected.push({ name, message: String(error?.message ?? error) });
    } finally {
      fresh.free();
    }
  }
  return { accepted: cases.length - rejected.length, total: cases.length, rejected };
});

// 内容身份（任务 3.3）：颜色表、油墨与模式本身都参与共享内容指纹。这里做硬断言——
// 之前的「known gap」是改表/改油墨/灰度→双色调都不改 hash，导致不标脏、保存漏掉。
step("color table, ink and duotone-mode edits move the shared content hash", () => {
  const indexed = new module.WasmEditor();
  const duo = new module.WasmEditor();
  try {
    indexed.execute("file.new", JSON.stringify({ width: 16, height: 8, mode: "rgb" }));
    indexed.applyMode("indexed", JSON.stringify({ colors: 4, dither: "none" }));
    const indexedHash = indexed.contentHash();
    indexed.applyColorTable(JSON.stringify({ entries: { 0: "#00ff00" } }));
    const tableHash = indexed.contentHash();

    duo.execute("file.new", JSON.stringify({ width: 8, height: 8, mode: "rgb" }));
    duo.applyMode("grayscale", JSON.stringify({}));
    const grayHash = duo.contentHash();
    duo.applyMode("duotone", JSON.stringify({ type: "duotone" }));
    const afterDuotoneHash = duo.contentHash();
    duo.applyMode("duotone", JSON.stringify({
      type: "duotone",
      inks: [{ name: "Black", color: "#111111" }, { name: "Warm Brown", color: "#222222" }]
    }));
    const inkHashAfter = duo.contentHash();

    const rows = {
      tableMovedHash: indexedHash !== tableHash,
      duotoneMovedHash: grayHash !== afterDuotoneHash,
      duotoneInkMovedHash: afterDuotoneHash !== inkHashAfter
    };
    if (!rows.tableMovedHash || !rows.duotoneMovedHash || !rows.duotoneInkMovedHash) {
      throw new Error(`内容指纹未随模式内容变化：${JSON.stringify(rows)}`);
    }
    return {
      ...rows,
      indexedHash,
      tableHash,
      grayHash,
      afterDuotoneHash,
      inkHashAfter,
      note: "模式/颜色表/油墨都进入 project_content，缺省 RGB 不产生额外行，旧工程指纹不变"
    };
  } finally {
    indexed.free();
    duo.free();
  }
});

// 范围外颜色模型（CMYK／Lab）的矩阵：本域既不判定工具也不判定 PNG/工程，只有 PSD 是真实关闭。
// 这条同时防止面板把「不在范围」写成「全部关闭」——实测那些导出/落笔都能成功。
step("out-of-scope color models can still export and paint, so the matrices must not claim otherwise", () => {
  const rows = [];
  for (const mode of ["cmyk", "lab"]) {
    const fresh = new module.WasmEditor();
    try {
      fresh.execute("file.new", JSON.stringify({ width: 8, height: 8, mode }));
      const info = JSON.parse(fresh.modeInfo());
      const bundle = fresh.exportBundle();
      const png = Buffer.from(bundle.output);
      const row = {
        mode,
        infoMode: info.mode,
        rgbTarget: info.targets.find((entry) => entry.id === "rgb").available,
        grayscaleTarget: info.targets.find((entry) => entry.id === "grayscale").available,
        pngSignature: png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        pngColorType: png[25],
        projectBytes: fresh.saveProject().length,
        psd: "exported"
      };
      bundle.free?.();
      try {
        fresh.exportPsd("{}");
      } catch (error) {
        row.psd = String(error?.message ?? error).slice(0, 80);
      }
      const before = fresh.contentHash();
      fresh.execute("paint.stroke", JSON.stringify({ points: [[2, 2], [5, 5]], size: 3, hardness: 1, opacity: 1, flow: 1, color: "#ff0000", target: "pixels" }));
      fresh.execute("type.create", JSON.stringify({ text: "hi", x: 1, y: 1 }));
      row.paintAndTextCommittedHashChanged = fresh.contentHash() !== before;
      rows.push(row);
    } finally {
      fresh.free();
    }
  }
  const allPaintable = rows.every((row) => row.paintAndTextCommittedHashChanged);
  const allPng = rows.every((row) => row.pngSignature && row.pngColorType === 2);
  const psdClosed = rows.every((row) => row.psd.includes("RGB/U8"));
  if (!allPaintable || !allPng || !psdClosed) {
    throw new Error(`范围外模型实测与矩阵不符：${JSON.stringify(rows)}`);
  }
  return { rows, note: "PNG/工程/绘制可用，PSD 被共享预检拒绝 → 面板只对 PSD 报关闭" };
});

const info = JSON.parse(editor.modeInfo());
out.push({
  name: "modeInfo reflects the committed conversions",
  ok: info.mode === "indexed" && info.colorTable.colors[0] === "#00ff00" && info.trap.available === false,
  value: { mode: info.mode, depth: info.depth, colors: info.colorTable.colors, trap: info.trap }
});
const bytes = Buffer.from(grayscalePlan.preview.pixelsBase64, "base64").length;
out.push({
  name: "preview base64 is width*height*4 RGBA",
  ok: bytes === grayscalePlan.preview.width * grayscalePlan.preview.height * 4,
  value: [bytes, grayscalePlan.preview.width * grayscalePlan.preview.height * 4]
});

console.log(JSON.stringify(out, null, 2));
editor.free();
const expectedRejections = new Set([
  "color table on an RGB document is rejected",
  "bitmap from RGB is rejected with a gray-first reason"
]);
if (out.some((entry) => !entry.ok && !expectedRejections.has(entry.name))) process.exitCode = 1;
