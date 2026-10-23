/**
 * U36 工具预设与重置：保存/选择，当前工具与全部工具恢复默认，重置只改声明的偏好。
 *
 * 判据来自 spec：切换工具恢复各自参数；重置不产生文档 dirty，也不删除文档与工作区。
 */
import { createReport, loadKernel, newSession } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U36 工具预设 / 重置");

// ---- 保存 → 改动 → 套用 -------------------------------------------------
{
  const session = newSession(mod, { width: 32, height: 24 });
  const base = session.contentHash();
  session.execute("tools.setBrush", JSON.stringify({ brush: { size: 33, hardness: 0.3 } }));
  const saved = JSON.parse(session.saveToolPreset(JSON.stringify({ name: "证据预设", tool: "brush", includeColor: true })));
  // 故意改坏，确认套用真的恢复，而不是「本来就等于预设值」。
  session.execute("tools.setBrush", JSON.stringify({ brush: { size: 9, hardness: 1 } }));
  const applied = JSON.parse(session.selectToolPreset("证据预设"));
  report.ok("工具预设保存后可套用并恢复笔刷参数", saved.name === "证据预设" && applied.options?.brush?.size === 33
    && applied.tool === "brush", { restoredSize: applied.options?.brush?.size, tool: applied.tool });
  report.ok("预设套用不写文档", session.contentHash() === base);
  session.free();
}

// ---- 预设列表按工具过滤 -------------------------------------------------
{
  const session = newSession(mod, { width: 32, height: 24 });
  session.saveToolPreset(JSON.stringify({ name: "画笔预设", tool: "brush" }));
  session.saveToolPreset(JSON.stringify({ name: "铅笔预设", tool: "pencil" }));
  const listed = JSON.parse(session.toolPresetsJson(""));
  const onlyPencil = JSON.parse(session.toolPresetsJson("pencil"));
  report.ok("工具预设列表可按工具过滤", listed.presets.length >= 2
    && onlyPencil.presets.every((preset) => preset.tool === "pencil")
    && onlyPencil.presets.some((preset) => preset.name === "铅笔预设"),
    { total: listed.presets.length, pencil: onlyPencil.presets.length });
  report.ok("工具预设快照可往返恢复", (() => {
    const bytes = session.toolPresetSnapshot();
    session.editToolPreset(JSON.stringify({ action: "delete", preset: "铅笔预设" }));
    const afterDelete = JSON.parse(session.toolPresetsJson("")).presets.length;
    session.restoreToolPresets(bytes);
    const afterRestore = JSON.parse(session.toolPresetsJson("")).presets.length;
    return bytes.length > 0 && afterDelete === afterRestore - 1 && afterRestore === listed.presets.length;
  })());
  session.free();
}

// ---- 改名与删除 --------------------------------------------------------
{
  const session = newSession(mod, { width: 32, height: 24 });
  session.saveToolPreset(JSON.stringify({ name: "旧名预设", tool: "brush" }));
  const renamed = JSON.parse(session.editToolPreset(JSON.stringify({ action: "rename", preset: "旧名预设", name: "新名预设" })));
  const afterRename = JSON.parse(session.toolPresetsJson(""));
  const deleted = JSON.parse(session.editToolPreset(JSON.stringify({ action: "delete", preset: "新名预设" })));
  const afterDelete = JSON.parse(session.toolPresetsJson(""));
  report.ok("工具预设改名与删除生效",
    renamed.name === "新名预设" && afterRename.presets.some((preset) => preset.name === "新名预设")
    && deleted.deleted === "新名预设" && !afterDelete.presets.some((preset) => preset.name === "新名预设"),
    { renamed: renamed.name, deleted: deleted.deleted });
  session.free();
}

// ---- 单工具重置 / 全部重置 ---------------------------------------------
{
  const session = newSession(mod, { width: 32, height: 24 });
  const base = session.contentHash();
  const revision = session.revision;
  session.execute("tools.setBrush", JSON.stringify({ brush: { size: 77, hardness: 0.2 } }));
  const resetOne = JSON.parse(session.paintingCommand("tool.reset", JSON.stringify({ tool: "brush" })));
  const afterReset = JSON.parse(session.execute("brush.get", "{}"));
  const resetAll = JSON.parse(session.paintingCommand("tool.resetAll", "{}"));
  report.ok("单工具重置把笔刷参数恢复默认",
    resetOne.reset === "brush" && Array.isArray(resetOne.scope) && afterReset?.brush?.size !== 77,
    { reset: resetOne.reset, scope: resetOne.scope, sizeAfterReset: afterReset?.brush?.size });
  report.ok("全部重置声明覆盖笔刷/工具选项/预设选择",
    resetAll.reset === "all" && Array.isArray(resetAll.scope) && resetAll.scope.includes("presetSelection"),
    { scope: resetAll.scope });
  report.ok("重置只改偏好：不推进修订、不改变内容指纹",
    session.contentHash() === base && session.revision === revision,
    { hash: session.contentHash().slice(0, 10), revision: session.revision });
  session.free();
}

// ---- 未知工具被拒绝 ----------------------------------------------------
{
  const session = newSession(mod, { width: 32, height: 24 });
  let rejected = false;
  try {
    session.paintingCommand("tool.reset", JSON.stringify({ tool: "teleporter" }));
  } catch {
    rejected = true;
  }
  report.ok("重置未知工具被拒绝", rejected);
  session.free();
}

// ---- 预设不影响内容与库 ------------------------------------------------
// 删除预设不应连带删除文档内容或色板/笔刷库。
{
  const session = newSession(mod, { width: 32, height: 24 });
  session.execute("paint.stroke", JSON.stringify({ points: [[4, 4], [20, 16]], size: 5, color: "#123456" }));
  const painted = session.contentHash();
  const swatchesBefore = JSON.parse(session.paintingCommand("swatches.list", "{}")).count;
  session.saveToolPreset(JSON.stringify({ name: "删除目标", tool: "brush" }));
  session.editToolPreset(JSON.stringify({ action: "delete", preset: "删除目标" }));
  const swatchesAfter = JSON.parse(session.paintingCommand("swatches.list", "{}")).count;
  report.ok("删除工具预设不影响文档内容与色板库",
    session.contentHash() === painted && swatchesBefore === swatchesAfter,
    { swatches: swatchesAfter });
  session.free();
}

report.finish();
