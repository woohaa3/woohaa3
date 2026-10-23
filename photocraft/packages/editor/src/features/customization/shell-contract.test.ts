/**
 * 定制域与共享外壳的契约回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 共享外壳（`photo-editor-chrome.tsx`、`photo-editor-menu.ts`、`photo-editor-app.tsx`）由集成负责人
 * 单写，本域不改它们；但两侧的 id/形状必须对得上，否则接入时会静默失效。这里锁定：
 * - 工具栏顺序只使用 `PHOTO_TOOLS` 里真实存在的工具 id；
 * - 菜单隐藏清单里的命令 id 与可定制动作使用同一个 id（否则隐藏了菜单仍有快捷键、或反之）；
 * - 每个可定制动作都能翻译成共享外壳的 `EditorShortcut` 联合成员。
 */
import { describe, expect, it } from "vitest";
import { PHOTO_TOOLS } from "../../photo-editor-chrome.js";
import { EDITOR_MENUS, editorMenusFor, type EditorMenuItem } from "../../photo-editor-menu.js";
import { TOOL_KEYS } from "../../photo-editor-shortcuts.js";
import { CUSTOMIZATION_ACTIONS, CUSTOMIZATION_TOOL_ACTIONS, defaultPreferences } from "./preferences.js";
import { shortcutForAction, toolbarToolIds } from "./shell-adapter.js";

function leaves(items: readonly EditorMenuItem[]): string[] {
  return items.flatMap((item) => (item.children?.length ? leaves(item.children) : [item.id]));
}

const MENU_IDS = new Set(EDITOR_MENUS.flatMap((menu) => leaves(menu.items)));
const DOCUMENT_MENU_IDS = new Set(editorMenusFor({ onOpenFile: () => {}, onSave: () => {}, saveLabel: "保存" }).flatMap((menu) => leaves(menu.items)));

/** 由固定组合表声明、但不属于某个菜单叶子的动作。 */
const NON_MENU_ACTIONS = new Set([
  "file.save", // 「文件」菜单项 id 由宿主文档能力注入
  "edit.transform", // 菜单里是「自由变换」叶子，id 与其它菜单项一致，见下
  "view.zoomIn", "view.zoomOut", "view.fit", "view.actualSize" // 视图菜单由外壳按 onView 动态生成
]);

describe("工具栏契约", () => {
  it("默认顺序与 PHOTO_TOOLS 一致，隐藏项不影响其它工具", () => {
    const defaultIds = toolbarToolIds(defaultPreferences());
    expect(defaultIds).toEqual(PHOTO_TOOLS.map((tool) => `tool.${tool.id}`));
    expect(new Set(defaultIds).size).toBe(defaultIds.length);
  });

  it("每个工具栏 id 都对应真实工具与按键", () => {
    for (const id of toolbarToolIds(defaultPreferences())) {
      expect(PHOTO_TOOLS.some((tool) => tool.id === id.slice("tool.".length)), id).toBe(true);
      expect(CUSTOMIZATION_TOOL_ACTIONS.find(action => action.id === id)?.defaultChord, id)
        .toBe(TOOL_KEYS[id.slice("tool.".length) as keyof typeof TOOL_KEYS] ?? "");
    }
    expect(CUSTOMIZATION_TOOL_ACTIONS.map((action) => action.id)).toEqual(PHOTO_TOOLS.map((tool) => `tool.${tool.id}`));
  });
});

describe("菜单契约", () => {
  it("可定制命令 id 与菜单叶子 id 一致", () => {
    const commandIds = CUSTOMIZATION_ACTIONS.filter((action) => action.kind === "command").map((action) => action.id);
    for (const id of commandIds) {
      if (NON_MENU_ACTIONS.has(id)) continue;
      expect(MENU_IDS.has(id), id).toBe(true);
    }
  });

  it("宿主文档菜单项也能被隐藏清单引用", () => {
    // 面板里列出的菜单叶子来自 EDITOR_MENUS；宿主额外注入的文件项使用同一 id 空间。
    expect(DOCUMENT_MENU_IDS.has("file.save")).toBe(true);
    expect(DOCUMENT_MENU_IDS.has("file.open")).toBe(true);
  });
});

describe("动作翻译契约", () => {
  it("每个可定制动作都能翻译成共享外壳的分派形状", () => {
    for (const action of CUSTOMIZATION_ACTIONS) {
      const shortcut = shortcutForAction(action.id);
      expect(shortcut, action.id).not.toBeNull();
      // 命令动作必须保留原 id，否则会把 A 命令执行成 B。
      if (action.kind === "command" && !["file.save", "edit.clear", "edit.transform", "layer.createClippingMask", "layer.releaseClippingMask", "view.zoomIn", "view.zoomOut", "view.fit", "view.actualSize"].includes(action.id)) {
        expect(shortcut, action.id).toEqual({ kind: "command", id: action.id });
      }
      if (action.kind === "display") expect(shortcut, action.id).toMatchObject({ kind: "display" });
      if (action.kind === "tool") expect(shortcut, action.id).toMatchObject({ kind: "tool" });
    }
  });
});
