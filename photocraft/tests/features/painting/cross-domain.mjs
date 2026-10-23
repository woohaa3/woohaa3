/**
 * 跨域回归：绘画 × 选区 × 图层（混合/不透明度/蒙版/分组）× 历史 × 保存/身份/PSD/原生核验。
 *
 * 对应 tasks 5.2「满足同级依赖后执行跨域 UI/像素/身份/保存/核验回归」。这里验证的是**真实内核**
 * 上的域间一致性：绘画不是孤立地改像素，它必须
 *   - 受选区约束（选区由 selections 域产生，本域只消费）；
 *   - 反映在图层合成上（混合/不透明度/蒙版/分组归 layers，像素归本域）；
 *   - 与历史边界一致（一笔 = 一步撤销，蒙版笔迹只动蒙版）；
 *   - 经保存/重开/原生核验/PSD 往返后内容身份不变或按声明可解释。
 *
 * 采样语义（写清楚，避免误读断言）：`sampleLayer: "current"` 是**当前图层按自身蒙版合成后**的
 * 像素，因此蒙版遮住的点会返回 null；`sampleLayer: "all"` 是整幅合成。要证明「蒙版笔迹没有
 * 删除图层像素」，用撤销后同一坐标的合成值回到笔迹前值来判定。
 *
 * 不做 UI 断言：工具轨、画布手势与宿主壳的跨域交互需要真实 GPU 会话与宿主环境，
 * 见 change 的 verification.md「待人工验证」。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { workspaceRoot, createReport, loadKernel, outputDir } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("跨域：绘画 × 选区 × 图层 × 历史 × 保存/核验");

const W = 96;
const H = 64;

/** 从真实内核读状态（不读 DOM、不用替身）。 */
const documentOf = (session) => JSON.parse(session.stateJson()).document;
const run = (session, id, params) => {
  const raw = session.execute(id, JSON.stringify(params ?? null));
  return raw === undefined ? null : raw;
};
const hexAt = (session, x, y, sampleLayer = "current") => {
  const raw = session.sampleColorOptions(JSON.stringify({ x, y, size: "point", sampleLayer }));
  const decoded = JSON.parse(raw);
  return decoded === null ? null : decoded.hex;
};
const compositeAt = (session, x, y) => hexAt(session, x, y, "all");
const layerById = (session, id) => documentOf(session).layers.find((layer) => layer.id === id);
/** 组的子层在 `children` 里，扁平查名字会漏；递归展开成 [{name, kind}] 便于断言结构。 */
const flattenLayers = (layers) => layers.flatMap((layer) => [
  { name: layer.name, kind: layer.kind },
  ...flattenLayers(layer.children ?? []),
]);

const session = new mod.WasmEditor();
run(session, "file.new", { width: W, height: H, background: "#ffffff" });

// ---- 背景层：绘画命令在已有内容上工作 ------------------------------------
run(session, "paint.bucket", { x: 4, y: 4, color: "#3366cc", tolerance: 5, contiguous: true });
report.ok("背景层被油漆桶真实填充", compositeAt(session, 4, 4) === "#3366cc", { pixel: compositeAt(session, 4, 4) });

// ---- 新建绘画层 + 选区约束 ----------------------------------------------
run(session, "layer.new.layer", { name: "绘画层" });
const paintLayer = documentOf(session).layers.find((layer) => layer.name === "绘画层").id;
run(session, "select.rect", { x: 10, y: 10, width: 30, height: 20, mode: "replace" });
report.ok("选区由 selections 域建立，绘画域只消费（不改选区实现）",
  documentOf(session).hasSelection === true, { hasSelection: documentOf(session).hasSelection });

run(session, "paint.gradient", {
  from: [10, 10], to: [39, 10], stops: [[0, "#ff0000"], [1, "#ffff00"]], style: "linear",
});
const insideSelection = hexAt(session, 20, 20);
const outsideSelection = hexAt(session, 60, 40);
report.ok("渐变被选区裁剪：选区内落在绘画层，选区外仍是背景层像素",
  insideSelection === "#ff5c00" && outsideSelection === null && compositeAt(session, 60, 40) === "#3366cc",
  { inside: insideSelection, outside: outsideSelection, background: compositeAt(session, 60, 40) });

run(session, "select.deselect", null);
report.ok("取消选区不改变已提交像素", compositeAt(session, 20, 20) === "#ff5c00");

