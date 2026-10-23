/**
 * 文字域真实 WASM 主线冒烟（change: 2026-10-22-add-photocraft-typography-workflows）。
 *
 * 需要先构建真实内核，脚本只加载已构建产物，不编译、不联网：
 *
 *   pnpm -C photocraft run wasm
 *   node photocraft/tests/features/type/typecraft-smoke.mjs
 *
 * 覆盖 verification.md 的验收主线：指定字符对/OpenType → 段落样式 → Warp/转形状 →
 * 文字蒙版 → 查找替换 → 缺字体替换，并检查只读查询不动身份、非法参数与明确排除项被拒、
 * 文字草稿门禁、一步撤销恢复原文字，以及工程导出/重开后的内容身份。
 *
 * 这里只断言内核与域入口的真实返回值；像素外观、真实设备与 IME 仍属人工验收。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
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
// 记录真实执行过的命令 id：`type-commands.json` 里登记的命令必须在这次冒烟里至少跑过一次，
// 否则「48 个命令全部在真实内核上执行过」只是清单上的说法。
const executed = new Set();
for (const method of ["execute", "typeCommand", "typeQuery"]) {
  const original = mod.WasmEditor.prototype[method];
  mod.WasmEditor.prototype[method] = function instrumented(id, ...rest) {
    executed.add(id);
    return original.call(this, id, ...rest);
  };
}
const editor = new mod.WasmEditor();
const command = (id, params = {}) => JSON.parse(editor.typeCommand(id, JSON.stringify(params)));
const query = (id, params = {}) => JSON.parse(editor.typeQuery(id, JSON.stringify(params)));
const state = () => JSON.parse(editor.stateJson());
const layerKind = (id) => state().document.layers.find((layer) => layer.id === id)?.kind;
const featuresOn = (style, tag) => (style.features ?? []).some((entry) => entry.tag === tag && entry.value === 1);
const refuses = (run) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail === undefined ? "" : ` → ${JSON.stringify(detail).slice(0, 300)}`}`);
};

editor.execute("file.new", JSON.stringify({ width: 400, height: 200, background: "white" }));
const textLayer = JSON.parse(editor.execute("type.create", JSON.stringify({ x: 20, y: 80, text: "Type example", size: 32, font: "Inter" }))).layer;

// 只读查询：不改内容身份。
const identity = editor.contentHash();
for (const [id, params] of [
  ["type.info", { layer: textLayer }],
  ["type.fonts", {}],
  ["type.characterStyle.list", { layer: textLayer }],
  ["type.paragraphStyle.list", { layer: textLayer }],
  ["edit.checkSpelling", { action: "list", layer: textLayer }],
  ["type.resolveMissingFonts", {}]
]) {
  check(`查询 ${id}`, typeof query(id, params) === "object");
}
check("只读查询保持内容身份", editor.contentHash() === identity);

// U67：OpenType、指定字符对/段落选项（P0 `type.setStyle`）、样式库、点/段落转换。
// 十个特性逐个在真实内核上执行：只测 `fractions` 会漏掉命令门/参数校验里的拼写错误。
// 回读位置不对称：`standardLigatures` 落在 `ligatures`、`discretionaryLigatures` 落在
// `discretionary_ligatures`，其余 8 个落在 `features[]`（`{tag,value}`）。`standardLigatures`
// 默认本来就是开，所以「打开」必须先翻转当前状态，否则 `changed` 应为 false。
const OPEN_TYPE_FEATURES = [
  ["standardLigatures", "liga", (style) => style.ligatures === true],
  ["contextualAlternates", "calt", (style) => featuresOn(style, "calt")],
  ["discretionaryLigatures", "dlig", (style) => style.discretionary_ligatures === true],
  ["swash", "swsh", (style) => featuresOn(style, "swsh")],
  ["oldstyle", "onum", (style) => featuresOn(style, "onum")],
  ["stylisticAlternates", "salt", (style) => featuresOn(style, "salt")],
  ["titlingAlternates", "titl", (style) => featuresOn(style, "titl")],
  ["ornaments", "ornm", (style) => featuresOn(style, "ornm")],
  ["ordinals", "ordn", (style) => featuresOn(style, "ordn")],
  ["fractions", "frac", (style) => featuresOn(style, "frac")]
];
for (const [feature, tag, isOn] of OPEN_TYPE_FEATURES) {
  // 每个特性各起一个编辑器，避免前一个特性的开关掩盖后一个的默认状态。
  const probe = new mod.WasmEditor();
  probe.execute("file.new", JSON.stringify({ width: 300, height: 160, background: "white" }));
  const probeLayer = JSON.parse(probe.execute("type.create", JSON.stringify({ x: 20, y: 70, text: "Type example 123", size: 24, font: "Inter" }))).layer;
  const style = () => JSON.parse(probe.typeQuery("type.info", JSON.stringify({ layer: probeLayer }))).runs[0].style;
  const initial = isOn(style());
  const flipped = !initial;
  const baseline = probe.contentHash();
  const toggled = JSON.parse(probe.typeCommand(`type.openType.${feature}`, JSON.stringify({ layer: probeLayer, on: flipped })));
  check(`OpenType ${feature} 可切换`, toggled.changed === true && toggled.result?.feature === tag, toggled);
  check(`OpenType ${feature} 回读为切换后状态`, isOn(style()) === flipped);
  check(`OpenType ${feature} 改变内容身份`, probe.contentHash() !== baseline);
  const repeated = JSON.parse(probe.typeCommand(`type.openType.${feature}`, JSON.stringify({ layer: probeLayer, on: flipped })));
  check(`OpenType ${feature} 无变化时不报改动`, repeated.changed === false, repeated);
  const restored = JSON.parse(probe.typeCommand(`type.openType.${feature}`, JSON.stringify({ layer: probeLayer, on: initial })));
  check(`OpenType ${feature} 可切回默认`, restored.changed === true && isOn(style()) === initial);
  check(`OpenType ${feature} 切回后身份复原`, probe.contentHash() === baseline);
  probe.free();
}

check("指定字符对字偶距", Array.isArray(JSON.parse(editor.execute("type.setStyle", JSON.stringify({ layer: textLayer, kernPair: { at: 1, by: 12 } }))).runs));
check("完整段落选项", Array.isArray(JSON.parse(editor.execute("type.setStyle", JSON.stringify({ layer: textLayer, align: "justifyAll", firstLineIndent: 6, spaceBefore: 4, autoLeading: 140 }))).runs));
command("type.characterStyle.new", { name: "标题", layer: textLayer, fromSelection: true, apply: true });
check("字符样式可重用", (query("type.characterStyle.list", {}).styles ?? []).some((style) => style.name === "标题"));
command("type.paragraphStyle.new", { name: "正文", layer: textLayer });
const paragraphStyle = (query("type.paragraphStyle.list", {}).styles ?? [])[0];
check("段落样式可应用", command("type.paragraphStyle.apply", { id: paragraphStyle?.id, layer: textLayer }).result !== undefined);

// 样式库的复制与选项：面板两个入口在真实内核上确实改样式表，并随查询回读。
const titleStyle = (query("type.characterStyle.list", {}).styles ?? []).find((style) => style.name === "标题");
check("复制字符样式", command("type.characterStyle.duplicate", { id: titleStyle?.id }).result?.id !== undefined);
check("复制出自带回读", (query("type.characterStyle.list", {}).styles ?? []).some((style) => style.name === "标题 copy"));
check("修改字符样式选项", command("type.characterStyle.set", { id: titleStyle?.id, attrs: { size: 48 } }).result?.id === titleStyle?.id);
check(
  "样式选项回读生效",
  (query("type.characterStyle.list", {}).styles ?? []).find((style) => style.id === titleStyle?.id)?.resolved?.size_pt === 48
);
const bodyStyle = (query("type.paragraphStyle.list", {}).styles ?? []).find((style) => style.name === "正文");
check(
  "修改段落样式选项",
  command("type.paragraphStyle.set", { id: bodyStyle?.id, attrs: { spaceBefore: 12 } }).result?.id === bodyStyle?.id
);
check(
  "段落样式选项回读生效",
  (query("type.paragraphStyle.list", {}).styles ?? []).find((style) => style.id === bodyStyle?.id)?.resolved?.paragraph?.space_before_pt === 12
);
check("字体族列表可读", (query("type.fonts", {}).families ?? []).includes("Inter"));

// 样式库的其余动作：只在单测里覆盖过，这里在真实内核上逐个执行并断言可见效果。
// 每个动作都要么真改样式表、要么真写回图层，不能只证实"命令返回了"。
const charStyleForApply = (query("type.characterStyle.list", {}).styles ?? []).find((style) => style.name === "标题");
check(
  "字符样式可写回图层",
  command("type.characterStyle.apply", { id: charStyleForApply?.id, layer: textLayer }).result !== undefined
);
check(
  "按当前文字重定义字符样式",
  command("type.characterStyle.redefine", { id: charStyleForApply?.id, layer: textLayer }).result !== undefined
);
check(
  "清除字符样式覆盖",
  command("type.characterStyle.clearOverride", { layer: textLayer }).result !== undefined
);
const disposable = command("type.characterStyle.new", { name: "待删除", layer: textLayer });
check("删除字符样式", command("type.characterStyle.delete", { id: disposable.result?.id }).result !== undefined);
check(
  "删除后不再出现在列表",
  !(query("type.characterStyle.list", {}).styles ?? []).some((style) => style.id === disposable.result?.id)
);
const paraForRename = (query("type.paragraphStyle.list", {}).styles ?? []).find((style) => style.name === "正文");
check(
  "重命名段落样式",
  command("type.paragraphStyle.rename", { id: paraForRename?.id, name: "正文二" }).result?.name === "正文二"
);
check(
  "重命名后列表回读一致",
  (query("type.paragraphStyle.list", {}).styles ?? []).some((style) => style.name === "正文二")
);
const paraCopy = command("type.paragraphStyle.duplicate", { id: paraForRename?.id });
check("复制段落样式得到新 id", typeof paraCopy.result?.id === "number" && paraCopy.result?.id !== paraForRename?.id);
check(
  "段落样式可写回图层",
  command("type.paragraphStyle.apply", { id: paraForRename?.id, layer: textLayer }).result !== undefined
);
check(
  "按当前文字重定义段落样式",
  command("type.paragraphStyle.redefine", { id: paraForRename?.id, layer: textLayer }).result !== undefined
);
check(
  "清除段落样式覆盖",
  command("type.paragraphStyle.clearOverride", { layer: textLayer }).result !== undefined
);
const paraDisposable = command("type.paragraphStyle.new", { name: "段落待删除", layer: textLayer });
check(
  "删除段落样式",
  command("type.paragraphStyle.delete", { id: paraDisposable.result?.id }).result !== undefined
);
check(
  "删除后段落列表一致",
  !(query("type.paragraphStyle.list", {}).styles ?? []).some((style) => style.id === paraDisposable.result?.id)
);

for (const id of ["type.convertToParagraphText", "type.convertToPointText"]) check(id, command(id, { layer: textLayer }).result !== undefined);

// U68：七种抗锯齿、Warp（含取消）、工作路径、转形状、栅格化与一步撤销。
const pngHash = () => {
  const frozen = editor.exportBundle();
  const hash = crypto.createHash("sha256").update(frozen.output).digest("hex");
  frozen.free();
  return hash;
};
for (const mode of ["none", "sharp", "crisp", "strong", "smooth", "windows", "windowsLcd"]) {
  check(`抗锯齿 ${mode}`, command(`type.antiAlias.${mode}`, { layer: textLayer }).result !== undefined);
  check(`抗锯齿 ${mode} 回读`, query("type.info", { layer: textLayer }).antialias === mode[0].toUpperCase() + mode.slice(1), query("type.info", { layer: textLayer }).antialias);
}
// 上游合成器只区分 `None` 与其它模式（`text::render` 的覆盖率阈值分支），因此这里只断言真实像素变化
// 出现在 `none`：其它模式写入模型与工程，但共享同一覆盖率路径。这一点在 verification 中如实记录。
const smoothPng = pngHash();
command("type.antiAlias.none", { layer: textLayer });
const hardPng = pngHash();
check("抗锯齿 none 改变实际合成", smoothPng !== hardPng, [smoothPng, hardPng]);
JSON.parse(editor.undo());
check("撤销抗锯齿恢复像素", pngHash() === smoothPng);
const unwarpedPng = pngHash();
check("Warp 应用", command("type.warpText", { layer: textLayer, style: "arc", bend: 40 }).result !== undefined);
check("Warp 改变实际合成", pngHash() !== unwarpedPng);
JSON.parse(editor.undo());
check("撤销 Warp 恢复像素", pngHash() === unwarpedPng);
check("Warp 取消", command("type.warpText", { layer: textLayer, style: "none" }).result !== undefined);
check("转工作路径产生几何", (command("type.createWorkPath", { layer: textLayer }).result?.subpaths ?? 0) > 0);
check("转形状改变内容", command("type.convertToShape", { layer: textLayer }).changed === true);
JSON.parse(editor.undo());
check("撤销恢复形状前的文字", layerKind(textLayer) === "Type", layerKind(textLayer));
const rasterLayer = JSON.parse(editor.execute("type.create", JSON.stringify({ x: 200, y: 80, text: "Raster me", size: 28, font: "Inter" }))).layer;
check("栅格化改变内容", command("type.rasterizeTypeLayer", { layer: rasterLayer }).changed === true);
JSON.parse(editor.undo());
check("撤销恢复栅格化前的文字", layerKind(rasterLayer) === "Type", layerKind(rasterLayer));

// U69：文字蒙版、查找替换、拼写与缺字体。
const mask = command("type.createSelection", { layer: textLayer });
check("文字蒙版产生字形选区", mask.result?.selected === true && mask.changed === false, mask);
const layersBeforeMask = state().document.layers.length;
check("蒙版确实建立选区且不建层", state().document.hasSelection === true && layersBeforeMask === 3, layersBeforeMask);
check("查找命中指定文字", query("edit.findAndReplaceText", { find: "example", action: "find" }).found?.text === "example");
check("替换只改匹配文本", command("edit.findAndReplaceText", { find: "example", replace: "sample" }).result?.count === 1);
check("替换结果正确", query("type.info", { layer: textLayer }).text === "Type sample");
JSON.parse(editor.undo());
check("撤销替换恢复原文", query("type.info", { layer: textLayer }).text === "Type example");
// 单向替换（界面「替换当前」）：上游 `change` 只替换**查找光标当前命中**的那一处，
// 返回 `changed:{layer,start,end}` 而不是 `count`；必须先 `find` 建立光标。
editor.execute("type.create", JSON.stringify({ x: 10, y: 110, text: "example example", size: 18, font: "Inter" }));
check("查找建立光标", query("edit.findAndReplaceText", { find: "example", action: "find" }).found?.start === 0);
const oneChange = command("edit.findAndReplaceText", { find: "example", replace: "one", action: "change" });
check("单向替换只改一处", oneChange.result?.changed?.start === 0 && oneChange.result?.changed?.end === 3);
check("单向替换后仍有剩余匹配", state().document.layers.some((layer) => layer.text?.text === "one example"));

editor.execute("type.create", JSON.stringify({ x: 10, y: 140, text: "teh recieve", size: 18, font: "Missing Family" }));
check("拼写只报告内置英文词典认识的错词", (query("edit.checkSpelling", { action: "list", suggestions: 3 }).misspellings ?? []).some((row) => row.word === "teh"));
check("拼写修正一步完成", (command("edit.checkSpelling", { action: "changeAll", word: "teh", replace: "the" }).result?.changed ?? 0) >= 1);
check("缺失字体可列出", (query("type.resolveMissingFonts", {}).missing ?? []).includes("Missing Family"));
check("按映射替换缺失字体", (command("type.resolveMissingFonts", { map: { "Missing Family": "Inter" } }).result?.missing ?? [])[0] === "Missing Family");
check("替换保留原文", state().document.layers.some((layer) => layer.text?.text === "the recieve"));
check("替换后不再缺失", (query("type.resolveMissingFonts", {}).missing ?? []).length === 0);
// 全部替换使用默认字族，且必须真的改内容（`changed` 来自指纹差，不是固定 false）。
editor.execute("type.create", JSON.stringify({ x: 10, y: 170, text: "Another gone", size: 18, font: "Also Missing" }));
const beforeReplaceAll = editor.contentHash();
check("全部替换为默认字族", command("type.replaceAllMissingFonts").result !== undefined);
check("全部替换确实改了字族", editor.contentHash() !== beforeReplaceAll && (query("type.resolveMissingFonts", {}).missing ?? []).length === 0);

// 明确排除与非法参数：拒绝且不改身份。
for (const id of ["type.orientation.vertical", "type.attachToPath", "type.detachFromPath", "type.hitTest", "type.insertText", "type.saveDefaultTypeStyles", "type.updateAllTextLayers"]) {
  check(`排除项保持关闭 ${id}`, refuses(() => editor.typeCommand(id, "{}")));
}
for (const [id, params] of [
  ["type.warpText", { layer: textLayer, style: "spiral" }],
  ["type.createSelection", {}],
  ["edit.findAndReplaceText", { replace: "新" }],
  ["type.characterStyle.rename", { id: 1 }]
]) {
  const before = editor.contentHash();
  const beforeState = editor.stateJson();
  check(`非法参数被拒 ${id}`, refuses(() => editor.typeCommand(id, JSON.stringify(params))));
  check(`非法参数不改文档 ${id}`, editor.contentHash() === before && editor.stateJson() === beforeState);
}

// 文字草稿门禁：编辑中的文字不允许域写入或查询。
JSON.parse(editor.beginText(JSON.stringify({ layer: textLayer })));
check("文字草稿阻止写命令", refuses(() => editor.typeCommand("type.antiAlias.crisp", JSON.stringify({ layer: textLayer }))));
check("文字草稿阻止查询", refuses(() => editor.typeQuery("type.info", JSON.stringify({ layer: textLayer }))));
editor.cancelText();

// 图层全部锁定：域入口自行拒绝写入（上游抗锯齿/OpenType/变形/转换不查锁定），且不动文档。
// 只读查询与只改样式表的命令仍然可用。
const lockedLayer = JSON.parse(editor.execute("type.create", JSON.stringify({ x: 200, y: 150, text: "Locked", size: 20, font: "Inter" }))).layer;
// 缺字体替换不接受目标参数，上游会把文档里每个文字层都改一遍：锁定层同样必须被挡。
// 为了让拒绝原因确实是「锁定」而不是「没有可替换项」，文档里要有一个真实缺字体图层，
// 而它**不在**被锁的层上——显式目标解析查不到被锁层时，只有全文档范围才查得到。
editor.execute("type.create", JSON.stringify({ x: 10, y: 60, text: "Needs font", size: 18, font: "Definitely Missing" }));
editor.execute("layer.select", JSON.stringify({ layer: lockedLayer }));
editor.execute("layer.lockLayers", JSON.stringify({ all: true }));
// 锁定后把选中移开：证明拒绝来自「全文档里的锁定层」，不是恰好选中了它。
const unlockedProbe = JSON.parse(editor.execute("type.create", JSON.stringify({ x: 10, y: 20, text: "Probe", size: 18, font: "Inter" }))).layer;
editor.execute("layer.select", JSON.stringify({ layer: unlockedProbe }));
const lockedHash = editor.contentHash();
const lockedState = editor.stateJson();
for (const [id, params] of [
  ["type.antiAlias.crisp", { layer: lockedLayer }],
  ["type.openType.fractions", { layer: lockedLayer, on: true }],
  ["type.warpText", { layer: lockedLayer, style: "arc", bend: 20 }],
  ["type.convertToShape", { layer: lockedLayer }],
  ["type.rasterizeTypeLayer", { layer: lockedLayer }],
  ["type.createSelection", { layer: lockedLayer, removeLayer: true }],
  ["type.characterStyle.new", { name: "锁定样式", layer: lockedLayer, apply: true }]
]) {
  check(`锁定层拒绝写入 ${id}`, refuses(() => editor.typeCommand(id, JSON.stringify(params))));
}
// `applyTypography` 是面板**真正调用**的内核入口（不是 `typeCommand`），它自己校验参数后
// 转给上游 `type.setStyle`；上游不看 `effective_locks`，所以这条入口也必须被锁定挡住。
// 注意：`layer.select` 自身会推进修订号，因此这里的基线在切完选区之后才取。
for (const params of [
  { layer: lockedLayer, leading: 44 },
  { layer: lockedLayer, tracking: 120 },
  { layer: lockedLayer, kernPair: { at: 1, by: -20 } },
  { layer: lockedLayer, spaceBefore: 6 }
]) {
  check(`锁定层拒绝排版 ${JSON.stringify(params)}`, refuses(() => editor.applyTypography(JSON.stringify(params))));
}
check("锁定层拒绝排版后不改内容", editor.contentHash() === lockedHash);
check("锁定层拒绝排版后不改模型", editor.stateJson() === lockedState);
// 缺字体替换不接受目标参数，上游会把文档里每个文字层都改一遍：锁定层同样必须被挡。
// 上面已放好缺字体图层，并已把选中移开被锁层——这里验证只有全文档范围才查得到。
check("文档里确有缺失字体", (query("type.resolveMissingFonts", {}).missing ?? []).includes("Definitely Missing"));
for (const [id, params] of [
  ["type.replaceAllMissingFonts", {}],
  ["type.resolveMissingFonts", { map: { "Definitely Missing": "Inter" } }]
]) {
  check(`锁定层拒绝 ${id}`, refuses(() => editor.typeCommand(id, JSON.stringify(params))));
}
check("锁定层拒绝后不改内容", editor.contentHash() === lockedHash);
check("锁定层拒绝后不改模型", editor.stateJson() === lockedState);
check("锁定层仍可只读查询", (query("type.info", { layer: lockedLayer }).runs ?? []).length > 0);
check("锁定层仍可列出缺字体", Array.isArray(query("type.resolveMissingFonts", {}).missing));
// 样式表管理不写目标图层：新建（不 apply）与重命名仍应成功。
const lockedStyle = command("type.characterStyle.new", { name: "锁定期间的新样式" });
check("锁定层仍可管理样式表", typeof lockedStyle.result?.id === "number");
check("锁定层仍可重命名样式", command("type.characterStyle.rename", { id: lockedStyle.result?.id, name: "改名后" }).result?.name === "改名后");
editor.execute("layer.lockLayers", JSON.stringify({ all: false }));

// 内容身份（任务 3.2）：每个持久排版字段单独改动都必须让指纹变化，否则界面会「改了但没变脏」。
// 每项各起一个全新编辑器，避免前一项的写入掩盖后一项。
// `kernPair` 需要「两个字符之间」的光标位置，所以这一组用多字符文字。
for (const [name, apply] of [
  ["段落段前距", (e, l) => e.applyTypography(JSON.stringify({ layer: l, spaceBefore: 6 }))],
  ["段落首行缩进", (e, l) => e.applyTypography(JSON.stringify({ layer: l, firstLineIndent: 8 }))],
  ["段落自动行距", (e, l) => e.applyTypography(JSON.stringify({ layer: l, autoLeading: 1.5 }))],
  ["手工字偶距", (e, l) => e.applyTypography(JSON.stringify({ layer: l, kernPair: { at: 1, by: 30 } }))],
  ["首 run 行距", (e, l) => e.applyTypography(JSON.stringify({ layer: l, leading: 44 }))],
  ["首 run 字距", (e, l) => e.applyTypography(JSON.stringify({ layer: l, tracking: 60 }))],
  ["基线偏移", (e, l) => e.applyTypography(JSON.stringify({ layer: l, baselineShift: 3 }))],
  ["OpenType", (e, l) => e.typeCommand("type.openType.fractions", JSON.stringify({ layer: l, on: true }))],
  ["抗锯齿", (e, l) => e.typeCommand("type.antiAlias.none", JSON.stringify({ layer: l }))],
  ["Warp", (e, l) => e.typeCommand("type.warpText", JSON.stringify({ layer: l, style: "arc", bend: 20 }))],
  // 整层字符属性：只有一个 run，`charRuns` 不会出现，必须由平铺字段覆盖。
  ["整层下划线", (e, l) => e.execute("type.setStyle", JSON.stringify({ layer: l, underline: true }))],
  ["整层横向缩放", (e, l) => e.execute("type.setStyle", JSON.stringify({ layer: l, horizontalScale: 150 }))],
  ["整层字重", (e, l) => e.execute("type.setStyle", JSON.stringify({ layer: l, weight: 700 }))],
  ["整层大小写", (e, l) => e.execute("type.setStyle", JSON.stringify({ layer: l, caps: "all" }))],
  ["整层可变轴", (e, l) => e.execute("type.setStyle", JSON.stringify({ layer: l, variations: { wght: 650 } }))],
  // 范围级字符属性同样改变重排结果。
  ["范围字号", (e, l) => e.execute("type.setStyle", JSON.stringify({ layer: l, range: [1, 4], size: 40 }))],
  ["范围颜色", (e, l) => e.execute("type.setStyle", JSON.stringify({ layer: l, range: [1, 4], color: "#ff0000" }))]
]) {
  const probe = new mod.WasmEditor();
  probe.execute("file.new", JSON.stringify({ width: 300, height: 160, background: "white" }));
  const probeLayer = JSON.parse(probe.execute("type.create", JSON.stringify({ x: 20, y: 70, text: "ABCDE", size: 24, font: "Inter" }))).layer;
  const before = probe.contentHash();
  apply(probe, probeLayer);
  check(`排版内容身份 ${name}`, probe.contentHash() !== before);
  // 一步撤销回到原身份：多步历史会让「撤销一次」看起来没生效。
  probe.undo();
  check(`排版内容身份 ${name} 可一步撤销`, probe.contentHash() === before);
  probe.free();
}

// 范围级排版必须改变身份：`type.setStyle` 的 `range` 只改中间几个字符，首 run 完全不变。
// 这是实测发现的真实缺陷（只摘要首 run 时用户改完中间字符、关窗口不会被提示保存）。
for (const [name, params] of [
  ["范围字距", { range: [6, 11], tracking: 300 }],
  ["范围行距", { range: [6, 11], leading: 40 }],
  ["范围基线", { range: [6, 11], baselineShift: 5 }],
  // 伪粗体/伪斜体在上游按 `embolden`/`skew` 合成字形，真实改变像素；范围级写入只改中间几个
  // 字符，只能由逐 run 摘要覆盖（实测修复前这两项既不换指纹也不判脏）。
  ["范围伪粗体", { range: [6, 11], fauxBold: true }],
  ["范围伪斜体", { range: [6, 11], fauxItalic: true }]
]) {
  const probe = new mod.WasmEditor();
  probe.execute("file.new", JSON.stringify({ width: 300, height: 160, background: "white" }));
  const probeLayer = JSON.parse(probe.execute("type.create", JSON.stringify({ x: 20, y: 70, text: "ABCDE FGHIJ", size: 24, font: "Inter" }))).layer;
  const before = probe.contentHash();
  probe.execute("type.setStyle", JSON.stringify({ layer: probeLayer, ...params }));
  check(`范围级排版内容身份 ${name}`, probe.contentHash() !== before);
  probe.undo();
  check(`范围级排版内容身份 ${name} 可一步撤销`, probe.contentHash() === before);
  probe.free();
}

// 文档级样式表内容必须改变身份：改样式表本身时引用它的文字层看起来毫无变化。
{
  const probe = new mod.WasmEditor();
  probe.execute("file.new", JSON.stringify({ width: 300, height: 160, background: "white" }));
  const probeLayer = JSON.parse(probe.execute("type.create", JSON.stringify({ x: 20, y: 70, text: "ABCDE", size: 24, font: "Inter" }))).layer;
  const before = probe.contentHash();
  const style = JSON.parse(probe.typeCommand("type.characterStyle.new", JSON.stringify({ name: "身份样式", layer: probeLayer })));
  const styleId = style.result.id;
  check("样式表内容身份 新建样式判为已改动", style.changed === true && probe.contentHash() !== before);
  const afterCreate = probe.contentHash();
  const changedAttrs = JSON.parse(probe.typeCommand("type.characterStyle.set", JSON.stringify({ id: styleId, attrs: { size_pt: 60 } })));
  check("样式表内容身份 改样式属性判为已改动", changedAttrs.changed === true && probe.contentHash() !== afterCreate);
  const renamed = JSON.parse(probe.typeCommand("type.characterStyle.rename", JSON.stringify({ id: styleId, name: "改名样式" })));
  check("样式表内容身份 重命名判为已改动", renamed.changed === true);
  // 样式没被 apply、只改样式表本身：删掉后回到基线。
  probe.typeCommand("type.characterStyle.delete", JSON.stringify({ id: styleId }));
  check("样式表内容身份 清空后回到基线", probe.contentHash() === before);
  // 应用到图层则是另一回事：它有真实排版效果（见上面 10 个字段的断言）。
  const applied = JSON.parse(probe.typeCommand("type.characterStyle.new", JSON.stringify({ name: "已应用", layer: probeLayer, apply: true })));
  check("样式表内容身份 应用到图层判为已改动", applied.changed === true && probe.contentHash() !== before);
  // 应用字符样式会把解析值写进 run（下划线），只摘要字号/颜色抓不到——引用本身也算内容。
  const styled = JSON.parse(probe.typeCommand("type.characterStyle.new", JSON.stringify({ name: "下划线", attrs: { underline: true } })));
  const styledBefore = probe.contentHash();
  const styleApplied = JSON.parse(probe.typeCommand("type.characterStyle.apply", JSON.stringify({ id: styled.result.id, layer: probeLayer })));
  check("样式表内容身份 应用字符样式判为已改动", styleApplied.changed === true && probe.contentHash() !== styledBefore);
  probe.free();
}

// 命令清单覆盖：`type-commands.json` 是内核白名单里本域部分（与 `params.rs` 一致），
// 每一条都必须在上面的流程里真的被调用过。只登记不执行会让「48 个命令全部在真实内核上
// 执行过」变成清单上的说法，所以这里用真实调用记录核对，而不是再抄一份清单。
const declared = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "type-commands.json"), "utf8")).commands;
const neverRun = declared.filter((id) => !executed.has(id));
check("清单里每条命令都在真实内核上执行过", neverRun.length === 0, neverRun);
const kernelCommands = new Set(JSON.parse(editor.allowedCommandIdsJson()));
check("执行记录覆盖内核白名单里的本域命令", declared.every((id) => kernelCommands.has(id)), declared.filter((id) => !kernelCommands.has(id)));

// 工程往返：导出后重开，文字层与排版仍在。
const bundle = editor.exportBundle();
const reopened = new mod.WasmEditor();
reopened.openProject(bundle.project, "");
check("重开得到内容身份", typeof reopened.contentHash() === "string" && reopened.contentHash().length === 16);
check("重开后文字层仍在", JSON.parse(reopened.stateJson()).document.layers.some((layer) => typeof layer.text?.text === "string"));
check("重开后排版可查询", (JSON.parse(reopened.typeQuery("type.info", JSON.stringify({ layer: textLayer }))).runs ?? []).length > 0);
bundle.free();
reopened.free();
editor.free();

if (failures) {
  console.error(`文字域真实 WASM 冒烟失败 ${failures} 项`);
  process.exit(1);
}
console.log("文字域真实 WASM 主线冒烟通过（U67/U68/U69，含撤销与工程重开）");
