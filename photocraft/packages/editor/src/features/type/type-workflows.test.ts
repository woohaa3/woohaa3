/**
 * 文字域协议面回归（change: 2026-10-22-add-photocraft-typography-workflows，U67/U68/U69）。
 *
 * 这里守住三件容易悄悄漂移的事：
 * 1. 界面可发出的命令清单与内核白名单逐条对应（两边漏一个就失败），排除项永远不出现；
 * 2. 参数构造器在界面侧就拒绝必然失败的输入（空查找、无目标图层的蒙版、坏映射）；
 * 3. 已开放/已排除的子能力不会因为「前缀放开」而被顺带打开。
 *
 * 只读本域两个源文件与内核白名单常量，不启动 WASM、不读写工程。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TYPECRAFT_ANTIALIAS_MODES,
  TYPECRAFT_COMMANDS,
  TYPECRAFT_FIND_ACTIONS,
  TYPECRAFT_MASK_OPERATIONS,
  TYPECRAFT_OPEN_TYPE_FEATURES,
  TYPECRAFT_PARAGRAPH_ALIGNS,
  TYPECRAFT_PARAGRAPH_KEYS,
  TYPECRAFT_SPELL_ACTIONS,
  TYPECRAFT_WARP_STYLES,
  buildFindReplaceParams,
  buildFontReplacementMap,
  buildSpellParams,
  buildTypeMaskParams,
  buildWarpParams,
  isTypeCraftCommand,
  typeCraftWriteCommands
} from "./commands.js";

const RUST_PARAMS = new URL("../../../../../rust/crates/editor-core/src/features/type/params.rs", import.meta.url);

/** 取出 Rust 白名单常量里的命令 id（只解析两张表，不解析校验代码里的前缀字面量）。 */
function rustList(name: "TYPE_QUERIES" | "TYPE_COMMANDS"): string[] {
  const text = readFileSync(RUST_PARAMS, "utf8");
  const start = text.indexOf(`pub const ${name}`);
  expect(start, `${name} 应存在于 params.rs`).toBeGreaterThan(-1);
  const end = text.indexOf("];", start);
  expect(end).toBeGreaterThan(start);
  return [...text.slice(start, end).matchAll(/"([a-zA-Z]+\.[a-zA-Z.]+)"/g)].map((match) => match[1]!);
}

const RUST_QUERIES = rustList("TYPE_QUERIES");
const RUST_COMMANDS = rustList("TYPE_COMMANDS");

/**
 * 面板用模板拼出的命令 id（`type.${kind}.apply` 同时覆盖字符与段落样式，
 * OpenType 复选框走 `feature.command`，抗锯齿走 `type.antiAlias.${mode}`）。
 * 只把**确实被模板覆盖**的 id 视为「有入口」，其余必须是面板源码里的字面量。
 */
function reachableByTemplate(panels: string, id: string): boolean {
  if (TYPECRAFT_OPEN_TYPE_FEATURES.some((feature) => feature.command === id)) {
    return /feature\.command/.test(panels);
  }
  if (TYPECRAFT_ANTIALIAS_MODES.some((mode) => id === `type.antiAlias.${mode}`)) {
    return panels.includes("`type.antiAlias.${");
  }
  // 样式命令面板用 `type.${kind}.<action>` 拼出 id：只有**实际出现过的动作**才算有入口，
  // 不能因为「有某种模板」就假设所有动作都接上了。
  const actions = new Set([...panels.matchAll(/`type\.\$\{kind\}\.([a-zA-Z]+)`/g)].map((match) => match[1]!));
  return ["characterStyle", "paragraphStyle"].some(
    (style) => id.startsWith(`type.${style}.`) && actions.has(id.slice(`type.${style}.`.length))
  );
}

/** 明确排除的子能力：竖排、沿路径排字、默认样式读写、光标命中与整层重写。 */
const EXCLUDED = [
  "type.orientation.vertical",
  "type.attachToPath",
  "type.detachFromPath",
  "type.pasteLoremIpsum",
  "type.saveDefaultTypeStyles",
  "type.loadDefaultTypeStyles",
  "type.updateAllTextLayers",
  "type.insertText",
  "type.hitTest",
  "type.caret",
  "type.navigate",
  "type.increaseSize"
];

describe("界面命令清单与内核白名单", () => {
  it("双向一一对应：界面没有多余入口，内核没有无入口命令", () => {
    const ui = TYPECRAFT_COMMANDS.map((entry) => entry.id).sort();
    const kernel = [...new Set([...RUST_COMMANDS, ...RUST_QUERIES])].sort();
    expect(ui).toEqual(kernel);
    expect(new Set(ui).size).toBe(ui.length);
  });

  it("只读标记与内核读入口一致", () => {
    const readOnly = TYPECRAFT_COMMANDS.filter((entry) => entry.readOnly).map((entry) => entry.id);
    expect(readOnly.every((id) => RUST_QUERIES.includes(id))).toBe(true);
    // 写命令一律在内核写表里；双态命令（读/写各走一侧）两边都有。
    expect(typeCraftWriteCommands().every((entry) => RUST_COMMANDS.includes(entry.id))).toBe(true);
    for (const dual of ["edit.findAndReplaceText", "edit.checkSpelling", "type.resolveMissingFonts"]) {
      expect(RUST_QUERIES).toContain(dual);
      expect(RUST_COMMANDS).toContain(dual);
    }
  });

  it("排除项既不在界面清单，也不在内核白名单", () => {
    for (const id of EXCLUDED) {
      expect(isTypeCraftCommand(id)).toBe(false);
      expect(RUST_COMMANDS).not.toContain(id);
      expect(RUST_QUERIES).not.toContain(id);
    }
    // 未实现的任意 id 也不能靠前缀蒙进清单。
    for (const id of ["type.somethingNew", "type.orientation", "edit.replaceAll", "type.openType.unknown"]) {
      expect(isTypeCraftCommand(id)).toBe(false);
    }
  });

  /** 清单与内核对齐只证明「能发」，不证明「界面真的发得到」。 */
  it("清单里的每条命令都有真实界面入口（防止命令已登记却没有按钮）", () => {
    const panels = readFileSync(new URL("./panels.tsx", import.meta.url), "utf8");
    const ids = TYPECRAFT_COMMANDS.map((entry) => entry.id);
    const missing = ids.filter((id) => !panels.includes(id) && !reachableByTemplate(panels, id));
    expect(missing, `以下命令在面板里没有入口：${missing.join(", ")}`).toEqual([]);
  });

  it("OpenType 十个特性各自对应一条已开放命令，抗锯齿覆盖全部方式", () => {
    expect(TYPECRAFT_OPEN_TYPE_FEATURES).toHaveLength(10);
    expect(new Set(TYPECRAFT_OPEN_TYPE_FEATURES.map((feature) => feature.id)).size).toBe(10);
    for (const feature of TYPECRAFT_OPEN_TYPE_FEATURES) expect(isTypeCraftCommand(feature.command)).toBe(true);
    for (const mode of TYPECRAFT_ANTIALIAS_MODES) expect(isTypeCraftCommand(`type.antiAlias.${mode}`)).toBe(true);
    expect(TYPECRAFT_ANTIALIAS_MODES).toHaveLength(7);
  });
});

