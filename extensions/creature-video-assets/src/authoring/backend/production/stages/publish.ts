import { copyFile, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import sharp from "sharp";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { WorkflowError, type Artifact } from "../../../../state/shared/workflow.js";
import { actionGraphSchema } from "../../../../state/shared/creature/action.js";
import type { ExecutionContext, StageResult } from "../../service.js";
import type { GpuClient, GpuArtifact } from "../providers/gpu.js";
import { Workspace } from "../media/workspace.js";
import { encode, runTool, tool } from "../media/process.js";
import { unpackFile, pack } from "../media/archive.js";
import { planGbufferResolution } from "../gbuffer/resolution.js";
import { completed } from "./generation.js";
import type { MatteClip } from "./matting.js";
import { extensionRoot } from "../tools.js";

const PASSES=["basecolor","normal","depth","roughness","metallic"] as const;
type Frame = Record<typeof PASSES[number]|"body",string> & {rgbSourceFrame:number};
export type Candidate = {bundle:Artifact;files:Record<string,Artifact>;revision:number};
export function temporalWindows(frames:number):{start:number;real:number;padded:number}[] {
  if(!Number.isSafeInteger(frames)||frames<1||frames>2400)throw new WorkflowError("invalid-frame-count","通道输入帧数非法。");
  const windows=[];for(let start=0;start<frames;start+=121){const real=Math.min(121,frames-start);windows.push({start,real,padded:1+8*Math.ceil((real-1)/8)});}return windows;
}
function channelIndex(artifacts:GpuArtifact[]):Map<string,GpuArtifact> {
  const index=new Map<string,GpuArtifact>();
  for(const artifact of artifacts){const m=artifact.name.replace(/^[a-f0-9]{16}-/i,"").match(/^(\d+)(?:\.\d+)?\.(basecolor|normal|depth|roughness|metallic)\.png$/i);if(m)index.set(`${Number(m[1])}:${m[2].toLowerCase()}`,artifact);}
  return index;
}
export async function executePublish(context:ExecutionContext,services:ApplicationExtensionServices,gpu:GpuClient):Promise<StageResult> {
  const stage=context.run.stages[context.stageId], clips=context.run.stages["08_matting"].structured?.clips as MatteClip[]|undefined;
  if(!clips?.length)throw new WorkflowError("missing-rgba","缺少已批准的 RGBA 帧序列。");
  // Check tools before any paid inverse-render task.
  await runTool("python",["-c","import PIL,numpy"]);const version=await runTool("toktx",["--version"]);if(version.trim()!=="toktx v4.4.2")throw new WorkflowError("tool-unavailable","需要 toktx v4.4.2。");
  const workspace=await Workspace.create(services, context.run.canvasId), graph=actionGraphSchema.parse(context.run.stages["04_action_design"].structured);
  const streams:Record<string,unknown>[]=[];
  const checkpoints=(stage.structured?.segments??{}) as Record<string,Artifact>;
  try{
    for(const [clipIndex,clip] of clips.entries()){
      const archive=await workspace.materialize(clip.archive,`rgba-${clipIndex}.zip`), dir=await workspace.directory(`rgba-${clipIndex}`);
      await unpackFile(archive,dir,context.isStopped);
      const sequence=JSON.parse(await readFile(join(dir,"sequence.json"),"utf8")) as {frames:number;width:number;height:number;straightAlpha:boolean};
      if(sequence.frames!==clip.frames||!sequence.straightAlpha)throw new WorkflowError("invalid-rgba","RGBA 帧序列信息不一致。");
      const transform=planGbufferResolution([sequence.width,sequence.height]), frames:Frame[]=[];
      for(const [segmentIndex,window] of temporalWindows(clip.frames).entries()){
        const segmentKey=`${clip.key}:${segmentIndex}`, output=await workspace.directory(`channels-${clipIndex}-${segmentIndex}`);
        if(checkpoints[segmentKey]){const cached=await workspace.materialize(checkpoints[segmentKey],`channels-${clipIndex}-${segmentIndex}.zip`);await unpackFile(cached,output,context.isStopped);}
        else{
          const rgbDir=await workspace.directory(`inverse-rgb-${clipIndex}-${segmentIndex}`), maskDir=await workspace.directory(`inverse-mask-${clipIndex}-${segmentIndex}`);
          for(let i=0;i<window.padded;i++){
            const source=join(dir,`${String(window.start+Math.min(i,window.real-1)+1).padStart(6,"0")}.png`), name=`${String(i+1).padStart(6,"0")}.png`;
            const normalized=await sharp(source).resize(transform.scaledSize[0],transform.scaledSize[1]).extend({...transform.padding,background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
            await sharp(normalized).flatten({background:"#ffffff"}).png().toFile(join(rgbDir,name));
            await sharp(normalized).extractChannel("alpha").png().toFile(join(maskDir,name));
          }
          const video=workspace.path(`inverse-${clipIndex}-${segmentIndex}.mp4`),mask=workspace.path(`inverse-mask-${clipIndex}-${segmentIndex}.mp4`);await encode(rgbDir,video,context.isStopped);await encode(maskDir,mask,context.isStopped);
          const videoId=await gpu.upload(video,"video/mp4"),maskId=await gpu.upload(mask,"video/mp4");
          const artifacts=await gpu.execute(context,`${segmentKey}:cosmos`,{task_type:"cosmos-renderer",timeout_seconds:86400,required_gpu_memory_mb:24576,inputs:[{asset_id:videoId,role:"input"},{asset_id:maskId,role:"mask"}],parameters:{mode:"inverse",num_video_frames:window.padded,fps:24,width:transform.inferenceSize[0],height:transform.inferenceSize[1],start_frame:0,end_frame:window.padded-1,frame_stride:1,overlap_frames:Math.min(32,window.padded-1),num_steps:4,seed:1000,inference_passes:[...PASSES],normalize_normal:false,calibration:{enabled:true,sample_frames:Math.min(16,window.padded)}}});
          const index=channelIndex(artifacts);
          if(index.size===0){
            const zip=artifacts.find(a=>/\.zip$/i.test(a.name));if(!zip)throw new WorkflowError("missing-gbuffer","GPU 未返回通道 PNG 或帧包。");
            const file=workspace.path(`remote-${clipIndex}-${segmentIndex}.zip`);await gpu.download(zip,file);const remote=await workspace.directory(`remote-${clipIndex}-${segmentIndex}`);await unpackFile(file,remote,context.isStopped);
            const manifest=JSON.parse(await readFile(join(remote,"gbuffer_manifest.json"),"utf8")) as {frames:{sequence_index:number;files:Record<string,string>}[]};
            for(let i=0;i<window.real;i++)for(const pass of PASSES){const record=manifest.frames.find(f=>f.sequence_index===i);const source=record?.files[pass];if(!source)throw new WorkflowError("missing-gbuffer-frame","通道帧包缺少必需帧。");const candidate=resolve(remote,source);if(!candidate.startsWith(remote+sep))throw new WorkflowError("unsafe-path","通道帧路径非法。");const meta=await sharp(candidate).metadata();if(meta.width!==transform.inferenceSize[0]||meta.height!==transform.inferenceSize[1])throw new WorkflowError("gbuffer-size-mismatch","远端通道尺寸与请求不一致。");await sharp(candidate).extract({left:transform.padding.left,top:transform.padding.top,width:transform.scaledSize[0],height:transform.scaledSize[1]}).png().toFile(join(output,`${i}-${pass}.png`));}
          }else for(let i=0;i<window.real;i++)for(const pass of PASSES){
            const artifact=index.get(`${i}:${pass}`);if(!artifact)throw new WorkflowError("missing-gbuffer-frame",`通道 ${pass} 缺少第 ${i} 帧。`);
            const file=workspace.path(`raw-${clipIndex}-${segmentIndex}-${i}-${pass}.png`);await gpu.download(artifact,file);
            const meta=await sharp(file).metadata();if(meta.width!==transform.inferenceSize[0]||meta.height!==transform.inferenceSize[1])throw new WorkflowError("gbuffer-size-mismatch","远端通道尺寸与请求不一致。");
            await sharp(file).extract({left:transform.padding.left,top:transform.padding.top,width:transform.scaledSize[0],height:transform.scaledSize[1]}).png().toFile(join(output,`${i}-${pass}.png`));
          }
          const packed=workspace.path(`checkpoint-${clipIndex}-${segmentIndex}.zip`);await pack(output,packed);checkpoints[segmentKey]=await workspace.collect(packed,`G-buffer ${segmentKey}`,"web","application/zip");stage.structured={segments:checkpoints};await context.checkpoint();
        }
        for(let i=0;i<window.real;i++){
          const body=workspace.path(`body-${clipIndex}-${window.start+i}.png`);await sharp(join(dir,`${String(window.start+i+1).padStart(6,"0")}.png`)).resize(transform.scaledSize[0],transform.scaledSize[1]).png().toFile(body);
          frames.push(Object.fromEntries([["body",body.slice(workspace.root.length+1)],...[...PASSES].map(p=>[p,join(output,`${i}-${p}.png`).slice(workspace.root.length+1)]),["rgbSourceFrame",clip.sourceFrames[window.start+i]]]) as Frame);
        }
      }
      streams.push({key:clip.key,directionId:clip.directionId,actionId:clip.actionId,connectorFor:clip.connectorFor,frames});
    }
    const spec=workspace.path("cook.json"), out=await workspace.directory("bundle");
    await writeFile(spec,JSON.stringify({streams,actions:graph.states,transitions:graph.transitions,initialStateId:graph.initialStateId,directionPlan:context.run.stages["03_direction_plan"].structured}));
    const packageRoot=extensionRoot();
    await runTool("python",[join(packageRoot,"python/cook_creature_bundle.py"),workspace.root,spec,out,tool("toktx")],context.isStopped);
    await copyFile(join(packageRoot,"dist/creature-preview.js"),join(out,"viewer.js"));
    await writeFile(join(out,"index.html"),'<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>生物资产验收</title><div id="app"></div><script src="viewer.js"></script>');
    const files:Record<string,Artifact>={};for(const name of await readdir(out)){const type=name.endsWith(".html")?"text/html":name.endsWith(".js")?"application/javascript":name.endsWith(".json")?"application/json":name.endsWith(".png")?"image/png":"application/octet-stream";files[name]=await workspace.collect(join(out,name),name,"web",type);}
    const archive=workspace.path("creature-bundle.zip");await pack(out,archive);const bundle=await workspace.collect(archive,"下载生物资产包","web","application/zip");
    const candidate:Candidate={bundle,files,revision:stage.revision};
    return completed([{...bundle,title:"生物运行候选",text:"运行候选已准备。打开预览检查 Original、Surface、Material 和动作切换；点击下一步发布。"}],{segments:checkpoints,candidate});
  }finally{await workspace.dispose();}
}
