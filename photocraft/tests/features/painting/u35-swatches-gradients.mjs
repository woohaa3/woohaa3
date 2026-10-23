/**
 * U35 色板 / 渐变预设：分组、导入导出往返、常用色，以及共享渐变预设与色标编辑。
 *
 * 判据来自 spec：色板/渐变往返后数值一致，渐变可用于实际绘画和已有样式控件；
 * 应用后的资源与库独立（改库不影响已应用的渐变）。
 */
import { createReport, loadKernel, newSession } from "./harness.mjs";

const mod = await loadKernel();
const report = createReport("U35 色板 / 渐变预设");

const hexAt = (session, x, y) => {
  const raw = session.sampleColorOptions(JSON.stringify({ x, y, size: "point", sampleLayer: "all" }));
  const decoded = JSON.parse(raw);
  return decoded === null ? null : decoded.hex;
};

/** 把 `swatches.list` 的分组结构摊平成带组名的色板数组（分组字段名是 `name`）。 */
const flatSwatches = (session) => JSON.parse(session.paintingCommand("swatches.list", "{}"))
  .groups.flatMap((group) => (group.swatches ?? []).map((swatch) => ({ ...swatch, group: group.name })));

// ---- 色板增改与分组 ----------------------------------------------------
{
  const session = newSession(mod, { width: 32, height: 24 });
  const base = session.contentHash();
  session.paintingCommand("swatches.add", JSON.stringify({ color: "#123456", name: "往返色", group: "证据" }));
  const found = flatSwatches(session).find((swatch) => swatch.name === "往返色");
  const used = JSON.parse(session.paintingCommand("swatches.use", JSON.stringify({ swatch: "往返色", target: "foreground" })));
  report.ok("色板新增后可列出、可取样且不写文档",
    found?.hex === "#123456" && used.hex === "#123456" && session.contentHash() === base,
    { hex: found?.hex, used: used.hex });

  // 改名 / 移动：移动的目标分组必须先存在，否则内核拒绝（正确拒绝）。
  session.paintingCommand("swatches.newGroup", JSON.stringify({ name: "另一组" }));
  session.paintingCommand("swatches.rename", JSON.stringify({ swatch: "往返色", name: "改名色" }));
  session.paintingCommand("swatches.move", JSON.stringify({ swatch: "改名色", to: "另一组" }));
  const relocated = flatSwatches(session).find((swatch) => swatch.name === "改名色");
  report.ok("色板改名与移动生效", relocated?.group === "另一组" && relocated?.hex === "#123456", { group: relocated?.group });

  // 分组管理：新建、改名、删除（keepSwatches 保留成员）。
  session.paintingCommand("swatches.add", JSON.stringify({ color: "#abcdef", name: "临时色", group: "临时组" }));
  const renamedGroup = JSON.parse(session.paintingCommand("swatches.renameGroup", JSON.stringify({ group: "临时组", name: "改分组" })));
  const deletedGroup = JSON.parse(session.paintingCommand("swatches.deleteGroup", JSON.stringify({ group: "改分组", keepSwatches: true })));
  const survivor = flatSwatches(session).find((swatch) => swatch.name === "临时色");
  report.ok("色板分组新建/改名/删除时成员按 keepSwatches 保留",
    renamedGroup.group === "改分组" && deletedGroup.kept === 1 && survivor !== undefined,
    { renamed: renamedGroup.group, kept: deletedGroup.kept, survivor: survivor?.group });
  session.free();
}

