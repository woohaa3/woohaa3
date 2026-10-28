import { applyCanvasCommands, planCanvasEdit } from "../../../test-support/managed-shot-commands.js";
import { describe, expect, it } from "vitest";
import { groupBadgeRect, groupBadgeScreenRect } from "./group-badge.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";


import { buildCanvasRenderScene } from "./render-scene.js";

describe("independent group badge scale", () => {
  it("固定在气泡外侧并向下等比伸缩，不改变结构矩形", () => {
    const node = {x:100,y:200,width:600,height:400};
    const original = structuredClone(node);
    for (const scale of [0.5,1,2,2.5]) {
      const badge = groupBadgeRect(node, scale);
      expect(badge.y).toBe(606);
      expect(badge.center).toEqual({x:400,y:606 + badge.height / 2});
      expect(badge.x + badge.width/2).toBe(400);
      expect(badge.width/badge.height).toBe(88/64);
      expect(badge.width).toBe(88*scale);
    }
    expect(node).toEqual(original);
    const compact = groupBadgeRect({x:0,y:0,width:196,height:112},2.5);
    expect(compact.y).toBe(118);
    expect(compact.width/compact.height).toBe(88/64);
  });

  it("屏幕投影把徽标放在 group 矩形下方，缩放仍保持外部锚点", () => {
    const badge = groupBadgeScreenRect({ left: 100, top: 50, width: 500, height: 300 }, 2, 1);
    expect(badge.top).toBe(50 + 300 + 6 * 2);
    expect(badge.left + badge.width / 2).toBe(100 + 500 / 2);
    expect(badge.height).toBe(64 * 2);
  });

  it("只保存展示倍率且能撤销到字段缺失；非法输入整批拒绝", () => {
    let canvas = createEmptyWoohaa3ServerCanvas("badge");
    canvas.document.nodes = [{id:"g",type:"group",position:{x:0,y:0},width:600,height:400},
      {id:"m",type:"text",parentId:"g",position:{x:40,y:40}}];
    const nodes = structuredClone(canvas.document.nodes);
    const plan = planCanvasEdit(canvas,[{type:"nodeData.patch",nodeId:"g",value:{groupBadgeScale:2}}]);
    if (!plan.ok) throw Error(plan.reason);
    for (const [edit, expected] of [[plan.forward,2],[plan.inverse,undefined],[plan.forward,2]] as const) {
      const result = applyCanvasCommands(canvas,[{type:"edit.apply",...edit}]);
      if (!result.ok) throw Error(result.rejection.message);
      canvas=result.canvas;
      expect(canvas.nodeData.g?.groupBadgeScale).toBe(expected);
      expect(canvas.document.nodes).toEqual(nodes);
      expect(canvas.nodeData.g?.groupAppearance).toBeUndefined();
    }
    const scene = buildCanvasRenderScene({canvas,selection:{nodes:["g"]},groupBadgeResizable:true});
    expect(scene.nodes[0]!.group).toMatchObject({badgeScale:2,badgeResizable:true});
    for (const value of [0,0.49,2.51,Infinity,NaN,"2"]) {
      expect(applyCanvasCommands(canvas,[{type:"nodeData.patch",nodeId:"g",value:{groupBadgeScale:value as number}}]).ok).toBe(false);
    }
    expect(applyCanvasCommands(canvas,[{type:"nodeData.patch",nodeId:"m",value:{groupBadgeScale:1.5}}]).ok).toBe(false);
    expect(applyCanvasCommands(canvas,[{type:"node.add",node:{id:"bad",type:"image",position:{x:0,y:0}},nodeData:{groupBadgeScale:1.5}}]).ok).toBe(false);
  });
});
