import { expect, it } from "vitest";
import { buildCanvasRenderScene, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { createCanvasNodeIndex } from "./canvas-node-index.js";
import { changedPreviewPositions, expandPositionPreviews } from "./position-preview-plan.js";

it("nested absolute overrides match a full projection, including explicit child overrides", () => {
  const canvas=createEmptyWoohaa3ServerCanvas("test");
  canvas.document.nodes=[
    {id:"outer",type:"group",position:{x:100,y:200}},
    {id:"inner",type:"group",position:{x:10,y:20},parentId:"outer"},
    {id:"leaf",type:"image",position:{x:5,y:7},parentId:"inner"},
    {id:"other",type:"image",position:{x:1000,y:2000}}
  ];
  const index=createCanvasNodeIndex(canvas)!;
  const cases=[new Map([["inner",{x:150,y:250}]]),new Map([["outer",{x:200,y:300}]]),
    new Map([["outer",{x:200,y:300}],["inner",{x:500,y:600}]])];
  for (const previews of cases) {
    const expanded=expandPositionPreviews(index,previews)!;
    const full=buildCanvasRenderScene({canvas,positionOverrides:previews});
    for(const [id,p] of expanded) expect(full.nodes.find(n=>n.id===id)).toMatchObject(p);
    expect(expanded.has("other")).toBe(false);
    const reset=changedPreviewPositions(index,expanded,new Map());
    for(const row of reset) expect(row).toEqual({id:row.id,...index.absolutePosition(row.id)});
  }
  expect(expandPositionPreviews(index,new Map([["missing",{x:0,y:0}]]))).toBeNull();
  expect(expandPositionPreviews(index,new Map([["outer",{x:Infinity,y:0}]]))).toBeNull();
});

it("owner→preview 闭包只让同 index 的预览跟随一次，显式落点优先（任务 2.4）", () => {
  const canvas=createEmptyWoohaa3ServerCanvas("test");
  const previewId="shot-preview:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const otherPreviewId="shot-preview:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  canvas.document.nodes=[
    {id:"film",type:"composite-asset",position:{x:100,y:50}},
    {id:previewId,type:"film-set-shot-preview",position:{x:480,y:50},parentId:undefined},
    {id:"film2",type:"composite-asset",position:{x:0,y:0}},
    {id:otherPreviewId,type:"film-set-shot-preview",position:{x:300,y:0}}
  ];
  canvas.nodeData[previewId]={shotPreview:{schemaVersion:1,filmSetNodeId:"film",clipId:"a"}} as never;
  canvas.nodeData[otherPreviewId]={shotPreview:{schemaVersion:1,filmSetNodeId:"film2",clipId:"b"}} as never;
  const index=createCanvasNodeIndex(canvas)!;
  expect(index.shotPreviewsByOwner.get("film")).toEqual([previewId]);
  expect(index.shotPreviewsByOwner.has("film2")).toBe(true);

  // 拖动片场 d=(30,-20)：预览跟随一次，另一 owner 的预览不动。
  const moved=expandPositionPreviews(index,new Map([["film",{x:130,y:30}]]))!;
  expect(moved.get(previewId)).toEqual({x:510,y:30});
  expect(moved.has(otherPreviewId)).toBe(false);

  // 片场与预览同批移动且预览显式落点：只生效一次、以显式值优先。
  const both=expandPositionPreviews(index,new Map([["film",{x:130,y:30}],[previewId,{x:900,y:800}]]))!;
  expect(both.get(previewId)).toEqual({x:900,y:800});

  // 取消：所有旧偏移在 changedPreviewPositions 里被复位。
  const reset=changedPreviewPositions(index,both,new Map());
  expect(reset.find(row=>row.id===previewId)).toEqual({id:previewId,...index.absolutePosition(previewId)});
});
