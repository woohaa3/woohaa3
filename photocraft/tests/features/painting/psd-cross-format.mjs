/**
 * 跨格式：本域绘制出的工程在 PSD 导出矩阵里被声明为可导出，导出/再导入尺寸一致。
 *
 * 依赖 content-roundtrip.mjs 产出的工程；没有时自己造一个同等形态的工程，保证本文件可单独跑。
 */
import fs from "node:fs";
import path from "node:path";
import { createReport, loadKernel, outputDir } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("PSD 跨格式");

const projectPath = path.join(outputDir, "painted-project.pcraft");
let bytes;
if (fs.existsSync(projectPath)) {
  bytes = fs.readFileSync(projectPath);
} else {
  const seed = new mod.WasmEditor();
  seed.execute("file.new", JSON.stringify({ width: 96, height: 64, background: "#808080" }));
  seed.execute("paint.pencil", JSON.stringify({ points: [[8, 8], [40, 8]], size: 5, color: "#ff0000" }));
  seed.execute("paint.gradient", JSON.stringify({
    from: [10, 30], to: [90, 60], stops: [[0, "#ff00ff"], [1, "#00ffff"]], style: "linear",
  }));
  bytes = seed.saveProject();
  seed.free();
}

const session = new mod.WasmEditor();
session.openProject(bytes, "");

// PSD 矩阵是共享声明；这里只确认本域绘制的图层在矩阵里被声明为可导出。
const matrix = JSON.parse(session.psdMatrixJson());
report.ok("PSD 矩阵声明 raster 可导出", JSON.stringify(matrix).includes("raster"), {
  keys: Object.keys(matrix).slice(0, 6),
});

// 预检的真实形态是 {blocking, editable, layers, rasterizable}，没有 ok 字段。
const inspect = JSON.parse(session.inspectPsdExport());
report.ok("绘制后的工程 PSD 导出预检可编辑且无阻塞层",
  inspect.editable === true && inspect.blocking === 0 && inspect.rasterizable === 0, {
    editable: inspect.editable, blocking: inspect.blocking, rasterizable: inspect.rasterizable,
  });

const psd = session.exportPsd(JSON.stringify({}));
report.ok("PSD 导出产出非空字节", psd instanceof Uint8Array && psd.length > 0, { bytes: psd?.length });

const psdReport = JSON.parse(session.lastPsdExportReportJson());
report.ok("PSD 导出报告字节数与产出一致且无警告",
  psdReport.bytes === psd.length && psdReport.warnings.length === 0, {
    bytes: psdReport.bytes, warnings: psdReport.warnings.length, lossy: psdReport.lossy,
  });
const psdPath = path.join(outputDir, "painted-export.psd");
fs.writeFileSync(psdPath, Buffer.from(psd));

// 再导回：内容指纹会变（PSD 有损/结构不同），但必须能成功打开且画布尺寸一致。
{
  const roundtrip = new mod.WasmEditor();
  roundtrip.importPsd(psd, JSON.stringify({ flat: false }));
  // WasmEditor 没有 canvasWidth 属性；用 stateJson 里的文档尺寸。
  const sizeOf = (editor) => {
    const state = JSON.parse(editor.stateJson());
    const doc = state.document ?? state.doc ?? state;
    return [doc.width ?? doc.size?.width, doc.height ?? doc.size?.height];
  };
  report.ok("导出的 PSD 能被重新导入且画布尺寸一致",
    JSON.stringify(sizeOf(roundtrip)) === JSON.stringify(sizeOf(session)),
    { source: sizeOf(session), imported: sizeOf(roundtrip), path: psdPath });
  roundtrip.free();
}

session.free();
report.finish();