// ---- 图层面板属性：混合/不透明度只改合成，不改绘画层像素 ----------------
const paintedBase = hexAt(session, 20, 20);
run(session, "layer.setProps", { layer: paintLayer, blend: "Multiply" });
const multiply = compositeAt(session, 20, 20);
report.ok("混合模式作用在合成结果上，绘画层自身像素不变",
  multiply !== "#ff5c00" && hexAt(session, 20, 20) === paintedBase,
  { multiply, layerPixel: hexAt(session, 20, 20) });

run(session, "layer.setProps", { layer: paintLayer, opacity: 0.25 });
const faded = compositeAt(session, 20, 20);
report.ok("不透明度同样只影响合成", faded !== multiply && hexAt(session, 20, 20) === paintedBase, {
  faded, layerPixel: hexAt(session, 20, 20),
});

run(session, "layer.setProps", { layer: paintLayer, opacity: 1, blend: "Normal" });
report.ok("属性恢复后合成回到原值", compositeAt(session, 20, 20) === "#ff5c00", {
  restored: compositeAt(session, 20, 20),
});

// ---- 图层蒙版：蒙版上的绘画隐藏合成像素，撤销回到笔迹前 ----------------
run(session, "layer.layerMask.revealAll", {});
report.ok("建立蒙版后编辑目标切到蒙版",
  documentOf(session).editTarget === "mask" && layerById(session, paintLayer)?.hasMask === true,
  { editTarget: documentOf(session).editTarget });

const maskedPoint = [16, 22];
const beforeMaskStroke = compositeAt(session, ...maskedPoint);
const revisionBeforeMask = documentOf(session).revision;
run(session, "paint.pencil", { points: [[16, 16], [16, 30]], size: 8, color: "#000000" });
const maskedComposite = compositeAt(session, ...maskedPoint);
report.ok("蒙版上的绘画把合成像素还原成下层（蒙版被真实写入）",
  maskedComposite === "#3366cc" && maskedComposite !== beforeMaskStroke,
  { before: beforeMaskStroke, masked: maskedComposite });

run(session, "edit.undo", null);
report.ok("蒙版笔迹一步撤销：同一坐标的合成像素回到笔迹前值（图层像素未被删除）",
  compositeAt(session, ...maskedPoint) === beforeMaskStroke
    && documentOf(session).revision === revisionBeforeMask + 2,
  { composite: compositeAt(session, ...maskedPoint), revision: documentOf(session).revision });

// 切回合成目标后继续绘画，确认蒙版编辑不会把后续绘画错误地写到蒙版上。
run(session, "channel.target.composite", null);
const targetAfterChannel = documentOf(session).editTarget;
run(session, "paint.pencil", { points: [[60, 20], [70, 20]], size: 6, color: "#00ff00" });
report.ok("切回合成目标后像素绘画写到图层而非蒙版",
  targetAfterChannel === "pixels"
    && hexAt(session, 65, 20) === "#00ff00" && compositeAt(session, 65, 20) === "#00ff00",
  { editTarget: targetAfterChannel, layerPixel: hexAt(session, 65, 20), composite: compositeAt(session, 65, 20) });

// ---- 对称：一笔两个镜像，一次撤销同时移除 --------------------------------
run(session, "paint.setSymmetry", { mode: "vertical", center: [W / 2, H / 2], rotation: 0 });
const baseHash = session.contentHash();
run(session, "paint.stroke", { points: [[20, 40], [26, 46]], size: 5, color: "#00ff00" });
const original = hexAt(session, 23, 43);
const mirror = hexAt(session, 73, 43);
run(session, "edit.undo", null);
report.ok("对称笔迹与镜像同一历史事务，一次撤销同时移除",
  original === "#00ff00" && mirror === "#00ff00"
    && hexAt(session, 23, 43) === null && hexAt(session, 73, 43) === null
    && session.contentHash() === baseHash,
  { original, mirror, hashRestored: session.contentHash() === baseHash });
run(session, "paint.symmetryDisable", null);

// ---- 分组：绘画层进入组后，组不透明度影响合成 ----------------------------
run(session, "layer.select", { layer: paintLayer });
run(session, "layer.groupLayers", { name: "绘画组" });
const group = documentOf(session).layers.find((layer) => layer.name === "绘画组").id;
const groupComposite = compositeAt(session, 20, 20);
report.ok("绘画层可被分组，组不透明度影响组内绘画的合成",
  documentOf(session).layers.some((layer) => layer.kind === "Group" && layer.id === group)
    && groupComposite === "#ff5c00",
  { group, composite: groupComposite });
run(session, "layer.setProps", { layer: group, opacity: 0.5 });
const fadedGroup = compositeAt(session, 20, 20);
report.ok("组不透明度真实作用在组内绘画层上且不改图层像素",
  fadedGroup !== groupComposite && hexAt(session, 20, 20) === paintedBase,
  { groupComposite, fadedGroup, layerPixel: hexAt(session, 20, 20) });