describe("参数构造器", () => {
  it("文字变形限制样式与 ±100 范围，并保留取消变形", () => {
    expect(buildWarpParams({ layer: 3, style: "arc", bend: 50 })).toEqual({ layer: 3, style: "arc", bend: 50 });
    // 超范围被夹到内核接受区间，而不是发出必然被拒的参数。
    expect(buildWarpParams({ layer: 3, style: "wave", bend: 500, horizontalDistortion: -500 })).toEqual({
      layer: 3,
      style: "wave",
      bend: 100,
      horizontalDistortion: -100
    });
    // 非有限数不进参数。
    expect(buildWarpParams({ layer: 3, style: "arc", bend: Number.NaN })).toEqual({ layer: 3, style: "arc" });
    expect(buildWarpParams({ layer: null, style: "none" })).toEqual({ style: "none" });
    expect(TYPECRAFT_WARP_STYLES).toContain("none");
  });

  it("查找/替换不构造空查询，替换动作才带 replace", () => {
    expect(buildFindReplaceParams({ find: "  ", replace: "新" })).toBeNull();
    expect(buildFindReplaceParams({ find: "旧", action: "find" })).toEqual({ find: "旧", action: "find" });
    expect(buildFindReplaceParams({ find: "旧", replace: "新" })).toEqual({ find: "旧", replace: "新", action: "changeAll" });
    expect(buildFindReplaceParams({ find: "旧", replace: "新", caseSensitive: true, forward: false, layer: 4 }))
      .toEqual({ find: "旧", replace: "新", action: "changeAll", caseSensitive: true, forward: false });
    expect(TYPECRAFT_FIND_ACTIONS).toContain("find");
  });

  it("拼写参数按动作要求位置或单词", () => {
    expect(buildSpellParams({ action: "list" })).toEqual({ action: "list" });
    expect(buildSpellParams({ action: "list", layer: 2, suggestions: 99 })).toEqual({ action: "list", layer: 2, suggestions: 20 });
    expect(buildSpellParams({ action: "change", layer: 2, replace: "hello" })).toBeNull();
    expect(buildSpellParams({ action: "change", layer: 2, start: 0, end: 3, replace: "hello" }))
      .toMatchObject({ action: "change", layer: 2, replace: "hello" });
    expect(buildSpellParams({ action: "changeAll", replace: "hello" })).toBeNull();
    expect(buildSpellParams({ action: "changeAll", word: "helo", replace: "hello" })).toMatchObject({ word: "helo" });
    expect(TYPECRAFT_SPELL_ACTIONS).toContain("suggest");
  });

  it("文字蒙版必须有真实文字层，且只带已开放的操作符", () => {
    expect(buildTypeMaskParams({ layer: null })).toBeNull();
    expect(buildTypeMaskParams({ layer: 7 })).toEqual({ layer: 7 });
    expect(buildTypeMaskParams({ layer: 7, operation: "subtract", antialias: "crisp", removeLayer: true }))
      .toEqual({ layer: 7, operation: "subtract", antialias: "crisp", removeLayer: true });
    expect(TYPECRAFT_MASK_OPERATIONS).toEqual(["new", "add", "subtract", "intersect"]);
  });

  it("字体替换映射拒绝空项与空映射", () => {
    expect(buildFontReplacementMap([])).toBeNull();
    expect(buildFontReplacementMap([{ from: "Missing", to: "  " }])).toBeNull();
    expect(buildFontReplacementMap([{ from: "Missing", to: "Inter" }, { from: "Gone", to: "Noto Sans SC" }]))
      .toEqual({ Missing: "Inter", Gone: "Noto Sans SC" });
  });
});

describe("段落选项", () => {
  it("界面选项与内核已实现键一致，且包含全部对齐值", () => {
    expect([...TYPECRAFT_PARAGRAPH_KEYS].sort()).toEqual([
      "align",
      "autoLeading",
      "direction",
      "endIndent",
      "firstLineIndent",
      "hyphenate",
      "spaceAfter",
      "spaceBefore",
      "startIndent"
    ]);
    expect(TYPECRAFT_PARAGRAPH_ALIGNS).toContain("justifyAll");
    expect(TYPECRAFT_PARAGRAPH_ALIGNS).toHaveLength(7);
  });
});
