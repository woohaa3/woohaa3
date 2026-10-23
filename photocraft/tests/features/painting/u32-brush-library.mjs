/**
 * U32 选区笔尖与笔刷库分组：定义尺寸等于选区、组管理重载保持、删除库项不影响已冻结笔迹。
 */
import { createReport, loadKernel, newSession } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U32 选区笔尖 / 笔刷分组");

// ---- 定义笔尖尺寸等于选区 ----------------------------------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  session.execute("select.rect", JSON.stringify({ x: 2, y: 2, width: 10, height: 6, mode: "replace" }));
  session.execute("paint.stroke", JSON.stringify({ points: [[4, 4], [10, 6]], size: 4, color: "#000000" }));
  const defined = JSON.parse(session.defineBrushFromSelection("证据笔尖", "证据分组"));
  const groups = JSON.parse(session.brushPresetsJson(false)).groups;
  report.ok("选区笔尖尺寸等于选区并进入指定分组", defined.width === 10 && defined.height === 6
    && groups.some((entry) => entry.group === "证据分组"), { defined });
  session.free();
}

// ---- 空选区拒绝 --------------------------------------------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  session.execute("select.rect", JSON.stringify({ x: 2, y: 2, width: 0, height: 0, mode: "replace" }));
  let rejected = false;
  try {
    session.defineBrushFromSelection("空笔尖", "");
  } catch {
    rejected = true;
  }
  report.ok("空选区定义笔尖被拒绝", rejected);
  session.free();
}

// ---- 分组改名/排序/删除与默认组保护 ------------------------------------
{
  const session = newSession(mod, { width: 48, height: 32 });
  session.saveBrushPreset(JSON.stringify({ name: "组内笔", group: "旧组", brush: { size: 20 } }));
  const renamed = JSON.parse(session.renameBrushGroup("旧组", "新组"));
  const moved = JSON.parse(session.moveBrushGroup("新组", 0));
  const removed = JSON.parse(session.deleteBrushGroup("新组", true));
  // keepPresets=true：成员应被搬到 general，而不是被删掉。
  const survivor = removed.groups.some((entry) => entry.group === "general" && entry.count >= 1);

  let protectedGroup = false;
  try {
    session.deleteBrushGroup("general", false);
  } catch {
    protectedGroup = true;
  }
  report.ok("分组改名/排序生效，删除时成员按 keepPresets 保留", renamed.renamed === 1 && moved.index === 0
    && removed.removed === 1 && survivor, { renamed: renamed.renamed, moved: moved.index, removed: removed.removed, survivor });
  report.ok("默认分组受保护（不允许删除）", protectedGroup);
  session.free();
}

// ---- 库重载保持 --------------------------------------------------------
// 快照→恢复：成员必须原样回来，这是「重载保持」的域内可验证形态。
// 注意 `groups` 只是分组计数，成员在顶层 `presets` 里（带 `group` 字段）。
{
  const session = newSession(mod, { width: 48, height: 32 });
  session.saveBrushPreset(JSON.stringify({ name: "快照笔", group: "快照组", brush: { size: 33 } }));
  const before = JSON.parse(session.brushPresetsJson(true));
  const bytes = session.brushLibrarySnapshot();
  session.deleteBrushPreset("快照笔");
  const afterDelete = JSON.parse(session.brushPresetsJson(true));
  session.restoreBrushLibrary(bytes);
  const afterRestore = JSON.parse(session.brushPresetsJson(true));
  const found = afterRestore.presets.find((preset) => preset.name === "快照笔");
  // 列表刻意不含位图/完整 brush 设置，尺寸要从单条预设取。
  const detail = found === undefined ? null : JSON.parse(session.brushPresetJson("快照笔"));
  report.ok("库快照恢复后分组与成员原样回来",
    !afterDelete.presets.some((preset) => preset.name === "快照笔")
    && JSON.stringify(afterRestore.presets) === JSON.stringify(before.presets)
    && found?.group === "快照组" && detail?.brush?.size === 33, {
      presetsBefore: before.presets.length, presetsAfterDelete: afterDelete.presets.length,
      snapshotBytes: bytes.length, restoredGroup: found?.group, restoredSize: detail?.brush?.size,
    });
  session.free();
}

// ---- 删除库项不影响已提交笔迹 ------------------------------------------
// spec：已冻结笔迹不受随后库删除影响。笔迹在提交时已栅格化，所以内容指纹必须不变。
{
  const session = newSession(mod, { width: 48, height: 32 });
  session.execute("select.rect", JSON.stringify({ x: 2, y: 2, width: 10, height: 6, mode: "replace" }));
  session.execute("paint.stroke", JSON.stringify({ points: [[4, 4], [10, 6]], size: 4, color: "#000000" }));
  const painted = session.contentHash();
  session.defineBrushFromSelection("冻结笔尖", "冻结组");
  session.selectBrushPreset("冻结笔尖");
  // 清掉选区：否则第二笔会被选区裁掉，测到的「没变化」是选区语义而不是笔刷问题。
  session.execute("select.all", "{}");
  session.execute("paint.stroke", JSON.stringify({ points: [[20, 20], [30, 26]], size: 8, color: "#00ff00" }));
  const withBrushStroke = session.contentHash();
  session.deleteBrushPreset("冻结笔尖");
  report.ok("删除笔刷库项不影响已提交像素",
    session.contentHash() === withBrushStroke && withBrushStroke !== painted,
    { changed: withBrushStroke !== painted });
  session.execute("edit.undo", "{}");
  report.ok("撤销回到笔刷落笔前", session.contentHash() === painted);
  session.free();
}

// ---- 笔迹预览 ----------------------------------------------------------
{
  const session = newSession(mod, { width: 32, height: 24 });
  const base = session.contentHash();
  const preview = session.brushPreview(JSON.stringify({ brush: { size: 12, hardness: 0.5 }, side: 48 }));
  report.ok("笔刷预览产出位图且不写文档", preview.width === 48 && preview.height > 0
    && preview.pixels.length > 0 && session.contentHash() === base, { width: preview.width, height: preview.height });
  session.free();
}

report.finish();
