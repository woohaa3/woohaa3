/**
 * 域装配的回归（change: 2026-10-22-add-photocraft-raster-interchange）。
 *
 * 锁定本域贡献的形状：只有一个面板入口、挂在「图像」菜单、不注册工具、不冒充能力开放。
 * 真正的「文件 ▸ 导出 / Save for Web」菜单项由共享/宿主菜单拥有，见 `sections.tsx` 的说明。
 *
 * 这里断言的是**共享装配读到的结果**（`featureMenuSections` / `FEATURE_PANELS`）：
 * dev 与 Woohaa 都经 `PhotoEditorApp` → 这两个导出渲染菜单与面板，因此它们消费的是同一份注册，
 * 不需要各自的接线代码。是否真的出现在窗口里仍需人工界面验收（tasks 4.2）。
 */
import { expect, it } from "vitest";
import { feature } from "./index.js";
import { sections } from "./sections.js";
import { FEATURE_PANELS, FEATURE_SECTIONS, featureMenuSections } from "../index.js";
import { InterchangePanel } from "./panels.js";
import { editorMenusFor } from "../../photo-editor-menu.js";

it("本域只贡献一个格式与导出入口，不注册画布工具", () => {
  expect(feature.id).toBe("io");
  expect(feature.tools).toEqual([]);
  expect(sections.map((section) => section.id)).toEqual(["interchange"]);
  expect(sections[0]).toMatchObject({ menu: "图像", placement: "advanced", label: "格式与导出…" });
  expect(feature.panels).toHaveProperty("InterchangePanel");
});

it("面板入口不占用共享菜单里已有的名字，避免与宿主条目撞名", () => {
  expect(sections[0]!.id).not.toBe("export");
  expect(sections[0]!.id).not.toBe("saveForWeb");
});

it("共享装配把本域入口挂进「图像」菜单，并指向本域面板", () => {
  const menu = featureMenuSections("图像").map((section) => section.id);
  expect(menu).toContain("interchange");
  // 菜单按 menuOrder 排序：直方图(1) → 调整(0) 之外，本域排在「画布构图」(2) 之后。
  expect(menu.indexOf("interchange")).toBeGreaterThan(menu.indexOf("compose"));
  expect(FEATURE_SECTIONS.filter((section) => section.id === "interchange")).toHaveLength(1);
  expect(FEATURE_PANELS.InterchangePanel).toBe(InterchangePanel);
});

it("「文件」菜单能挂出通用导出与 Save for Web 两个入口，且顺序在导出 PNG 之后", () => {
  // 共享菜单由宿主注入回调；有回调才出条目，没有就不出死菜单项。
  const without = editorMenusFor({} as never).find((menu) => menu.label === "文件");
  expect(without).toBeUndefined();
  const menus = editorMenusFor({
    onSave: () => {},
    saveLabel: "保存",
    onExportPng: () => {},
    onExportRaster: () => {},
    onExportWeb: () => {}
  });
  const file = menus.find((menu) => menu.label === "文件")!;
  const ids = file.items.map((item) => item.id);
  expect(ids).toContain("file.exportRaster");
  expect(ids).toContain("file.exportWeb");
  // PNG 是固定格式快捷导出，通用导出/Save for Web 排在它之后。
  expect(ids.indexOf("file.exportRaster")).toBeGreaterThan(ids.indexOf("file.exportPng"));
  expect(ids.indexOf("file.exportWeb")).toBe(ids.indexOf("file.exportRaster") + 1);
  expect(file.items.find((item) => item.id === "file.exportRaster")?.label).toBe("导出为…");
  expect(file.items.find((item) => item.id === "file.exportWeb")?.label).toBe("Save for Web…");
});
