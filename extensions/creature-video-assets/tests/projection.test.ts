import { describe, expect, it } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { planProjection, cardOwner } from "../src/preview/shared/projection.js";
import { previewRun } from "../src/preview/shared/debug.js";
import { createRun, initialInput, workflowInstance } from "../src/state/shared/workflow.js";
import { STAGES } from "../src/state/shared/recipe.js";
import { stageOutputSlots } from "../src/state/shared/stage-output.js";
import { planDirections } from "../src/state/shared/creature/direction.js";
describe("画布中的逐步卡片", () => {
  it("projects each durable output state without marking the whole stage as generating",()=>{
    const canvas=createEmptyWoohaa3ServerCanvas("canvas");canvas.document.nodes.push({id:"workflow",type:"composite-asset",position:{x:0,y:0}});
    const run=createRun("canvas","workflow","instance-123");
    run.stages["03_direction_plan"].structured=planDirections(["6_00","7_30","9_00","10_30"],{mirrorSafety:{safe:true,asymmetricFeatures:[],handednessConstraints:[],textOrSymbolsPresent:false,userAcceptedSemanticMirroring:true}}) as unknown as Record<string,unknown>;
    const stage=run.stages["05_direction_stills"];stage.status="running";
    const slots=stageOutputSlots(run,"05_direction_stills");
    stage.outputs={[slots[0]!.key]:"queued",[slots[1]!.key]:"running",[slots[2]!.key]:"waiting",[slots[3]!.key]:"processing"};
    const result=applyCanvasCommands(canvas,planProjection(canvas,structuredClone(run),"05_direction_stills",stage.input,key=>key));
    expect(result.ok).toBe(true);if(!result.ok)return;
    const outputs=result.canvas.document.nodes.filter(node=>cardOwner(result.canvas.nodeData[node.id])?.role==="output");
    expect(outputs.map(node=>result.canvas.nodeData[node.id]?.taskStatus)).toEqual(["pending","processing","idle","processing","idle"]);
  });
  it("八步只展示当步输入和产物，边不连接中心按钮；切步保留外部来源", () => {
    let canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-21T00:00:00Z");
    canvas.document.nodes.push({ id: "workflow", type: "composite-asset", position: { x: 0, y: 0 } }, { id: "external-image", type: "image", position: { x: -800, y: 0 } });
    canvas.nodeData.workflow = { extensionId: "creature-video-assets", extensionContentRef: { schemaVersion: 1, instanceId: "instance-123" } };
    const original = createRun(canvas.id, "workflow", "instance-123");
    for (const definition of STAGES) {
      const run = previewRun(original, definition.id, "review");
      const result = applyCanvasCommands(canvas, planProjection(canvas, run, definition.id, initialInput(), key => `/media/${key}`));
      expect(result.ok, result.ok ? undefined : result.rejection.message).toBe(true);
      if (!result.ok) return;
      canvas = result.canvas;
      const cards = canvas.document.nodes.filter(node => cardOwner(canvas.nodeData[node.id]));
      expect(cards.filter(node => cardOwner(canvas.nodeData[node.id])?.role === "input")).toHaveLength(definition.id === "01_brief" ? 1 : 0);
      expect(cards.filter(node => cardOwner(canvas.nodeData[node.id])?.role === "previous")).toHaveLength(definition.visibleInputs.length);
      const outputs = cards.filter(node => cardOwner(canvas.nodeData[node.id])?.role === "output");
      expect(outputs).toHaveLength(stageOutputSlots(run,definition.id).length);
      for (const output of outputs) expect(canvas.nodeData[output.id]?.prompt).toBeTruthy();
      expect(canvas.document.edges.every(edge => edge.source !== "workflow" && edge.target !== "workflow")).toBe(true);
      expect(canvas.document.nodes.some(node => node.id === "external-image")).toBe(true);
      // 媒体占位可显示为卡片，但不能伪造没有 COS 对象的媒体资产。
      expect(canvas.assets.every(asset => asset.mediaKind === "text" || !!asset.metadata?.storageKey)).toBe(true);
      const residual = planProjection(canvas, run, definition.id, initialInput(), key => `/media/${key}`);
      expect(residual).toEqual([]);
    }
    expect(original.stages["01_brief"].status).toBe("ready");
  });
  it("多产物步骤在执行前显示全部卡片，执行后沿用相同节点", () => {
    let canvas=createEmptyWoohaa3ServerCanvas("canvas");
    canvas.document.nodes.push({id:"workflow",type:"composite-asset",position:{x:0,y:0}});
    const run=createRun("canvas","workflow","instance-123"), input=initialInput();
    const before=applyCanvasCommands(canvas,planProjection(canvas,run,"04_action_design",input,key=>`/media/${key}`));
    expect(before.ok).toBe(true);if(!before.ok)return;canvas=before.canvas;
    const ids=canvas.document.nodes.filter(node=>cardOwner(canvas.nodeData[node.id])?.role==="output").map(node=>node.id);
    expect(ids).toHaveLength(2);
    expect(ids.every(id=>typeof canvas.nodeData[id]?.prompt==="string"&&String(canvas.nodeData[id]?.prompt).length>0)).toBe(true);
    run.stages["04_action_design"].artifacts=[
      {id:"graph",title:"动作状态、转换与事件帧",kind:"text",text:"动作图"},
      {id:"plan",title:"制作数量与费用范围",kind:"text",text:"制作计划"}
    ];
    const after=applyCanvasCommands(canvas,planProjection(canvas,run,"04_action_design",input,key=>`/media/${key}`));
    expect(after.ok).toBe(true);if(!after.ok)return;
    expect(after.canvas.document.nodes.filter(node=>cardOwner(after.canvas.nodeData[node.id])?.role==="output").map(node=>node.id)).toEqual(ids);
    expect(after.canvas.assets.filter(asset=>asset.nodeId!==undefined&&ids.includes(asset.nodeId))).toHaveLength(2);
  });
  it("多产物步骤按槽位分别显示失败、依赖阻塞和未执行", () => {
    const canvas=createEmptyWoohaa3ServerCanvas("canvas");
    canvas.document.nodes.push({id:"workflow",type:"composite-asset",position:{x:0,y:0}});
    const run=previewRun(createRun("canvas","workflow","instance-123"),"05_direction_stills","failed");
    run.stages["03_direction_plan"].structured=planDirections(["6_00","7_30","9_00"],{mirrorSafety:{safe:true,asymmetricFeatures:[],handednessConstraints:[],textOrSymbolsPresent:false,userAcceptedSemanticMirroring:true}}) as unknown as Record<string,unknown>;
    const stage=run.stages["05_direction_stills"], slots=stageOutputSlots(run,"05_direction_stills");
    stage.artifacts=[{id:"done",title:slots[0]!.title,kind:"image",directionId:slots[0]!.directionId,storageKey:"image",checksum:"a".repeat(64)}];
    stage.error="1 个产物制作失败，1 个产物因依赖未执行；其余成功项已保留。";
    stage.outputIssues[slots[1]!.key]={state:"failed",code:"provider-rejected",message:"站定图 7:30 的输入提示词触发了内容安全检查。"};
    stage.outputIssues[slots[2]!.key]={state:"blocked",code:"output-dependency-failed",message:"未执行：依赖产物未完成。"};
    const projected=applyCanvasCommands(canvas,planProjection(canvas,run,"05_direction_stills",stage.input,key=>`/media/${key}`));
    expect(projected.ok).toBe(true);if(!projected.ok)return;
    const outputs=projected.canvas.document.nodes.filter(node=>cardOwner(projected.canvas.nodeData[node.id])?.role==="output");
    const states=outputs.map(node=>projected.canvas.nodeData[node.id]);
    expect(states[0]).toMatchObject({taskStatus:"successed",errorMessage:null});
    expect(states[1]).toMatchObject({taskStatus:"failed",status:"failed",errorMessage:stage.outputIssues[slots[1]!.key]!.message});
    expect(states[2]).toMatchObject({taskStatus:"idle",status:"idle",errorMessage:stage.outputIssues[slots[2]!.key]!.message});
    expect(states.slice(3).every(data=>data?.taskStatus==="idle"&&data.errorMessage===null)).toBe(true);
  });
  it("等待的 RGB 产物显示具体依赖并连到前序视频产物",()=>{
    const canvas=createEmptyWoohaa3ServerCanvas("canvas");canvas.document.nodes.push({id:"workflow",type:"composite-asset",position:{x:0,y:0}});
    const run=createRun("canvas","workflow","instance-123");
    run.stages["01_brief"].structured={schema:"project-a.creature-video-creature-design.v1",displayName:"生物",summary:"四足生物",anatomy:["四足"],locomotion:"站立",materials:["厚毛"],palette:["灰色"],signatureFeatures:["短角"],scaleMeters:2,footBaselineNote:"脚底水平",backgroundKind:"green_screen",forbiddenChanges:["不得改变身份"],mirrorSafety:{safe:true,asymmetricFeatures:[],handednessConstraints:[],textOrSymbolsPresent:false,userAcceptedSemanticMirroring:false},actionCandidates:[{stateId:"idle",displayName:"Idle",kind:"loop",phase:"idle",durationSeconds:1,description:"轻微呼吸",required:true,userRequested:true}],promptInvariants:["保持身份"],userRequest:"生物"};
    run.stages["03_direction_plan"].structured=planDirections(["6_00"],{mirrorSafety:{safe:true,asymmetricFeatures:[],handednessConstraints:[],textOrSymbolsPresent:false,userAcceptedSemanticMirroring:true}}) as unknown as Record<string,unknown>;
    const state=(id:string,phase:"idle"|"terminal",dependency:string|null)=>({
      stateId:id,displayName:id==="idle"?"Idle":"Death",description:"动作",kind:phase==="idle"?"loop":"one_shot",phase,directionCoverage:["6_00"],durationSeconds:1,fps:24,mirrorSafe:true,handednessConstraints:[],
      startAnchor:{anchorId:`${id}-start`,actionStateId:id,directionId:"6_00",role:"start",frame:0,description:"起始姿态",source:"direction_still",reusedFromArtifactId:null},
      endAnchor:{anchorId:phase==="idle"?`${id}-start`:`${id}-end`,actionStateId:id,directionId:"6_00",role:"end",frame:23,description:"结束姿态",source:"direction_still",reusedFromArtifactId:null},
      motionContract:{schema:"motion-contract.v1",fps:24,frameCount:24,rhythmToleranceFrames:0,events:[{id:`${id}-start`,frame:0,instruction:"开始"},{id:`${id}-end`,frame:23,instruction:"结束"}],repeatGroups:[],symmetryPairs:[]},clipSegments:[],terminal:phase==="terminal",
      clipGeneration:{startFrameFromStateId:dependency,endFrameFromStateId:null,sharedStartImage:null,timeline:{mode:"trim",seconds:null},promptInvariants:[]}
    });
    run.stages["04_action_design"].structured={schema:"project-a.creature-video-action-graph.v1",fps:24,initialStateId:"idle",actionOrder:["idle","death"],states:[state("idle","idle",null),state("death","terminal","idle")],transitions:[]};
    const stage=run.stages["07_rgb_videos"],slots=stageOutputSlots(run,"07_rgb_videos");stage.outputs={[slots[1]!.key]:"waiting"};
    const projected=applyCanvasCommands(canvas,planProjection(canvas,run,"07_rgb_videos",stage.input,key=>`/media/${key}`));
    expect(projected.ok).toBe(true);if(!projected.ok)return;
    const outputs=projected.canvas.document.nodes.filter(node=>cardOwner(projected.canvas.nodeData[node.id])?.role==="output");
    const idle=outputs.find(node=>cardOwner(projected.canvas.nodeData[node.id])?.slot.endsWith("|idle|state"))!;
    const death=outputs.find(node=>cardOwner(projected.canvas.nodeData[node.id])?.slot.endsWith("|death|state"))!;
    expect(projected.canvas.document.edges).toContainEqual(expect.objectContaining({source:idle.id,target:death.id}));
    expect(projected.canvas.nodeData[death.id]?.result).toMatchObject({text:"等待：Idle · 6:00"});
  });
  it("参考图使用容器并保留稳定引用，不被识别为独立制作主体", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas");
    canvas.document.nodes.push({ id: "workflow", type: "composite-asset", position: { x: 0, y: 0 } });
    const input = { ...initialInput(), referenceImages: [{ sourceNodeId: "source", assetId: "source-asset", storageKey: `sha256-${"a".repeat(64)}`, checksum: "a".repeat(64), contentType: "image/png", size: 123, title: "参考图" }] };
    const commands = planProjection(canvas, createRun("canvas", "workflow", "instance-123"), "01_brief", input, key => `/media/${key}`);
    const result = applyCanvasCommands(canvas, commands);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const container = result.canvas.document.nodes.find(node => cardOwner(result.canvas.nodeData[node.id])?.role === "input")!;
    expect(container.type).toBe("composite-asset");
    expect(result.canvas.nodeData[container.id]!.referenceImages).toEqual(input.referenceImages);
    expect(workflowInstance(result.canvas.nodeData[container.id])).toBeNull();
    // 已有版本的普通图片输入卡升级时保留位置，恢复被移除节点的连线。
    container.type = "image";
    container.position = { x: 123, y: 456 };
    const migrated = applyCanvasCommands(result.canvas, planProjection(result.canvas, createRun("canvas", "workflow", "instance-123"), "01_brief", input, key => `/media/${key}`));
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.canvas.document.nodes.find(node => node.id === container.id)).toMatchObject({ type: "composite-asset", position: container.position });
    expect(migrated.canvas.document.edges.filter(edge => edge.source === container.id)).toHaveLength(1);
    expect(planProjection(migrated.canvas, createRun("canvas", "workflow", "instance-123"), "01_brief", input, key => `/media/${key}`)).toEqual([]);
  });
});
