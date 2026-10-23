/**
 * 面板命令覆盖：UI 面板实际会发出的**每一条**命令 id，在真实内核上都必须能执行。
 *
 * 这条用例防的是最容易漏的一类缺口：命令登记了、面板也写了按钮，但参数形状或
 * 命令归属对不上，用户一点就报错。参数取面板 `build*` 编译出的同形状。
 */
import { createReport, loadKernel, newSession } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("面板命令覆盖");

const session = newSession(mod, { width: 64, height: 48 });
const base = session.contentHash();

// 面板 `run()` / 通道实际会发出的命令与参数形状。
const cases = [
  ["paint.pencil", {
    points: [[6, 6], [20, 6]], size: 4, color: "#112233", autoErase: false, mode: "normal", zoom: 1,
    brush: { hardness: 1, spacing: 0.05, smoothing: { enabled: false, amount: 0 }, flow: 1, opacity: 1 },
    target: "pixels",
  }],
  ["paint.colorReplacement", {
    points: [[6, 12], [40, 12]], size: 8, color: "#ff0000", mode: "color",
    tolerance: 30, sampling: "continuous", limits: "contiguous", antiAlias: true, target: "pixels",
  }],
  ["paint.bucket", {
    x: 30, y: 30, color: "#00ff00", tolerance: 32, contiguous: true,
    antiAlias: true, sampleAllLayers: false, opacity: 100, target: "pixels",
  }],
  ["paint.gradient", {
    from: [0, 40], to: [63, 40], style: "linear", stops: [[0, "#000000"], [1, "#ffffff"]],
    reverse: false, opacity: 100, dither: true, mode: "normal", target: "pixels",
  }],
  ["paint.magicEraser", {
    x: 50, y: 8, tolerance: 32, contiguous: true, antiAlias: true,
    sampleAllLayers: false, opacity: 100, target: "pixels",
  }],
  ["paint.backgroundEraser", {
    points: [[12, 20], [30, 20]], size: 10, hardness: 1, sampling: "continuous",
    limits: "contiguous", tolerance: 50, protectForegroundColor: false, target: "pixels",
  }],
  ["paint.setSymmetry", { mode: "vertical", center: [32, 24], rotation: 0 }],
  ["paint.symmetryDisable", {}],
  ["swatches.list", {}],
  ["swatches.add", { color: "#123456", name: "panel-swatch", group: "MyGroup" }],
  ["swatches.newGroup", { name: "PanelGroup" }],
  ["swatches.renameGroup", { group: "PanelGroup", name: "PanelGroup2" }],
  ["swatches.use", { swatch: "panel-swatch", target: "foreground" }],
  ["swatches.export", { format: "aco" }],
  ["swatches.delete", { swatch: "panel-swatch", group: "MyGroup" }],
  ["swatches.deleteGroup", { group: "MyGroup", keepSwatches: true }],
  ["swatches.reset", { append: false }],
  ["gradient.presets.list", {}],
  ["tool.presets.list", {}],
];

for (const [id, params] of cases) {
  let detail;
  try {
    session.paintingCommand(id, JSON.stringify(params));
    report.ok(id, true);
  } catch (error) {
    detail = String(error).slice(0, 200);
    report.ok(id, false, detail);
  }
}
report.ok("像素命令确实改变了文档", session.contentHash() !== base);

// 路径对称必须先有工作路径：空文档拒绝是正确行为，不是接线错误。
{
  let rejectedWithoutPath = false;
  try {
    session.paintingCommand("paint.symmetryFromPath", JSON.stringify({ name: "work" }));
  } catch {
    rejectedWithoutPath = true;
  }
  report.ok("无工作路径时 paint.symmetryFromPath 被拒绝（正确拒绝）", rejectedWithoutPath);

  session.execute("path.set", JSON.stringify({
    name: "work", path: { subpaths: [{ closed: false, knots: [[32, 0], [32, 48]] }] },
  }));
  let accepted = true;
  let detail;
  try {
    session.paintingCommand("paint.symmetryFromPath", JSON.stringify({ name: "work" }));
  } catch (error) {
    accepted = false;
    detail = String(error).slice(0, 160);
  }
  report.ok("有工作路径时 paint.symmetryFromPath 成功", accepted, detail);
  session.paintingCommand("paint.symmetryDisable", "{}");
}

// 色板导入：用自己导出的 ACO 回灌，形状与面板一致。
{
  const exported = JSON.parse(session.paintingCommand("swatches.export", JSON.stringify({ format: "aco" })));
  let imported = true;
  let detail;
  try {
    session.paintingCommand("swatches.import", JSON.stringify({ data: exported.data, mode: "append" }));
  } catch (error) {
    imported = false;
    detail = String(error).slice(0, 160);
  }
  report.ok("swatches.import（用导出的 ACO 回灌）", imported, detail);
}

// 工具预设：面板的保存 → 选择 → 改名 → 删除全链路。
{
  let ok = true;
  let detail;
  try {
    session.paintingCommand("tool.presets.list", "{}");
    session.saveToolPreset(JSON.stringify({ name: "panel-preset", tool: "pencil" }));
    session.selectToolPreset("panel-preset");
    session.paintingCommand("tool.presets.edit", JSON.stringify({ action: "rename", preset: "panel-preset", name: "panel-preset2" }));
    session.paintingCommand("tool.presets.edit", JSON.stringify({ action: "delete", preset: "panel-preset2" }));
  } catch (error) {
    ok = false;
    detail = String(error).slice(0, 200);
  }
  report.ok("工具预设保存/选择/改名/删除", ok, detail);
}

session.free();
report.finish();
