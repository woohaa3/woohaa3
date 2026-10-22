/**
 * 画布菜单 section 规范化契约测试
 * （change: 2026-10-10-add-game-furnace-extension，任务 2.3/2.4/2.5）。
 *
 * 只验证纯计算：section 顺序、组内 order、稳定原序、实际存在边界的稳定分隔线，以及禁用项
 * 不产生空 section/重复分割线。
 */
import { describe, expect, it } from "vitest";
import {
  CANVAS_MENU_SECTION,
  CANVAS_MENU_SECTION_ORDER,
  normalizeCanvasMenuSections,
  type CanvasMenuItemSpec
} from "./menu-sections.js";

/** 显式类型化输入：返回项携带规范化的 `separatorBefore`。 */
function normalize(items: CanvasMenuItemSpec[]): CanvasMenuItemSpec[] {
  return normalizeCanvasMenuSections(items);
}

describe("画布菜单 section 规范化（任务 2.3）", () => {
  it("section 顺序稳定：基础素材 → 创作工具 → 其他", () => {
    expect(CANVAS_MENU_SECTION_ORDER).toEqual(["basic-material", "creation-tools", "other"]);
    const normalized = normalize([
      { id: "upload", label: "上传…", section: CANVAS_MENU_SECTION.other },
      { id: "animation3d", label: "导演场", section: CANVAS_MENU_SECTION.creationTools, order: 0 },
      { id: "image", label: "图片", section: CANVAS_MENU_SECTION.basicMaterial },
      { id: "furnace", label: "游戏炼丹炉", section: CANVAS_MENU_SECTION.creationTools, order: 1 }
    ]);
    expect(normalized.map((item) => item.id)).toEqual(["image", "animation3d", "furnace", "upload"]);
    // 导演场与炼丹炉相邻且同组（创作工具），上传仍在其他操作组。
    expect(normalized.find((item) => item.id === "animation3d")!.section).toBe(CANVAS_MENU_SECTION.creationTools);
    expect(normalized.find((item) => item.id === "furnace")!.section).toBe(CANVAS_MENU_SECTION.creationTools);
  });

  it("组内 order 优先，未声明 order 保持贡献顺序", () => {
    const normalized = normalize([
      { id: "b", label: "b", section: CANVAS_MENU_SECTION.basicMaterial },
      { id: "a", label: "a", section: CANVAS_MENU_SECTION.basicMaterial },
      { id: "ordered", label: "o", section: CANVAS_MENU_SECTION.basicMaterial, order: -1 }
    ]);
    expect(normalized.map((item) => item.id)).toEqual(["ordered", "b", "a"]);
  });

  it("只在实际存在的 section 边界插入分隔线；首项无前置分隔线", () => {
    const normalized = normalize([
      { id: "image", label: "图片", section: CANVAS_MENU_SECTION.basicMaterial },
      { id: "text", label: "文本", section: CANVAS_MENU_SECTION.basicMaterial },
      { id: "furnace", label: "游戏炼丹炉", section: CANVAS_MENU_SECTION.creationTools },
      { id: "upload", label: "上传…", section: CANVAS_MENU_SECTION.other }
    ]);
    expect(normalized[0]!.separatorBefore).not.toBe(true);
    expect(normalized[1]!.separatorBefore).not.toBe(true);
    // 基础素材 → 创作工具边界、创作工具 → 其他边界各一条。
    expect(normalized[2]!.separatorBefore).toBe(true);
    expect(normalized[3]!.separatorBefore).toBe(true);
  });

  it("禁用/缺失 extension 时不产生空 section 或多余分隔线", () => {
    // 只有基础素材与上传（创作工具整体缺失）：不出现空 section 边界。
    const normalized = normalize([
      { id: "image", label: "图片", section: CANVAS_MENU_SECTION.basicMaterial },
      { id: "upload", label: "上传…", section: CANVAS_MENU_SECTION.other }
    ]);
    expect(normalized).toHaveLength(2);
    expect(normalized.filter((item) => item.separatorBefore === true)).toHaveLength(1);
    expect(normalized[1]!.separatorBefore).toBe(true);
  });

  it("未声明 section 的项归入 other；显式 separatorBefore 被保留", () => {
    const normalized = normalize([
      { id: "legacy", label: "旧项" },
      { id: "upload", label: "上传…", section: CANVAS_MENU_SECTION.other, separatorBefore: true }
    ]);
    // 两项都在 other：按稳定原序，且显式分隔线保留。
    expect(normalized.map((item) => item.id)).toEqual(["legacy", "upload"]);
    expect(normalized[1]!.separatorBefore).toBe(true);
  });

  it("不修改输入项（纯函数返回新数组）", () => {
    const input = [{ id: "a", label: "a", section: CANVAS_MENU_SECTION.other }];
    const normalized = normalize(input);
    expect(normalized).not.toBe(input);
    expect(input[0]).toEqual({ id: "a", label: "a", section: CANVAS_MENU_SECTION.other });
  });

  it("未知 section 排在 known section 之后，稳定排序", () => {
    const normalized = normalize([
      { id: "future", label: "未来", section: "brand-new" },
      { id: "image", label: "图片", section: CANVAS_MENU_SECTION.basicMaterial }
    ]);
    expect(normalized.map((item) => item.id)).toEqual(["image", "future"]);
  });
});