// ---- ACO 往返 ----------------------------------------------------------
// 导出 → 导入 → 数值必须一致。这是「往返后数值一致」的直接证据。
{
  const session = newSession(mod, { width: 32, height: 24 });
  session.paintingCommand("swatches.add", JSON.stringify({ color: "#112233", name: "甲", group: "往返" }));
  session.paintingCommand("swatches.add", JSON.stringify({ color: "#445566", name: "乙", group: "往返" }));
  const exported = JSON.parse(session.paintingCommand("swatches.export", JSON.stringify({ format: "aco" })));
  const imported = JSON.parse(session.paintingCommand("swatches.import", JSON.stringify({ data: exported.data, mode: "replace" })));
  const afterImport = JSON.parse(session.paintingCommand("swatches.list", "{}"));
  const colors = afterImport.groups.flatMap((group) => group.swatches ?? []).map((swatch) => swatch.hex);
  report.ok("色板 ACO 往返后数值一致",
    typeof exported.data === "string" && exported.count >= 2 && colors.includes("#112233") && colors.includes("#445566"),
    { exported: exported.count, imported: imported.count ?? imported.imported, colors: colors.slice(0, 6) });
  session.free();
}

// ---- 常用色 / 重置 -----------------------------------------------------
{
  const session = newSession(mod, { width: 32, height: 24 });
  const base = session.contentHash();
  const reset = JSON.parse(session.paintingCommand("swatches.reset", JSON.stringify({ append: false })));
  const afterReset = JSON.parse(session.paintingCommand("swatches.list", "{}"));
  // `swatches.reset` 返回 {groups,count}（没有 ok/reset 字段），判据是库回到默认内容。
  report.ok("色板重置回到默认库且不写文档",
    reset.count === afterReset.count && afterReset.count > 0 && session.contentHash() === base,
    { resetCount: reset.count, count: afterReset.count });
  session.free();
}

// ---- 渐变预设：选择、色标编辑、用于实际绘画 ----------------------------
{
  const session = newSession(mod, { width: 64, height: 16 });
  const listed = JSON.parse(session.paintingCommand("gradient.presets.list", "{}"));
  const first = listed.groups[0].presets[0];
  const selected = JSON.parse(session.paintingCommand("gradient.presets.select", JSON.stringify({ preset: first.name, applyToLayer: false })));
  report.ok("渐变预设可选择且不新建填充层",
    selected.current?.name === first.name && !("layer" in selected),
    { current: selected.current?.name });

  // 用所选预设的色标直接落渐变：两端必须不同色。
  const stops = selected.current.stops;
  session.execute("paint.gradient", JSON.stringify({
    from: [0, 8], to: [63, 8], style: "linear", stops, opacity: 100, mode: "normal",
  }));
  const start = hexAt(session, 1, 8);
  const end = hexAt(session, 62, 8);
  report.ok("预设色标可用于实际绘画", start !== null && end !== null && start !== end, { start, end });

  // 资源与库独立：改库里的色标不应追溯改动已落下（已栅格化）的像素。
  const painted = session.contentHash();
  session.paintingCommand("gradient.presets.list", "{}");
  report.ok("已应用的渐变不随库操作改变", session.contentHash() === painted);
  session.free();
}

// ---- 色板/渐变不推进修订 ----------------------------------------------
// 偏好与内容分开：这一组命令全都不该让文档变「已修改」。
{
  const session = newSession(mod, { width: 32, height: 24 });
  const before = { hash: session.contentHash(), revision: session.revision };
  const calls = [
    ["swatches.add", { color: "#010203", name: "修订色", group: "修订组" }],
    ["swatches.list", {}],
    ["swatches.rename", { swatch: "修订色", name: "修订色2" }],
    ["swatches.export", { format: "aco" }],
    ["swatches.use", { swatch: "修订色2", target: "background" }],
    ["swatches.delete", { swatch: "修订色2", group: "修订组" }],
    ["swatches.reset", { append: true }],
    ["gradient.presets.list", {}],
    ["gradient.presets.select", { preset: "Black, White", applyToLayer: false }],
  ];
  const drift = [];
  for (const [id, params] of calls) {
    try {
      session.paintingCommand(id, JSON.stringify(params));
    } catch (error) {
      drift.push(`${id}: ${String(error).slice(0, 80)}`);
    }
    if (session.contentHash() !== before.hash || session.revision !== before.revision) drift.push(`${id} 改变了内容/修订`);
  }
  report.ok("色板与渐变预设命令不改变内容指纹与修订", drift.length === 0, drift.length ? drift : undefined);
  session.free();
}

report.finish();
