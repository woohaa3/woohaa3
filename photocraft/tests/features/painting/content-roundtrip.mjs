/**
 * 内容往返与「偏好/内容分开」：本 change 的每个像素命令各落一次，存盘重开逐点一致；
 * 偏好命令不推进修订、不改变内容指纹、不进入工程字节。
 *
 * 对应 tasks 3.2 的「逐持久字段同步内容身份、旧工程兼容…偏好/查看与内容分开」。
 */
import fs from "node:fs";
import path from "node:path";
import { createReport, loadKernel, outputDir } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("内容往返 / 偏好分开");

const W = 96;
const H = 64;
const session = new mod.WasmEditor();
session.execute("file.new", JSON.stringify({ width: W, height: H, background: "#808080" }));

/** 逐像素导出成可比较串（含 null，透明与图外都算）。 */
const grid = (editor) => {
  const out = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      out.push(editor.sampleColorOptions(JSON.stringify({ x, y, size: "point", sampleLayer: "all" })));
    }
  }
  return out.join("|");
};

// 每个像素命令各落一次，参数取各自真实形态（不是最小占位）。
const paints = [
  ["paint.pencil", { points: [[8, 8], [30, 8]], size: 5, color: "#ff0000", mode: "normal" }],
  ["paint.colorReplacement", {
    points: [[8, 20], [30, 20]], size: 8, color: "#00ff00", mode: "color",
    tolerance: 40, sampling: "continuous", limits: "contiguous", antiAlias: true,
  }],
  ["paint.bucket", { x: 60, y: 10, color: "#0000ff", tolerance: 30, contiguous: true, antiAlias: true }],
  ["paint.gradient", {
    from: [40, 30], to: [90, 60], stops: [[0, "#ff00ff"], [1, "#00ffff"]],
    style: "linear", opacity: 0.8, dither: true, reverse: false, method: "perceptual",
  }],
  ["paint.magicEraser", { x: 46, y: 46, tolerance: 30, contiguous: true, antiAlias: true }],
  ["paint.backgroundEraser", {
    points: [[70, 40], [88, 52]], size: 10, hardness: 0.5, sampling: "continuous",
    limits: "contiguous", tolerance: 25, protectForegroundColor: false,
  }],
  // 高级动态一笔：纹理 + 颜色动态 + 双轴散布 + 数量抖动 + 圆度角度动态。
  ["paint.stroke", {
    points: [[12, 48, 0.6], [34, 56, 0.9]], size: 14, color: "#123456", seed: 11,
    brush: {
      roundness: 0.5,
      shapeDynamics: {
        enabled: true,
        size: { jitter: 0.4, control: "penPressure", minimum: 0.2 },
        angle: { jitter: 0.6, control: "direction", minimum: 0 },
        roundness: { jitter: 0.3, control: "penTilt", minimum: 0.2 },
      },
      scattering: {
        enabled: true,
        scatter: { jitter: 1.5, control: "off", minimum: 0 },
        bothAxes: true, count: 4,
        countJitter: { jitter: 0.5, control: "off", minimum: 0 },
      },
      texture: {
        enabled: true,
        pattern: { procedural: { style: "canvas", size: 128, seed: 5 } },
        invert: false, scale: 1, mode: "multiply", depth: 0.6,
      },
      colorDynamics: {
        enabled: true, perTip: false,
        fgBg: { jitter: 0.5, control: "fade", minimum: 0 },
        hueJitter: 0.3, saturationJitter: 0.2, brightnessJitter: 0.2, purity: 0.1,
      },
    },
  }],
];

// 对称属于会话状态，必须不进内容。
session.execute("paint.setSymmetry", JSON.stringify({ mode: "vertical", center: [48, 32], rotation: 0 }));
for (const [id, params] of paints) session.execute(id, JSON.stringify(params));

const painted = { hash: session.contentHash(), grid: grid(session), revision: session.revision };
const bytes = session.saveProject();
const projectPath = path.join(outputDir, "painted-project.pcraft");
fs.writeFileSync(projectPath, Buffer.from(bytes));
report.ok("工程往返：saveProject 产出非空字节", bytes instanceof Uint8Array && bytes.length > 0, {
  bytes: bytes.length, path: projectPath,
});
// 交给原生核验器复核同一份字节：`photocraft-project-verify <这个路径>`。
// 产物在系统临时目录，路径每次运行都不同，所以打印出来方便复制。
console.log(`project-path: ${projectPath}`);

// ---- 重开一致 ----------------------------------------------------------
const reopened = new mod.WasmEditor();
reopened.openProject(bytes, "");
report.ok("工程往返：重开的内容指纹与保存前一致", reopened.contentHash() === painted.hash, {
  before: painted.hash.slice(0, 10), after: reopened.contentHash().slice(0, 10),
});
report.ok("工程往返：重开逐像素一致", grid(reopened) === painted.grid, { width: W, height: H });
report.ok("工程往返：重开修订号一致", reopened.revision === painted.revision, {
  before: painted.revision, after: reopened.revision,
});

