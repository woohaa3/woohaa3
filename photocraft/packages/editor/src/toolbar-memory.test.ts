/**
 * 工具栏记忆与组切换语义（change: refactor-photocraft-toolbar，design D4/D5）。
 *
 * 这里验证的是「选择动作 → 两张记忆表与当前工具一致」与「字母键按组语义推进」，
 * 不渲染 App：App 的装配由 DOM 回归覆盖。
 */
import {describe,expect,it} from "vitest";
import {memberIdFor,slotOf,toolGroups} from "./toolbar-slots.js";
import {decodeGroupMemory,decodeSlotMemory} from "./tool-option-memory.js";

/** 复刻 App 的组切换：现成员在组内时按 `cycle` 前进或原地；否则回组内记忆或组首。 */
function resolveGroup(key: string, tool: string, variant: string | undefined, cycle: boolean, memory: Record<string, string>) {
  const group = toolGroups().get(key) ?? [];
  if (!group.length) return undefined;
  const currentId = memberIdFor(tool as never, variant);
  const current = group.findIndex(member => member.id === currentId);
  if (current >= 0) return cycle ? group[(current + 1) % group.length]! : group[current]!;
  return group.find(member => member.id === memory[key]) ?? group[0]!;
}

describe("每槽记忆", () => {
  it("画笔槽选铅笔后，切到移动再回来仍显示铅笔", () => {
    const memory: Record<string, string> = {};
    // 用户在画笔槽选铅笔。
    memory["8"] = "pencil";
    // 切到移动工具：槽 0 记录移动，槽 8 不变。
    memory["0"] = "move";
    expect(memory["8"]).toBe("pencil");
    const slot = slotOf("brush")!;
    expect(slot.members.find(member => member.id === memory[String(slot.index)])?.tool).toBe("pencil");
  });

  it("记忆只保存合法槽键与成员 id，损坏项被丢弃", () => {
    expect(decodeSlotMemory({"8": "pencil", "0": "move", bad: "pencil", "9": "", "10": 42, "11": "x".repeat(80)}))
      .toEqual({"8": "pencil", "0": "move"});
    expect(decodeSlotMemory(null)).toEqual({});
    expect(decodeSlotMemory(["pencil"])).toEqual({});
  });

  it("组记忆只保存单字母键", () => {
    expect(decodeGroupMemory({B: "pencil", M: "marquee", bb: "brush", "1": "move"})).toEqual({B: "pencil", M: "marquee"});
    expect(decodeGroupMemory({B: 42})).toEqual({});
  });

  it("槽位记忆与组记忆是两张表：槽索引与组字母不会互相覆盖", () => {
    const slots = decodeSlotMemory({"8": "pencil"});
    const groups = decodeGroupMemory({B: "pencil"});
    expect(slots).toEqual({"8": "pencil"});
    expect(groups).toEqual({B: "pencil"});
  });
});

describe("组切换语义", () => {
  it("Shift 偏好开启：组内按 Shift 前进到下一个成员", () => {
    expect(resolveGroup("B", "brush", undefined, true, {})?.id).toBe("pencil");
    expect(resolveGroup("B", "pencil", undefined, true, {})?.id).toBe("mixer");
    expect(resolveGroup("B", "colorReplacement", undefined, true, {})?.id).toBe("brush");
  });

  it("Shift 偏好开启：组内不按 Shift 原地不动", () => {
    expect(resolveGroup("B", "pencil", undefined, false, {})?.id).toBe("pencil");
  });

  it("M 组只在矩形与椭圆之间循环，不进入单行/单列", () => {
    expect(resolveGroup("M", "marquee", "rectangle", true, {})?.id).toBe("ellipseMarquee");
    expect(resolveGroup("M", "marquee", "ellipse", true, {})?.id).toBe("rectMarquee");
    // 单行/单列虽然是槽位成员，但不在 M 组里，按键后回到组内成员。
    expect(resolveGroup("M", "marquee", "row", true, {})?.id).toBe("rectMarquee");
  });

  it("T 组在横排与竖排之间循环", () => {
    expect(resolveGroup("T", "text", "horizontal", true, {})?.id).toBe("verticalType");
    expect(resolveGroup("T", "text", "vertical", true, {})?.id).toBe("horizontalType");
  });

  it("从组外按键回到该组上次所用工具，无记录则取组首", () => {
    expect(resolveGroup("B", "move", undefined, false, {B: "mixer"})?.id).toBe("mixer");
    expect(resolveGroup("B", "move", undefined, false, {})?.id).toBe("brush");
    // 记忆里的工具已经不在组里（例如支持范围变了）：回落到组首。
    expect(resolveGroup("B", "move", undefined, false, {B: "historyBrush"})?.id).toBe("brush");
  });

  it("无组键的工具不会被任何字母组解析出来", () => {
    expect(toolGroups().get("Blur")).toBeUndefined();
    for (const [key, members] of toolGroups()) {
      for (const member of members) {
        expect(["blur", "sharpen", "smudge", "singleRowMarquee", "singleColumnMarquee"]).not.toContain(member.id);
      }
      expect(key).toMatch(/^[A-Z]$/);
    }
  });

  it("每个组的成员按循环序（Tool::ALL 下标）递增", () => {
    for (const members of toolGroups().values()) {
      const order = members.map(member => member.cycleOrder);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }
  });
});
