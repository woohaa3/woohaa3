import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { describe, expect, it } from "vitest";
import {
  GROUP_BADGE_ANCHOR_OFFSET,
  groupBadgeBounds,
  groupBadgeOutset,
  groupBadgeRect,
  groupBadgeScreenRect
} from "./group-badge.js";
import { createEmptyWoohaa3ServerCanvas, sanitizeWoohaa3CanvasNodeData } from "./domain/index.js";
import { filmSetGroupBadgePlacement, groupModelProjection, modelUnit } from "./model-focus/model-bounds.js";
import { FILM_SET_GROUP_WIDTH_MARGIN } from "./model-focus/types.js";
import { buildCanvasRenderScene } from "./render-scene.js";
import type { SceneV2Op } from "./scene-ir-v2.js";
import type { Vec3 } from "./model-transform.js";

const V2 = "woohaa-model-scene-ir-v2";
const boxV2 = (size: Vec3): SceneV2Op =>
  ({ t: "box", id: `b-${size.join()}`, parent: null, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size, color: "#ffffff" }) as SceneV2Op;

const model = (size: Vec3, scale = 1) => ({
  sceneVersion: V2,
  ops: [boxV2(size)],
  extent: 2,
  placement: { offset: { x: 0, y: 0, z: 0 }, scale, yaw: 0 }
});

describe("组徽标几何（模型投影派生）", () => {
  // 组布局留白已随 canvas-grouping-redesign 收紧到 12，而片场取景边距仍是 40：
  // 两者不再同源（合并 origin/main 时有意脱钩），这里只锁住取景边距本身。
  it("片场取景边距固定为每侧 40 画布单位", () => {
    expect(FILM_SET_GROUP_WIDTH_MARGIN).toBe(40);
  });

  it("单位与普通模型卡片一致：同一模型在组徽标和卡片上的投影尺寸相同", () => {
    const input = model([2, 1, 1], 1.5);
    const projection = groupModelProjection(input)!;
    expect(projection).not.toBeNull();
    // 卡片单位就是画布共享模型单位，组徽标不再有 fit 或展示倍率。
    expect(modelUnit(input.placement, input.extent)).toBe((1.5 * 64 * 3) / 2);
    const unit = modelUnit(input.placement, input.extent);
    // 徽标只由该单位派生：放大 placement.scale 时投影等比放大，没有 56×44 上限。
    const bigger = groupModelProjection(model([2, 1, 1], 3))!;
    expect(bigger.width).toBeCloseTo(projection.width * 2, 5);
    expect(bigger.height).toBeCloseTo(projection.height * 2, 5);
    expect(projection.width).toBeGreaterThan(0);
    expect(unit).toBeGreaterThan(0);
  });

  it("锚点固定于组底边下方 40 画布单位，与模型尺寸无关", () => {
    const rect = { x: 100, y: 200, width: 600, height: 400 };
    for (const projection of [{ width: 20, height: 10 }, { width: 800, height: 1600 }, { width: 88, height: 64 }]) {
      const badge = groupBadgeRect(rect, projection)!;
      expect(badge.center).toEqual({
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height + GROUP_BADGE_ANCHOR_OFFSET
      });
      expect(badge.width).toBe(projection.width);
      expect(badge.height).toBe(projection.height);
    }
  });

  it("片场组按组内容宽度取景，普通组仍用共享单位", () => {
    const input = model([2, 1, 1], 1);
    const natural = groupModelProjection(input)!;
    const fittedPlacement = filmSetGroupBadgePlacement(input, 1000)!;
    const fitted = groupModelProjection({ ...input, placement: fittedPlacement })!;
    // 左右各留 FILM_SET_GROUP_WIDTH_MARGIN = 40；只改展示 placement，不写回原对象。
    expect(fitted.width).toBeCloseTo(1000 - 80, 5);
    expect(fittedPlacement.scale).toBeCloseTo((1000 - 80) / natural.width, 5);
    expect(input.placement.scale).toBe(1);
    expect(fittedPlacement.yaw).toBe(input.placement.yaw);
    // 普通组不调用这个 helper，投影仍按共享单位。
    expect(natural.width).toBeLessThan(fitted.width);
  });

  it("片场组 placement 缺省时仍按组宽取景，不退回共享单位", () => {
    const input = { ...model([2, 1, 1], 1), placement: null };
    const natural = groupModelProjection({ ...input, placement: null })!;
    const fittedPlacement = filmSetGroupBadgePlacement(input, 1000);
    const fitted = groupModelProjection({ ...input, placement: fittedPlacement })!;
    expect(fitted.width).toBeCloseTo(1000 - 80, 5);
    expect(fittedPlacement.scale).toBeCloseTo((1000 - 80) / natural.width, 5);
  });

  it("片场组徽标顶边贴住锚点向下展开，普通组保持中心对齐", () => {
    const rect = { x: 100, y: 200, width: 600, height: 400 };
    const top = groupBadgeRect(rect, { width: 160, height: 120, topAnchored: true })!;
    expect(top.y).toBe(rect.y + rect.height + GROUP_BADGE_ANCHOR_OFFSET);
    expect(top.center.y).toBe(top.y + top.height / 2);

    const centered = groupBadgeRect(rect, { width: 160, height: 120 })!;
    expect(centered.center.y).toBe(rect.y + rect.height + GROUP_BADGE_ANCHOR_OFFSET);
    expect(centered.y).toBeLessThan(top.y);
  });

  it("大模型不被裁剪，徽标范围可以远大于承载它的结构矩形", () => {
    const rect = { x: 0, y: 0, width: 196, height: 112 };
    const badge = groupBadgeRect(rect, { width: 960, height: 720 })!;
    expect(badge.width).toBe(960);
    expect(badge.width).toBeGreaterThan(rect.width);
    const bounds = groupBadgeBounds(rect, { width: 960, height: 720 });
    expect(bounds.width).toBe(960);
    expect(bounds.height).toBeGreaterThan(rect.height);
    expect(groupBadgeOutset(rect, { width: 960, height: 720 })).toBeGreaterThan(0);
  });

  it("没有模型投影时不产生徽标范围，收起也不虚构尺寸", () => {
    const rect = { x: 0, y: 0, width: 196, height: 112 };
    expect(groupBadgeRect(rect, null)).toBeNull();
    expect(groupBadgeRect(rect, { width: 0, height: 40 })).toBeNull();
    expect(groupBadgeOutset(rect, null)).toBe(0);
    expect(groupBadgeBounds(rect, null)).toEqual(rect);
    expect(groupBadgeScreenRect({ left: 100, top: 50, width: 500, height: 300 }, 2, null)).toBeNull();
  });

  it("屏幕投影把徽标放在布局矩形下方，尺寸就是模型投影", () => {
    const badge = groupBadgeScreenRect({ left: 100, top: 50, width: 500, height: 300 }, 2, { width: 160, height: 120 })!;
    expect(badge.top).toBeCloseTo(50 + (300 / 2 + GROUP_BADGE_ANCHOR_OFFSET - 60) * 2, 5);
    expect(badge.left + badge.width / 2).toBe(100 + 500 / 2);
    expect(badge.width).toBe(160 * 2);
    expect(badge.height).toBe(120 * 2);
  });
});

