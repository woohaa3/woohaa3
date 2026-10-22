import { describe, expect, it } from "vitest";
import { createRun, initialInput } from "../src/state/shared/workflow.js";
import { compileRgbPrompt, outputPrompt, type StageOutputSlot } from "../src/state/shared/stage-output.js";

describe("完整产物提示词",()=>{
  it("upgrades an older prefilled short description to the actual prompt, but preserves user edits",()=>{
    const slot:StageOutputSlot={key:"6_00|Idle|state",title:"Idle · 6:00",kind:"video",modelType:"video",prompt:"full identity, camera and motion prompt",legacyPrompt:"生成 6:00 方向的 Idle 动作"};
    const input={...initialInput(),outputPrompts:{[slot.key]:slot.legacyPrompt!}};
    expect(outputPrompt(input,slot)).toBe(slot.prompt);
    expect(outputPrompt({...input,outputPrompts:{[slot.key]:"user edited full prompt"}},slot)).toBe("user edited full prompt");
  });

  it("keeps the RGB prompt to action and reference essentials",()=>{
    const run=createRun("canvas","node","instance-123");
    run.stages["01_brief"].structured={
      schema:"project-a.creature-video-creature-design.v1",displayName:"测试生物",summary:"灰色四足生物",anatomy:["四足"],locomotion:"原地站立",materials:["厚毛"],palette:["灰色"],signatureFeatures:["短角"],scaleMeters:2,footBaselineNote:"脚底水平",backgroundKind:"green_screen",forbiddenChanges:["不得改变角的数量"],mirrorSafety:{safe:true,asymmetricFeatures:[],handednessConstraints:[],textOrSymbolsPresent:false,userAcceptedSemanticMirroring:false},actionCandidates:[{stateId:"idle",displayName:"Idle",kind:"loop",phase:"idle",durationSeconds:1,description:"呼吸",required:true,userRequested:true}],promptInvariants:["短角保持一致"],userRequest:"测试"
    };
    run.productionProfile={cameraSummary:"固定游戏相机",cameraHash:"camera",identityAspectRatio:1,identityParameters:{}};
    const state={
      stateId:"idle",displayName:"Idle",kind:"loop",phase:"idle",directionCoverage:["6_00"],durationSeconds:1,fps:24,mirrorSafe:true,handednessConstraints:[],description:"轻微呼吸",required:true,userRequested:true,
      startAnchor:{anchorId:"start",actionStateId:"idle",directionId:"6_00",role:"start",frame:0,description:"站立",source:"direction_still",reusedFromArtifactId:null},
      endAnchor:{anchorId:"end",actionStateId:"idle",directionId:"6_00",role:"end",frame:23,description:"站立",source:"direction_still",reusedFromArtifactId:null},
      motionContract:{schema:"motion-contract.v1",fps:24,frameCount:24,rhythmToleranceFrames:0,events:[{id:"inhale",frame:12,instruction:"胸腹轻微起伏"}],repeatGroups:[],symmetryPairs:[]},
      clipSegments:[],terminal:false,clipGeneration:{startFrameFromStateId:null,endFrameFromStateId:null,sharedStartImage:null,timeline:{mode:"trim",seconds:null},promptInvariants:[]}
    } as never;
    const prompt=compileRgbPrompt(run,"6_00",state);
    expect(prompt).toContain("保持首帧参考中的测试生物外观、构图和相机");
    expect(prompt).toContain("Idle：轻微呼吸");
    expect(prompt).toContain("动作在 1 秒内完成，之后保持末态");
    expect(prompt).not.toContain("动作内的关键节点（按秒计）");
    expect(prompt).not.toContain("四边至少保留 15% 安全边距");
    expect(prompt.length).toBeLessThan(500);
  });
});