// 二次保存字节稳定：没有随机/时间字段被写进工程。
const bytes2 = reopened.saveProject();
report.ok("工程往返：二次保存字节稳定", Buffer.compare(Buffer.from(bytes), Buffer.from(bytes2)) === 0, {
  first: bytes.length, second: bytes2.length,
});

// 重开的工程还能继续画，并一步撤销回到重开时的内容。
const reopenedHash = reopened.contentHash();
reopened.execute("paint.stroke", JSON.stringify({ points: [[20, 30], [40, 40]], size: 9, color: "#abcdef" }));
const afterMore = reopened.contentHash();
reopened.execute("edit.undo", "{}");
report.ok("工程往返：重开后仍能落笔并撤销回原内容", afterMore !== reopenedHash && reopened.contentHash() === reopenedHash);

// ---- 偏好不进内容 ------------------------------------------------------
// 走域会话入口 `paintingCommand`：`tool.reset` 是本域原生实现，本来就不在内核 execute 白名单里。
const preferences = [
  ["swatches.add", { name: "往返色", color: "#336699" }],
  ["swatches.list", {}],
  ["swatches.rename", { swatch: "往返色", name: "往返色2" }],
  ["swatches.export", { format: "aco" }],
  ["swatches.use", { swatch: "往返色2", target: "foreground" }],
  ["gradient.presets.list", {}],
  ["gradient.presets.select", { preset: "Black, White", applyToLayer: false }],
  ["brush.presets.list", {}],
  ["brush.presets.save", { name: "往返笔刷", group: "往返组" }],
  ["brush.presets.move", { name: "往返笔刷", group: "另一个组" }],
  ["tool.presets.list", {}],
  ["tool.presets.select", { preset: "往返工具预设" }],
  ["tool.reset", { tool: "brush" }],
  ["tool.resetAll", {}],
  ["paint.setSymmetry", { mode: "dual", center: [48, 32], rotation: 15 }],
  ["paint.symmetryDisable", {}],
];
// 先建一条工具预设，供 select 使用。
reopened.saveToolPreset(JSON.stringify({ name: "往返工具预设", tool: "brush" }));

const drift = [];
for (const [id, params] of preferences) {
  const beforeHash = reopened.contentHash();
  const beforeRevision = reopened.revision;
  try {
    reopened.paintingCommand(id, JSON.stringify(params));
  } catch (error) {
    drift.push(`${id}: ${String(error).slice(0, 90)}`);
  }
  if (reopened.contentHash() !== beforeHash || reopened.revision !== beforeRevision) {
    drift.push(`${id} 改变了内容/修订`);
  }
}
report.ok("偏好命令全部被接受且不改内容指纹与修订", drift.length === 0, drift.length ? drift : undefined);

// 偏好状态不进工程字节。
const bytesAfterPreferences = reopened.saveProject();
report.ok("偏好不进工程字节", Buffer.compare(Buffer.from(bytes2), Buffer.from(bytesAfterPreferences)) === 0, {
  before: bytes2.length, after: bytesAfterPreferences.length,
});

// ---- 旧工程兼容 --------------------------------------------------------
// 用新内核开一个「只有基础图层」的旧形态工程字节，内容身份必须原样保留，且新命令可用。
{
  const legacy = new mod.WasmEditor();
  legacy.execute("file.new", JSON.stringify({ width: 40, height: 30, background: "#ffffff" }));
  legacy.execute("paint.stroke", JSON.stringify({ points: [[5, 5], [30, 20]], size: 6, color: "#000000" }));
  const oldBytes = legacy.saveProject();
  const oldHash = legacy.contentHash();
  const oldRevision = legacy.revision;
  legacy.free();

  const restored = new mod.WasmEditor();
  restored.openProject(oldBytes, "");
  report.ok("旧工程重开后内容指纹与修订号不变",
    restored.contentHash() === oldHash && restored.revision === oldRevision, { revision: restored.revision });

  restored.execute("paint.bucket", JSON.stringify({ x: 2, y: 2, color: "#00ff00", tolerance: 20, contiguous: true }));
  const afterBucket = restored.contentHash();
  restored.execute("edit.undo", "{}");
  report.ok("旧工程可用新命令绘画并一步撤销", afterBucket !== oldHash && restored.contentHash() === oldHash);

  restored.paintingCommand("swatches.add", JSON.stringify({ name: "旧工程色", color: "#123456" }));
  report.ok("旧工程可用新偏好命令且不改内容", restored.contentHash() === oldHash);

  const third = new mod.WasmEditor();
  third.openProject(restored.saveProject(), "");
  report.ok("旧工程经新命令后再保存仍可重开且内容一致", third.contentHash() === oldHash, {
    hash: third.contentHash().slice(0, 10),
  });
  restored.free();
  third.free();
}

session.free();
reopened.free();
report.finish();
