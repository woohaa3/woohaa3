/**
 * 「文件」菜单接线回归
 * （change: 2026-10-22-add-photocraft-file-workflows，U01 / U03）。
 *
 * 这里只验证菜单项的**存在与目标**：批量关闭是工作区操作（上游内核只有单文档
 * `file.close`），新建要能落到独立文档槽位。菜单没有对应能力时不得渲染死项。
 */
import { describe, expect, it } from "vitest";
import { editorMenusFor, type EditorDocumentsMenu } from "./photo-editor-menu.js";

const fileMenu = (documents?: EditorDocumentsMenu) =>
  editorMenusFor(documents).find((menu) => menu.label === "文件");

const ids = (documents?: EditorDocumentsMenu) => (fileMenu(documents)?.items ?? []).map((item) => item.id);

describe("文件菜单", () => {
  it("没有文档菜单能力时不渲染「文件」菜单", () => {
    expect(fileMenu()).toBeUndefined();
    expect(ids({})).toEqual([]);
  });

  it("只提供已接通的动作，不留死项", () => {
    // 只有「打开文件」：菜单里就只出现它，不猜测别的能力。
    expect(ids({ onOpenFile: () => undefined })).toEqual(["file.open"]);
  });

  it("新建与打开并列出现在最前，新建不依赖已有文档", () => {
    const items = ids({ onNewDocument: () => undefined, onOpenFile: () => undefined });
    expect(items.slice(0, 2)).toEqual(["file.new", "file.open"]);
    // 新建是唯一在「没有文档」时也要可用的入口：它不能排在会禁用整个菜单的位置之后。
    expect(fileMenu({ onNewDocument: () => undefined })?.items[0]?.label).toBe("新建…");
  });

  it("关闭全部/其他作为工作区操作出现在关闭之后", () => {
    const items = ids({
      onCloseDocument: () => undefined,
      onCloseOthers: () => undefined,
      onCloseAll: () => undefined
    });
    expect(items.slice(-3)).toEqual(["file.close", "file.closeOthers", "file.closeAll"]);
  });

  it("批量关闭缺能力时不渲染对应项（不显示点了没反应的入口）", () => {
    expect(ids({ onCloseDocument: () => undefined })).toEqual(["file.close"]);
    expect(ids({ onCloseAll: () => undefined })).toEqual(["file.closeAll"]);
    expect(ids({ onCloseOthers: () => undefined })).toEqual(["file.closeOthers"]);
  });
});
