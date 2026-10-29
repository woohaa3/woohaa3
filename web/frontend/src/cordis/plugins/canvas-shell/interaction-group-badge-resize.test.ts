import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, groupBadgeRect, type CanvasRenderScene } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { collectResidencyCandidates } from "../canvas-runtime/residency/projection.js";
import { getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";
import type { PointHit } from "../canvas-runtime/bevy-runtime.js";

installSharedSession();
function setup(options: {zoom?:number;collapsed?:boolean;writable?:boolean} = {}) {
  const source=createEmptyWoohaa3ServerCanvas("c1");
  source.document.nodes=[{id:"g",type:"group",position:{x:0,y:0},width:600,height:400},
    {id:"m",type:"image",parentId:"g",position:{x:40,y:40},width:200,height:100}];
  source.nodeData={g:{title:"组",...(options.collapsed?{groupCollapsed:true}:{})},m:{}};
  woohaa3CanvasStore.getState().applyRemoteCanvas(source);
  const dom=harness();
  let hit:PointHit|null={kind:"node-action",nodeId:"g",actionId:"group-resize-badge",menu:false};
  const runtime=runtimeCapturing({pointHit:()=>hit});
  const controller=installInteractionController({canvas:dom.canvas,target:dom.target as never,
    getRuntime:()=>runtime.runtime,getSession:()=>getSession() as never,isWritable:()=>options.writable!==false});
  controller.restoreViewport({x:0,y:0,zoom:options.zoom??1});
  controller.selectNode("g"); controller.flush();
  const current=()=>workingCanvasOf(woohaa3CanvasStore.getState())!;
  const scene=()=>runtime.scenes.at(-1) as unknown as CanvasRenderScene;
  const pointer=(type:string,dx=0,dy=0) => dom.fire(type,{clientX:(339+dx)*(options.zoom??1),clientY:(401+dy)*(options.zoom??1)});
  return {...dom,...runtime,controller,current,scene,pointer,setHit:(next:PointHit|null)=>{hit=next;}};
}

describe("group badge independent resize",()=>{
  it.each([0.5,1,2])("在 %s× 画布缩放下保持中线对齐等比预览，松手只提交徽标倍率",zoom=>{
    const f=setup({zoom});
    const nodes=structuredClone(f.current().document.nodes);
    f.pointer("pointerdown"); f.pointer("pointermove",44,32); f.controller.flush();
    const group=f.scene().nodes.find(n=>n.id==="g")!;
    expect(group.group?.badgeScale).toBe(2);
    const badge=groupBadgeRect(group,group.group?.badgeScale);
    // 中线永远与气泡中心 300 对齐；上缘固定，只向下增长。
    expect(badge.y).toBe(406);
    expect(badge.center).toEqual({x:300,y:470});
    expect(badge.x + badge.width/2).toBe(300);
    expect(badge.width/badge.height).toBe(88/64);
    expect(f.current().nodeData.g.groupBadgeScale).toBeUndefined();
    f.pointer("pointerup",44,32);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({type:"nodeData.patch",nodeId:"g",value:{groupBadgeScale:2}});
    expect(f.current().document.nodes).toEqual(nodes);
    expect(f.current().nodeData.g.groupCollapsed).toBeUndefined();
    expect(f.current().nodeData.g.groupAppearance).toBeUndefined();
    expect(collectResidencyCandidates(f.current(),n=>`key:${n.id}`).find(c=>c.nodeId==="g")?.height).toBe(534);
    f.controller.dispose();
  });

  it.each(["pointercancel","blur","visibilitychange","Escape"])("%s 取消预览且不保存或触发折叠",cancel=>{
    const f=setup(); f.pointer("pointerdown");f.pointer("pointermove",44,32);f.controller.flush();
    expect(f.scene().nodes[0]!.group?.badgeScale).toBe(2);
    if(cancel==="Escape") f.fireKey("keydown",{key:"Escape"});
    else if(cancel==="visibilitychange") { (f.target.document as {visibilityState?:string}).visibilityState="hidden";f.fire(cancel,{}); }
    else f.pointer(cancel);
    f.controller.flush();
    expect(f.scene().nodes[0]!.group?.badgeScale).toBe(1);
    f.pointer("pointerup",44,32);
    expect(submitted).toHaveLength(0);f.controller.dispose();
  });

  it("收起态也能独立缩放；越过中心不会翻转",()=>{
    const f=setup({collapsed:true}); f.pointer("pointerdown");f.pointer("pointermove",-400,-400);f.pointer("pointerup",-400,-400);
    expect(f.current().nodeData.g).toMatchObject({groupCollapsed:true,groupBadgeScale:0.5});f.controller.dispose();
  });

  it("只读与并发切换时不提交",()=>{
    const readOnly=setup({writable:false});readOnly.pointer("pointerdown");readOnly.pointer("pointermove",44,32);readOnly.pointer("pointerup",44,32);
    expect(submitted).toHaveLength(0);readOnly.controller.dispose();
    const f=setup();f.pointer("pointerdown");
    const remote=structuredClone(f.current());remote.nodeData.g.groupBadgeScale=1.5;
    woohaa3CanvasStore.getState().applyRemoteCanvas(remote);
    f.pointer("pointermove",44,32);f.pointer("pointerup",44,32);
    expect(submitted).toHaveLength(0);expect(f.current().nodeData.g.groupBadgeScale).toBe(1.5);f.controller.dispose();
  });
});

describe("group badge resize survives unrelated node data churn", () => {
  it("成员重排改变 group 矩形、其它字段被同步时，松手仍提交倍率", () => {
    const f = setup();
    f.pointer("pointerdown");
    f.pointer("pointermove", 44, 32); f.controller.flush();
    const churned = structuredClone(f.current());
    churned.document.nodes = churned.document.nodes.map(node => node.id === "m" ? { ...node, width: 260, height: 130 } : node);
    (churned.nodeData as Record<string, unknown>).g = { ...churned.nodeData.g, title: "组（已同步）" };
    woohaa3CanvasStore.getState().applyRemoteCanvas(churned);
    f.pointer("pointerup", 44, 32);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ type: "nodeData.patch", nodeId: "g", value: { groupBadgeScale: 2 } });
    expect((submitted[0] as { expectedNodeData?: Record<string, { title?: string }> }).expectedNodeData?.g?.title).toBe("组（已同步）");
    f.controller.dispose();
  });
});
