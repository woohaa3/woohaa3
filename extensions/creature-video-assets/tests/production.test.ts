import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import JSZip from "jszip";
import { GpuClient } from "../src/authoring/backend/production/providers/gpu.js";
import { temporalWindows } from "../src/authoring/backend/production/stages/publish.js";
import { maskArtifact, alphaArtifacts } from "../src/authoring/backend/production/stages/matting.js";
import { applySemanticEnvelope, composeRgba } from "../src/authoring/backend/production/media/compose.js";
import { unpack } from "../src/authoring/backend/production/media/archive.js";
import { createRun, WorkflowError } from "../src/state/shared/workflow.js";
import { task } from "../src/authoring/backend/task-runner.js";
import { runOutputJobs } from "../src/authoring/backend/production/stages/generation.js";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";

const context=()=>({run:createRun("c","n","instance-123"),stageId:"08_matting" as const,checkpoint:vi.fn(async()=>{}),assertCurrent:vi.fn(async()=>{}),isStopped:()=>false});
describe("专用制作协议与媒体契约",()=>{
  it("remote job recovery queries the original id; a lost submission never repeats POST",async()=>{
    const ctx=context(),calls:string[]=[];
    const request=vi.fn(async(url:URL,init:RequestInit)=>{calls.push(`${init.method??"GET"} ${url.pathname}`);if(init.method==="POST")return Response.json({task_id:"task_1"});return Response.json({state:"succeeded",artifacts:[{name:"mask.mp4",url:"/v1/assets/asset_1234567890123456/content"}]});}) as unknown as typeof fetch;
    const gpu=new GpuClient({baseUrl:"https://gpu.example",token:"test",fetch:request,pollMs:1});
    await gpu.execute(ctx,"sam",{task_type:"sam3"});
    const op=ctx.run.stages[ctx.stageId].operations[0];expect(op.remoteRef).toBe("task_1");op.state="submitted";delete op.remoteArtifacts;
    await gpu.execute(ctx,"sam",{task_type:"sam3"});expect(calls.filter(c=>c.startsWith("POST"))).toHaveLength(1);
    const lost=context(),broken=vi.fn(async()=>{throw Error("lost");}) as unknown as typeof fetch,unknown=new GpuClient({baseUrl:"https://gpu.example",token:"test",fetch:broken});
    await expect(unknown.execute(lost,"sam",{task_type:"sam3"})).rejects.toMatchObject({code:"submit-unknown"});
    await expect(unknown.execute(lost,"sam",{task_type:"sam3"})).rejects.toMatchObject({code:"submit-unknown"});expect(broken).toHaveBeenCalledOnce();
  });
  it("Task generation keeps the selected model and reuses pilot tasks at the batch gate",async()=>{
    const ctx={...context(),stageId:"07_rgb_videos" as const},stage=ctx.run.stages[ctx.stageId];stage.input.modelKey="selected-video";
    const submit=vi.fn(async(_input:Record<string,unknown>)=>({ok:true,state:"queued"})),services={tasks:{submit,result:vi.fn(async()=>({state:"succeeded",result:{storageKey:"sha256-video",contentType:"video/mp4",checksum:"a".repeat(64),size:100}}))}} as unknown as ApplicationExtensionServices;
    const image={id:"input",title:"input",kind:"image" as const,storageKey:"sha256-image",role:"first_frame"};
    const result=await task(ctx,services,"RGB idle","video","fixed camera",[image],{}, {stableAcrossGates:true});stage.gate="batch";
    expect(await task(ctx,services,"RGB idle","video","fixed camera",[image],{}, {stableAcrossGates:true})).toEqual(result);
    expect(submit).toHaveBeenCalledOnce();expect(submit.mock.calls[0][0]).toMatchObject({modelKey:"selected-video",inputs:[{role:"first_frame"}]});
    await task(ctx,services,"shared-start","image","shared pose",[image],{},{modelKey:"selected-image",stableAcrossGates:true});
    expect(submit.mock.calls[1][0]).toMatchObject({modelKey:"selected-image",modelType:"image"});
  });
  it("reports the failed output and provider rejection reason",async()=>{
    const ctx={...context(),stageId:"07_rgb_videos" as const},stage=ctx.run.stages["07_rgb_videos"];
    stage.input.modelKey="selected-video";
    const services={tasks:{submit:vi.fn(async()=>({ok:true,state:"queued"})),result:vi.fn(async()=>({state:"failed",error:{message:"request rejected",status:400,code:"InputTextSensitiveContentDetected"}}))}} as unknown as ApplicationExtensionServices;
    await expect(task(ctx,services,"RGB 6_00|idle|state","video","fixed camera",[],{})).rejects.toMatchObject({
      code:"InputTextSensitiveContentDetected",
      message:"“RGB 6_00|idle|state”的输入提示词触发了生成服务的内容安全检查。已完成项已保留，请调整该产物提示词后重新执行。"
    });
    expect(stage.operations[0]?.state).toBe("failed");
    expect(ctx.checkpoint).toHaveBeenCalled();
  });
  it("continues independent RGB outputs and marks dependency-blocked outputs separately",async()=>{
    const completed=new Set<string>(),issues:Record<string,{state:"failed"|"blocked";code:string;message:string}>={},executed:string[]=[];
    const checkpoint=vi.fn(async()=>{});
    await runOutputJobs([
      {key:"idle",dependencies:[],execute:async()=>{executed.push("idle");throw new WorkflowError("provider-rejected","内容安全检查");}},
      {key:"attack",dependencies:["idle"],execute:async()=>{executed.push("attack");}},
      {key:"entry",dependencies:[],execute:async()=>{executed.push("entry");}}
    ],completed,issues,checkpoint);
    expect(executed).toEqual(["idle","entry"]);
    expect(completed).toEqual(new Set(["entry"]));
    expect(issues.attack).toMatchObject({state:"blocked",code:"output-dependency-failed"});
    expect(issues.idle).toEqual({state:"failed",code:"provider-rejected",message:"内容安全检查"});
    expect(checkpoint).toHaveBeenCalled();
  });
  it("SAM uses a video mask and AlphaHint has numeric, continuous source-frame mapping",()=>{
    expect(maskArtifact([{name:"masks.zip",url:"zip"},{name:"mask.mp4",url:"video"}]).url).toBe("video");
    expect(alphaArtifacts([{name:"frame_000002.png",url:"2"},{name:"frame_000001.png",url:"1"}],2).map(a=>a.url)).toEqual(["1","2"]);
    expect(()=>alphaArtifacts([{name:"frame_000001.png",url:"1"},{name:"frame_000003.png",url:"3"}],2)).toThrow();
    const windows=temporalWindows(242);expect(windows.map(w=>w.real)).toEqual([121,121]);expect(temporalWindows(122).map(w=>w.padded)).toEqual([121,1]);expect(temporalWindows(120)[0]).toEqual({start:0,real:120,padded:121});
  });
  it("straight alpha preserves original RGB and the envelope retains soft subject edges",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"creature-pixels-"));
    try{
      const rgb=join(dir,"rgb.png"),sam=join(dir,"sam.png"),hint=join(dir,"hint.png"),clean=join(dir,"clean.png"),rgba=join(dir,"rgba.png");
      await sharp(Buffer.from([23,57,91,111,74,32]),{raw:{width:2,height:1,channels:3}}).png().toFile(rgb);
      await sharp(Buffer.from([255,0]),{raw:{width:2,height:1,channels:1}}).png().toFile(sam);await sharp(Buffer.from([180,70]),{raw:{width:2,height:1,channels:1}}).png().toFile(hint);
      await applySemanticEnvelope({samMask:sam,alphaHint:hint,output:clean,envelopePx:1,alphaFloor:2});await composeRgba({rgb,alpha:clean,output:rgba,alphaFloor:2});
      expect([...await sharp(rgba).raw().toBuffer()]).toEqual([23,57,91,180,111,74,32,70]);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it("rejects zip traversal before writing members",async()=>{
    const zip=new JSZip();zip.file("../outside.png","payload");const bytes=await zip.generateAsync({type:"uint8array"}),dir=await mkdtemp(join(tmpdir(),"creature-zip-"));
    try{await expect(unpack(bytes,dir)).rejects.toThrow();await expect(readFile(join(dir,"outside.png"))).rejects.toThrow();}finally{await rm(dir,{recursive:true,force:true});}
  });
});
