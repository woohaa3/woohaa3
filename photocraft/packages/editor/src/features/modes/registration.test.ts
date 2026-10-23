import { expect, it } from "vitest";
import { FEATURE_SECTIONS, EDITOR_FEATURES, featureMenuSections } from "../index.js";
import { feature } from "./index.js";
import { sections } from "./sections.js";

/**
 * 入口发布回归（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.4 / 5.1）。
 *
 * 面板、内核入口、内容身份、能力发布与原生核验都已接通，因此菜单入口**已注册**。这条用例
 * 锁定入口确实挂在「图像」菜单下、且与共享装配一一对应；同时保证工具清单仍为空（模式转换
 * 不是手势，工具可用性由 `mode-data` 矩阵解释并由内核门禁执行）。
 */

it("publishes the mode panel under the Image menu", () => {
  expect(feature.id).toBe("modes");
  expect(sections).toHaveLength(1);
  expect(feature.sections).toBe(sections);

  const [section] = sections;
  expect(section).toMatchObject({ id: "modes", menu: "图像", placement: "advanced", label: "模式与颜色表…" });
  expect(typeof section.render).toBe("function");

  // 共享装配必须真的收集到它，否则菜单里点不到。
  expect(FEATURE_SECTIONS.map(entry => entry.id)).toContain("modes");
  expect(featureMenuSections("图像").map(entry => entry.id)).toContain("modes");
  const modes = EDITOR_FEATURES.find(entry => entry.id === "modes")!;
  expect(modes.sections).toBe(sections);
});

it("keeps mode conversion out of the gesture tool list", () => {
  // 模式转换是菜单动作，不是画笔/选区手势；工具矩阵由 mode-data 解释，写入限制由内核门禁执行。
  expect(feature.tools).toEqual([]);
  expect(typeof feature.panels.ModesPanel).toBe("function");
});