describe("组徽标尺寸字段已移除", () => {
  const canvasWith = (data: Record<string, unknown>) => {
    const canvas = createEmptyWoohaa3ServerCanvas("badge");
    canvas.document.nodes = [{ id: "g", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 },
      { id: "m", type: "text", parentId: "g", position: { x: 40, y: 40 } }];
    canvas.nodeData = data as typeof canvas.nodeData;
    return canvas;
  };

  it("旧画布残留倍率在读取时被忽略，且不改变呈现或其它数据", () => {
    const canvas = canvasWith({ g: { groupBadgeScale: 2.5, groupCollapsed: true, title: "组" } });
    const sanitized = sanitizeWoohaa3CanvasNodeData(canvas.nodeData);
    expect(sanitized.g).toEqual({ groupCollapsed: true, title: "组" });
    const scene = buildCanvasRenderScene({ canvas, selection: { nodes: ["g"] } });
    expect(scene.nodes[0]!.group).toEqual({
      title: "组",
      memberCount: 1,
      outputCapableLeafCount: 1,
      collapsed: true,
      actionBar: true
    });
  });

  it("任何写入徽标尺寸字段的命令都整批拒绝", () => {
    const canvas = canvasWith({});
    for (const value of [2, 0.49, 250, Infinity, NaN, "2"]) {
      const result = applyCanvasCommands(canvas, [{
        type: "nodeData.patch",
        nodeId: "g",
        value: { groupBadgeScale: value as number, groupCollapsed: true }
      }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.rejection.code).toBe("invalid-group-config");
    }
    // 成员也拒绝，且不产生部分写入。
    const member = applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId: "m", value: { groupBadgeScale: 1.5 } }]);
    expect(member.ok).toBe(false);
    expect(applyCanvasCommands(canvas, [{
      type: "node.add",
      node: { id: "bad", type: "image", position: { x: 0, y: 0 } },
      nodeData: { groupBadgeScale: 1.5 } as never
    }]).ok).toBe(false);
    expect(canvas.nodeData).toEqual({});
  });

  it("复制粘贴与撤销不产生该字段", () => {
    const canvas = canvasWith({ g: { groupBadgeScale: 2, groupCollapsed: true } });
    const paste = applyCanvasCommands(canvas, [{
      type: "nodeData.patch",
      nodeId: "g",
      value: sanitizeWoohaa3CanvasNodeData(canvas.nodeData).g as never
    }]);
    expect(paste.ok).toBe(true);
    if (paste.ok) expect(paste.canvas.nodeData.g).toEqual({ groupCollapsed: true });
  });
});
