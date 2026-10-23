import { expect, it } from "vitest";
import {
  feature,
  RETOUCH_ADDED_TOOLS,
  RETOUCH_ALL_TOOLS,
  RETOUCH_COMMANDS,
  RETOUCH_MENU_TOOLS,
  RETOUCH_PANEL_TOOLS,
  RETOUCH_TOOLS
} from "./index.js";
import { regionGestureKind } from "./region-gesture.js";
import { cloneOverlayCorners } from "./clone-overlay.js";

it("keeps the shared tool list and menu grouping stable while adding retouch options", () => {
  // 共享画布按工具 id 分派手势，`boundaries.test.ts` 断言完整工具清单；新增能力不得改变它。
  expect(feature.tools.map((tool) => tool.id)).toEqual(["clone", "heal", "retouch"]);
  expect(feature.tools.every((tool) => tool.gesture === "stroke")).toBe(true);
  // 仍然只有一个「滤镜」菜单项：区域命令与仿制源在面板内部切换，不新增加画布工具。
  expect(feature.sections.map((section) => section.id)).toEqual(["retouch"]);
  expect(feature.sections.map((section) => section.menu)).toEqual(["窗口"]);
  expect(feature.sections.map((section) => section.placement)).toEqual(["advanced"]);
});

it("exposes the new stroke tools from the domain panel module only", () => {
  // 共享上下文栏的下拉长度被共享测试锁定；新增笔迹工具由本域面板自己的清单提供。
  expect(RETOUCH_TOOLS.map((tool) => tool.id)).toEqual([
    "paint.cloneStamp",
    "paint.healingBrush",
    "paint.spotHealing",
    "paint.blur",
    "paint.sharpen",
    "paint.smudge",
    "paint.dodge",
    "paint.burn",
    "paint.sponge"
  ]);
  expect(RETOUCH_ADDED_TOOLS.map((tool) => tool.id)).toEqual(["paint.patternStamp", "paint.historyBrush", "paint.remove"]);
  // 完整下拉 = 原 9 项 + 新增 3 项，顺序保持「原有项在前」，集成时只需把 slice 换成这一份。
  expect(RETOUCH_ALL_TOOLS.map((tool) => tool.id)).toEqual([
    ...RETOUCH_TOOLS.map((tool) => tool.id),
    ...RETOUCH_ADDED_TOOLS.map((tool) => tool.id)
  ]);
  expect(feature.panels.RetouchPanel).toBeDefined();
});

it("exposes the integration ports the shared single-writer files need", () => {
  // 共享外壳要接线时必须能拿到本域的几何/叠加入口，而不是在共享文件里再写一遍规则。
  expect(typeof regionGestureKind).toBe("function");
  expect(typeof cloneOverlayCorners).toBe("function");
  // 画布手势分类：修补/移动是拖动，红眼是点选。
  expect(RETOUCH_COMMANDS.filter((entry) => entry.gesture === "region").map((entry) => entry.id))
    .toEqual(["paint.patch", "paint.contentAwareMove", "paint.redEye"]);
  expect(regionGestureKind("paint.patch")).toBe("drag");
  expect(regionGestureKind("paint.redEye")).toBe("click");
});

it("上下文栏下拉是唯一真值：13 项含新增笔迹工具与区域命令", () => {
  // 区域命令**必须**和下笔迹工具在同一个下拉里：画布手势按当前命令分派（笔迹 → 逐帧预览，
  // 区域 → 拖动/单击生成候选）。若区域命令只在面板里另有一个选择器，画布的拖动分支就是死代码，
  // 面板选的命令和画布拖动各说各话（真实走查发现的缺陷）。
  const dropdown = RETOUCH_MENU_TOOLS.map((tool) => tool.id);
  expect(dropdown).toContain("paint.patternStamp");
  expect(dropdown).toContain("paint.historyBrush");
  expect(dropdown).toContain("paint.remove");
  expect(dropdown).toEqual([
    "paint.spotHealing",
    "paint.blur",
    "paint.sharpen",
    "paint.smudge",
    "paint.dodge",
    "paint.burn",
    "paint.sponge",
    "paint.patternStamp",
    "paint.historyBrush",
    "paint.remove",
    "paint.patch",
    "paint.contentAwareMove",
    "paint.redEye"
  ]);
  // 区域命令不新增画布工具 id：它们由区域手势入口与面板共用同一个 `retouchTool`。
  expect(RETOUCH_COMMANDS.filter((entry) => entry.gesture === "region").map((entry) => entry.id))
    .toEqual(["paint.patch", "paint.contentAwareMove", "paint.redEye"]);
  // 下拉最后一组顺序与区域命令清单一致，避免两处各自维护顺序。
  expect(dropdown.slice(-3)).toEqual(["paint.patch", "paint.contentAwareMove", "paint.redEye"]);
});

it("高级面板入口的工具清单覆盖下拉，并且不改变共享下拉本身", () => {
  // 「滤镜 → 修饰工具…」是第二条入口：没有工具栏上下文，所以还要能选仿制图章/修复画笔。
  // 但共享下拉（上下文栏）不能因此多出两项——那里它们已经是独立工具按钮。
  const panel = RETOUCH_PANEL_TOOLS.map((tool) => tool.id);
  expect(panel).toEqual(["paint.cloneStamp", "paint.healingBrush", ...RETOUCH_MENU_TOOLS.map((tool) => tool.id)]);
  expect(RETOUCH_MENU_TOOLS.map((tool) => tool.id)).not.toContain("paint.cloneStamp");
  expect(RETOUCH_MENU_TOOLS.map((tool) => tool.id)).not.toContain("paint.healingBrush");
});