run(session, "layer.setProps", { layer: group, opacity: 1 });
report.ok("组不透明度恢复后合成回到原值", compositeAt(session, 20, 20) === groupComposite);

// ---- 保存 / 身份 / 原生核验 ---------------------------------------------
const savedHash = session.contentHash();
const revision = documentOf(session).revision;
const bytes = session.saveProject();
const projectPath = path.join(outputDir, "cross-domain.pcraft");
fs.writeFileSync(projectPath, Buffer.from(bytes));
report.ok("跨域编辑后的工程可保存为真实字节", bytes instanceof Uint8Array && bytes.length > 0, {
  bytes: bytes.length, path: projectPath,
});

const reopened = new mod.WasmEditor();
reopened.openProject(bytes, "");
report.ok("重开的内容指纹与保存前一致", reopened.contentHash() === savedHash, {
  before: savedHash.slice(0, 10), after: reopened.contentHash().slice(0, 10),
});
report.ok("重开后合成像素与图层结构一致",
  compositeAt(reopened, 20, 20) === compositeAt(session, 20, 20)
    && compositeAt(reopened, 60, 40) === compositeAt(session, 60, 40)
    && flattenLayers(documentOf(reopened).layers).some((layer) => layer.name === "绘画层"),
  {
    inside: compositeAt(reopened, 20, 20),
    outside: compositeAt(reopened, 60, 40),
    layers: flattenLayers(documentOf(reopened).layers).map((layer) => layer.name),
  });
report.ok("重开后的修订号来自工程而不是上一次会话", documentOf(reopened).revision !== revision, {
  saved: revision, reopened: documentOf(reopened).revision,
});

const verifier = path.join(workspaceRoot, "packages/project-verifier/dist/bin/photocraft-project-verify");
if (fs.existsSync(verifier)) {
  const verified = spawnSync(verifier, [projectPath], { encoding: "utf8" });
  let summary = null;
  try {
    summary = JSON.parse(verified.stdout);
  } catch {
    summary = null;
  }
  report.ok("原生核验器接受跨域编辑产出的工程",
    verified.status === 0 && summary?.ok === true,
    {
      status: verified.status,
      layerCount: summary?.summary?.layerCount,
      upstreamCommit: summary?.summary?.upstreamCommit?.slice(0, 8),
    });
} else {
  report.ok("原生核验器存在", false, { path: verifier });
}

// ---- PSD 往返：矩阵声明 → 导出 → 再导入尺寸一致 --------------------------
const inspect = JSON.parse(session.inspectPsdExport());
report.ok("跨域编辑后的工程在 PSD 矩阵里仍声明可编辑", inspect.editable === true && inspect.blocking === 0, {
  editable: inspect.editable, blocking: inspect.blocking, rasterizable: inspect.rasterizable,
});
const psd = session.exportPsd(JSON.stringify({}));
const psdReport = JSON.parse(session.lastPsdExportReportJson());
report.ok("PSD 导出成功且报告与字节一致",
  psd instanceof Uint8Array && psd.length > 0 && psdReport.bytes === psd.length, {
    bytes: psd?.length, warnings: psdReport.warnings.length,
  });

const imported = new mod.WasmEditor();
imported.importPsd(psd, JSON.stringify({ flat: false }));
const sizeOf = (editor) => {
  const doc = documentOf(editor);
  return [doc.width, doc.height];
};
report.ok("导出的 PSD 重新导入后画布尺寸一致",
  JSON.stringify(sizeOf(imported)) === JSON.stringify(sizeOf(session)), {
    source: sizeOf(session), imported: sizeOf(imported),
  });

// ---- 历史一致性：撤销到底再全部重做 ------------------------------------
const undoSteps = [];
while (documentOf(session).canUndo && undoSteps.length < 200) {
  run(session, "edit.undo", null);
  undoSteps.push(documentOf(session).revision);
}
report.ok("跨域链可逐步撤销到空历史", documentOf(session).canUndo === false && undoSteps.length > 0, {
  steps: undoSteps.length,
});
while (documentOf(session).canRedo) run(session, "edit.redo", null);
report.ok("全部重做后回到撤销前的内容指纹", session.contentHash() === savedHash, {
  hash: session.contentHash().slice(0, 10),
});

const psdPath = path.join(outputDir, "cross-domain.psd");
fs.writeFileSync(psdPath, Buffer.from(psd));
console.log(`artifacts: ${projectPath} ${psdPath}`);

session.free();
reopened.free();
imported.free();
report.finish();
