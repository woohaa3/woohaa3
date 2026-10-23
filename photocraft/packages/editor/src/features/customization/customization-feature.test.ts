/**
 * 定制域静态贡献回归（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization）。
 *
 * 本域只贡献一个高级面板 section 与面板组件，不新增工具、不新增内核命令：
 * - 菜单入口挂在共享外壳已渲染的菜单上（「编辑 ▸ 工作区、快捷键与命令搜索…」）；
 * - `窗口` 菜单入口需要共享外壳改动，属集成负责人范围；
 * - 共享基线测试 `features/boundaries.test.ts` 仍按「本域为空」断言，集成时需同步。
 */
import { describe, expect, it } from "vitest";
import { FEATURE_PANELS, FEATURE_SECTIONS, featureMenuSections } from "../index.js";
import { feature } from "./index.js";
import { sections } from "./sections.js";
import { WorkspaceCustomizationPanel } from "./panels.js";

describe("定制域贡献", () => {
  it("只登记一个面板 section，不新增工具", () => {
    expect(feature.id).toBe("customization");
    expect(feature.tools).toEqual([]);
    expect(feature.sections).toHaveLength(1);
    expect(feature.sections).toBe(sections);
    expect(feature.panels.WorkspaceCustomizationPanel).toBe(WorkspaceCustomizationPanel);
  });

  it("section 出现在共享装配里，并能从已渲染的菜单取到入口", () => {
    // 共享装配是唯一入口：面板与菜单项都由 FEATURE_SECTIONS / featureMenuSections 派生。
    expect(FEATURE_SECTIONS.filter((section) => section.id === "customization")).toHaveLength(1);
    expect(FEATURE_PANELS.WorkspaceCustomizationPanel).toBe(WorkspaceCustomizationPanel);
    expect(featureMenuSections("窗口").map((section) => section.id)).toContain("customization");
    // 入口按设计落在「窗口」菜单（窗口 → 工作区 / 工具栏 / 快捷键与命令搜索）。
    expect(sections[0].menu).toBe("窗口");
  });

  it("section 有稳定 id、菜单归属与顺序，且不占用其它域 id", () => {
    const [section] = sections;
    expect(section).toMatchObject({
      id: "customization",
      placement: "advanced",
      menu: "窗口",
      label: "工作区、快捷键与命令搜索…",
      order: 12
    });
    expect(section.menuOrder).toBeGreaterThan(0);
  });

  it("section 渲染自带隐藏规则，避免与其它高级面板同时出现", () => {
    const tree = sections[0].render({
    readonly: false,

      controller: {
        snapshot: () => ({ commands: new Map() }),
        dispatch: () => ({ ok: false, code: "no-document", message: "未打开文档" })
      },
      locked: true,
      documentView: undefined,
      activeLayer: undefined,
      activeLayerId: null,
      colors: { foreground: "#000000" },
      brush: { color: "#000000" },
      refreshPreview: () => {},
      updateAids: () => {},
      retouchTool: "paint.spotHealing",
      retouchSample: null,
      retouchAligned: true,
      setRetouchAligned: () => {},
      setMessage: () => {}
      // 面板只读取上面的最小面；其余字段由共享装配补齐。
    } as unknown as Parameters<typeof sections[0]["render"]>[0]);
    const text = JSON.stringify(tree);
    expect(text).toContain('data-advanced-section":"customization"');
    expect(text).toContain("data-feature]:not([data-feature=\\\"customization\\\"])");
  });
});
