/**
 * 工具栏槽位结构门禁（change: refactor-photocraft-toolbar，design D6）。
 *
 * 比较对象是 `tests/fixtures/toolbar-slots.json` —— 从上游
 * `crates/ui-egui/src/panels.rs::TOOL_SECTIONS` 手工抄录的独立数据，不是被测注册表本身。
 * 这样「命令全通但槽位分组错」会在这里失败，而不是靠人眼在浏览器里发现。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TOOL_SLOTS, toolbarMembers, toolGroups, visibleToolSections, visibleToolSlots
} from "./toolbar-slots.js";

type FixtureMember = { name: string; key: string | null; cycleOrder: number };
type Fixture = { sections: { section: number; slots: { index: number; members: FixtureMember[] }[] }[] };

const fixture = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/toolbar-slots.json", import.meta.url), "utf8")
) as Fixture;

const fixtureSlots = fixture.sections.flatMap(section => section.slots);

describe("工具栏槽位注册表与上游一致", () => {
  it("段数、槽数与槽索引与上游完全相同", () => {
    expect(TOOL_SLOTS.map(slot => slot.index)).toEqual(fixtureSlots.map(slot => slot.index));
    expect(new Set(TOOL_SLOTS.map(slot => slot.section))).toEqual(new Set(fixture.sections.map(section => section.section)));
    expect(TOOL_SLOTS).toHaveLength(fixtureSlots.length);
  });

  it("每个槽的成员顺序、上游枚举名、组键与循环序与上游完全相同", () => {
    const actual = TOOL_SLOTS.map(slot => slot.members.map(member => ({
      name: member.upstream, key: member.key, cycleOrder: member.cycleOrder
    })));
    const expected = fixtureSlots.map(slot => slot.members);
    expect(actual).toEqual(expected);
  });

  it("段内槽位顺序与上游相同（段号非递减、段内按槽索引递增）", () => {
    let previousSection = 0;
    let previousIndex = -1;
    for (const slot of TOOL_SLOTS) {
      if (slot.section !== previousSection) {
        expect(slot.section).toBeGreaterThan(previousSection);
        previousSection = slot.section;
        previousIndex = -1;
      }
      expect(slot.index).toBeGreaterThan(previousIndex);
      previousIndex = slot.index;
    }
  });

  it("成员总数等于上游 Tool::ALL 的 67 项，且上游枚举名不重复", () => {
    const names = TOOL_SLOTS.flatMap(slot => slot.members.map(member => member.upstream));
    expect(names).toHaveLength(67);
    expect(new Set(names).size).toBe(67);
  });
});

describe("投影只省略未开放成员", () => {
  it("投影后的段数与槽数符合盘点文档的 5 段 16 槽", () => {
    const sections = visibleToolSections();
    expect(sections.map(section => section.section)).toEqual([1, 2, 3, 4, 5]);
    expect(sections.map(section => section.slots.length)).toEqual([1, 4, 8, 1, 2]);
    expect(visibleToolSlots()).toHaveLength(16);
  });

  it("每槽可见成员恰好是上游成员里没有未开放理由的那些", () => {
    for (const slot of TOOL_SLOTS) {
      const expected = slot.members.filter(member => member.unsupported === undefined).map(member => member.upstream);
      const projected = visibleToolSlots().find(candidate => candidate.index === slot.index);
      expect(projected?.members.map(member => member.upstream) ?? []).toEqual(expected);
    }
  });

  it("未开放槽整槽消失，而不是留空占位", () => {
    const projected = new Set(visibleToolSlots().map(slot => slot.index));
    // 槽 4（裁剪族）与槽 5（Frame）、15/17/18（路径与形状）全部未开放。
    for (const index of [4, 5, 15, 17, 18]) {
      expect(projected.has(index)).toBe(false);
    }
    for (const slot of visibleToolSlots()) {
      expect(slot.members.length).toBeGreaterThan(0);
    }
  });

  it("多成员槽位与单成员槽位的划分符合工具盘点的 8 个 flyout", () => {
    const multi = visibleToolSlots().filter(slot => slot.members.length > 1).map(slot => slot.index);
    expect(multi).toEqual([1, 7, 8, 9, 11, 13, 14, 16]);
    const single = visibleToolSlots().filter(slot => slot.members.length === 1).map(slot => slot.index);
    expect(single).toEqual([0, 2, 3, 6, 10, 12, 19, 20]);
  });

  it("投影后是 16 个槽位按钮、32 个成员、28 个工具 id，且画笔与铅笔同槽", () => {
    expect(visibleToolSlots()).toHaveLength(16);
    expect(toolbarMembers()).toHaveLength(32);
    // 变体成员共用工具 id：选框 4 个变体、文字 2 个变体，共 6 个变体成员。
    expect(toolbarMembers().filter(member => member.variant).length).toBe(6);
    expect(new Set(toolbarMembers().map(member => member.tool)).size).toBe(28);
    const brushSlot = visibleToolSlots().find(slot => slot.members.some(member => member.tool === "brush"));
    expect(brushSlot?.members.map(member => member.tool)).toEqual(["brush", "pencil", "mixer", "colorReplacement"]);
  });
});

describe("每个未开放成员都写明理由", () => {
  it("理由非空且指出产品或平台原因，不是占位词", () => {
    const shut = TOOL_SLOTS.flatMap(slot => slot.members).filter(member => member.unsupported !== undefined);
    expect(shut.length).toBe(67 - 32);
    for (const member of shut) {
      expect(member.unsupported?.trim().length ?? 0).toBeGreaterThan(4);
      expect(member.unsupported).not.toMatch(/^todo|待补|tbd/i);
      expect(member.unsupported).toMatch(/需要|依赖|未开放|未实现|属关闭|未协商/);
    }
  });

  it("未开放成员不进入工具栏、命令面板与字母组", () => {
    const visibleIds = new Set(toolbarMembers().map(member => member.id));
    const groups = [...toolGroups().values()].flat().map(entry => entry.id);
    const shut = TOOL_SLOTS.flatMap(slot => slot.members).filter(member => member.unsupported !== undefined);
    for (const member of shut) {
      // 未开放成员即使是变体（如椭圆选框）也不在可见成员里 —— 椭圆由矩形槽的变体承载。
      if (member.variant) continue;
      expect(visibleIds.has(member.id)).toBe(false);
      expect(groups).not.toContain(member.id);
    }
    expect(visibleIds.size).toBe(32);
  });
});

describe("字母分组按循环序而不是 flyout 序", () => {
  it("给出 15 个字母，其中 7 个多成员组", () => {
    const groups = toolGroups();
    expect([...groups.keys()].sort()).toEqual(["B", "E", "G", "H", "I", "J", "L", "M", "O", "S", "T", "V", "W", "Y", "Z"]);
    expect([...groups].filter(([, list]) => list.length > 1).map(([key]) => key).sort()).toEqual(["B", "E", "J", "M", "O", "S", "T"]);
  });

  it("T 组按 Tool::ALL 序登记已开放的横排与竖排（蒙版未开放，不登记）", () => {
    expect(toolGroups().get("T")?.map(member => member.upstream)).toEqual(["Type", "VerticalType"]);
  });

  it("M 组只有矩形与椭圆，单行与单列不参与任何字母组", () => {
    expect(toolGroups().get("M")?.map(member => member.upstream)).toEqual(["RectMarquee", "EllipseMarquee"]);
    const keyed = [...toolGroups().values()].flat().map(member => member.upstream);
    expect(keyed).not.toContain("SingleRowMarquee");
    expect(keyed).not.toContain("SingleColumnMarquee");
  });

  it("模糊族没有组键", () => {
    const keyed = [...toolGroups().values()].flat().map(member => member.upstream);
    for (const name of ["Blur", "Sharpen", "Smudge"]) expect(keyed).not.toContain(name);
  });

  it("W 组只登记已开放的魔棒（对象/快速选择未开放）", () => {
    expect(toolGroups().get("W")?.map(member => member.upstream)).toEqual(["MagicWand"]);
  });
});
