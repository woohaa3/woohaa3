/**
 * 命令搜索索引回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 搜索索引只包含 `allowed` 命令：搜索不是第二条写入口，未开放/未知命令不得出现在结果里。
 */
import { describe, expect, it } from "vitest";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { defaultPaletteHits, fuzzyScore, paletteEntries, pushRecent, searchPalette } from "./command-palette.js";

function command(patch: Partial<PhotocraftCommand> & { id: string }): PhotocraftCommand {
  return {
    id: patch.id,
    label: patch.label ?? patch.id,
    menu: patch.menu ?? ["编辑"],
    shortcut: patch.shortcut ?? null,
    params: "{}",
    enabled: patch.enabled ?? true,
    disabledReason: patch.disabledReason ?? null,
    needsDocument: patch.needsDocument ?? true,
    allowed: patch.allowed ?? true,
    ...(patch.keywords ? { keywords: patch.keywords } : {})
  };
}

const commands = new Map<string, PhotocraftCommand>([
  ["edit.undo", command({ id: "edit.undo", label: "撤销", shortcut: "Cmd+Z", keywords: ["undo", "z"] })],
  ["edit.redo", command({ id: "edit.redo", label: "重做", shortcut: "Cmd+Shift+Z", keywords: ["redo", "z"] })],
  ["edit.copy", command({ id: "edit.copy", label: "复制" })],
  ["layer.new.layer", command({ id: "layer.new.layer", label: "新建图层…", menu: ["图层", "新建"], keywords: ["new", "add"] })],
  ["layer.mergeVisible", command({ id: "layer.mergeVisible", label: "合并可见图层", enabled: false, disabledReason: "没有可见图层" })],
  ["filter.liquify", command({ id: "filter.liquify", label: "液化", allowed: false })],
  ["select.subject", command({ id: "select.subject", label: "选择主体", allowed: false })]
]);

describe("模糊评分", () => {
  it("空查询匹配一切，子序列匹配按连续与词首加权", () => {
    expect(fuzzyScore("", "撤销")).toBe(0);
    expect(fuzzyScore("ph", "photoshop")).not.toBeNull();
    expect(fuzzyScore("xyz", "撤销")).toBeNull();
    expect(fuzzyScore("新建", "新建图层…")).not.toBeNull();
    expect(fuzzyScore("合并图层", "合并可见图层")).not.toBeNull();
  });
});

describe("搜索索引", () => {
  it("只收录已接通命令，并保留禁用原因与分组", () => {
    const entries = paletteEntries(commands);
    expect(entries.map((entry) => entry.id)).toEqual(["edit.undo", "edit.redo", "edit.copy", "layer.new.layer", "layer.mergeVisible"]);
    expect(entries.find((entry) => entry.id === "layer.new.layer")?.menu).toBe("图层 ▸ 新建");
    expect(entries.find((entry) => entry.id === "layer.mergeVisible")).toMatchObject({ enabled: false, reason: "没有可见图层" });
    expect(entries.some((entry) => entry.id === "filter.liquify")).toBe(false);
  });

  it("未开放命令既不出现在搜索，也无法从搜索结果执行", () => {
    const entries = paletteEntries(commands);
    expect(searchPalette(entries, "液化")).toEqual([]);
    expect(searchPalette(entries, "主体")).toEqual([]);
  });

  it("完全同名优先，最近使用加权，禁用条目排在可用条目之后", () => {
    const entries = paletteEntries(commands);
    const hits = searchPalette(entries, "复制");
    expect(hits[0]?.id).toBe("edit.copy");
    const merged = searchPalette(entries, "合并");
    expect(merged.map((hit) => hit.id)).toEqual(["layer.mergeVisible"]);
    expect(merged[0]?.enabled).toBe(false);

    const withRecent = searchPalette(entries, "z", { recentIds: ["edit.redo"] });
    expect(withRecent.map((hit) => hit.id)).toEqual(["edit.redo", "edit.undo"]);
  });

  it("关键字参与匹配，结果有界", () => {
    const entries = paletteEntries(commands);
    expect(searchPalette(entries, "add").map((hit) => hit.id)).toEqual(["layer.new.layer"]);
    const limited = searchPalette(entries, "", { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(searchPalette(entries, "撤销", { limit: 0 })).toHaveLength(1);
  });

  it("组合提示可由调用方替换为当前生效的绑定", () => {
    const entries = paletteEntries(commands, {
      shortcutFor: (id, fallback) => (id === "edit.undo" ? "Ctrl+U" : id === "edit.redo" ? null : fallback)
    });
    expect(entries.find((entry) => entry.id === "edit.undo")?.shortcut).toBe("Ctrl+U");
    // 解绑的动作不再显示过期提示，其余命令保留内核自报值。
    expect(entries.find((entry) => entry.id === "edit.redo")?.shortcut).toBeNull();
    expect(entries.find((entry) => entry.id === "edit.copy")?.shortcut).toBeNull();
    // 未提供端口时行为不变。
    expect(paletteEntries(commands).find((entry) => entry.id === "edit.undo")?.shortcut).toBe("Cmd+Z");
  });

  it("显示名可换成界面中文标签，英文原样保留为关键字（两种输入都能命中）", () => {
    // 内核命令表自报英文名（Undo/Redo），界面菜单是中文——直接显示英文会让「撤销」搜不到。
    const kernel = new Map<string, PhotocraftCommand>([
      ["edit.undo", command({ id: "edit.undo", label: "Undo", shortcut: "Cmd+Z" })],
      ["edit.redo", command({ id: "edit.redo", label: "Redo", shortcut: "Cmd+Shift+Z" })]
    ]);
    const entries = paletteEntries(kernel, {
      labelFor: (id, fallback) => (id === "edit.undo" ? "撤销" : id === "edit.redo" ? "重做" : fallback)
    });
    // 标题用中文；英文名进关键字。
    expect(entries.find((entry) => entry.id === "edit.undo")?.label).toBe("撤销");
    expect(entries.find((entry) => entry.id === "edit.undo")?.keywords).toContain("Undo");
    // 中文查询命中。
    expect(searchPalette(entries, "撤销").map((hit) => hit.id)).toEqual(["edit.undo"]);
    expect(searchPalette(entries, "重做").map((hit) => hit.id)).toEqual(["edit.redo"]);
    // 英文查询同样命中同一条命令，不会因为换成中文标签而丢失。
    expect(searchPalette(entries, "Undo").map((hit) => hit.id)).toEqual(["edit.undo"]);
    // 未提供端口时沿用内核自报名，行为不变。
    expect(paletteEntries(kernel).find((entry) => entry.id === "edit.undo")?.label).toBe("Undo");
  });
});

describe("空查询与最近使用", () => {
  it("空查询按最近使用列出，跳过已不可用的命令并回退到可用命令", () => {
    const entries = paletteEntries(commands);
    const hits = defaultPaletteHits(entries, ["filter.liquify", "edit.copy", "edit.redo"], 3);
    expect(hits.map((entry) => entry.id)).toEqual(["edit.copy", "edit.redo", "edit.undo"]);
    expect(defaultPaletteHits(entries, [], 2).map((entry) => entry.id)).toEqual(["edit.undo", "edit.redo"]);
  });

  it("最近使用有界、去重、最新在前", () => {
    expect(pushRecent([], "a")).toEqual(["a"]);
    expect(pushRecent(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(pushRecent(["a", "b", "c"], "d", 2)).toEqual(["d", "a"]);
  });
});
