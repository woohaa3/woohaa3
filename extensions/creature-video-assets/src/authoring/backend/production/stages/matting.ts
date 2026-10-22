import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { WorkflowError, type Artifact } from "../../../../state/shared/workflow.js";
import { creatureDesignSchema } from "../../../../state/shared/creature/creature-design.js";
import type { ExecutionContext, StageResult } from "../../service.js";
import { Workspace } from "../media/workspace.js";
import { encode, extract, probe, runTool } from "../media/process.js";
import { extensionRoot } from "../tools.js";
import { pack } from "../media/archive.js";
import type { GpuClient, GpuArtifact } from "../providers/gpu.js";
import { executeOutputJobs, type OutputJob } from "../../output-jobs.js";
import { completed, type Clip } from "./generation.js";
import { outputPrompt, stageOutputSlots } from "../../../../state/shared/stage-output.js";

export type MatteClip = {key:string;directionId:string;actionId:string;connectorFor:string|null;frames:number;archive:Artifact;preview:Artifact;rgb:Artifact;mask:Artifact;sourceFrames:number[]};
export function maskArtifact(artifacts:GpuArtifact[]):GpuArtifact {
  const mask=artifacts.find(a=>/(?:^|[-/])mask\.mp4$/i.test(a.name))??artifacts.find(a=>/mask.*\.mp4$/i.test(a.name));
  if(!mask)throw new WorkflowError("missing-mask","SAM3 没有返回逐帧 mask.mp4。");return mask;
}
export function alphaArtifacts(artifacts:GpuArtifact[],frames:number):GpuArtifact[] {
  const alpha=artifacts.flatMap(a=>{const m=a.name.match(/(?:^|[-/])frame_(\d+)\.png$/i);return m?[{a,index:Number(m[1])}]:[];}).sort((a,b)=>a.index-b.index);
  if(alpha.length!==frames||alpha.some((a,i)=>a.index!==i+(alpha[0]?.index??0)))throw new WorkflowError("alpha-frame-mismatch","AlphaHint 帧不连续或与 RGB 帧数不同。");
  return alpha.map(a=>a.a);
}
export function assertAligned(rgb:Awaited<ReturnType<typeof probe>>,mask:Awaited<ReturnType<typeof probe>>):void {
  if(rgb.frames!==mask.frames||rgb.width!==mask.width||rgb.height!==mask.height||Math.abs(rgb.fps-mask.fps)>.01||rgb.pts.length!==mask.pts.length||rgb.pts.some((t,i)=>Math.abs(t-mask.pts[i])>1/48))throw new WorkflowError("mask-frame-mismatch","SAM 与 RGB 的帧数、尺寸、FPS 或 PTS 不一致。");
}
export async function executeMatting(context:ExecutionContext,services:ApplicationExtensionServices,gpu:GpuClient):Promise<StageResult> {
  const stage=context.run.stages[context.stageId], clips=context.run.stages["07_rgb_videos"].structured?.clips as Clip[]|undefined;
  if(!clips?.length)throw new WorkflowError("missing-clips","缺少已批准的 RGB 视频。");
  const design=creatureDesignSchema.parse(context.run.stages["01_brief"].structured), workspace=await Workspace.create(services, context.run.canvasId);
  const results=(stage.structured?.clips??[]) as MatteClip[];
  const originalContext = context;
  const slots=stageOutputSlots(context.run,context.stageId);
  try {
    const jobs:OutputJob[] = clips.map((clip,i)=>({key:clip.key,dependencies:[],execute:async()=>{
      const context = {...originalContext,outputKey:clip.key};
      await context.assertCurrent();
      const video=await workspace.materialize(clip.video,`rgb-${i}.mp4`), info=await probe(video), rgbDir=await workspace.directory(`rgb-${i}`), rgb=await extract(video,rgbDir,context.isStopped);
      const inputId=await gpu.upload(video,"video/mp4");
      const slot=slots.find(item=>item.key===clip.key);
      const samPrompt=slot?outputPrompt(stage.input,slot):design.summary;
      const sam=await gpu.execute(context,`${clip.key}:sam3`,{task_type:"sam3",timeout_seconds:5400,inputs:[{asset_id:inputId,role:"input"}],parameters:{mode:"video",prompts:[{text:samPrompt.trim()||design.summary,frame_index:0}],output_prob_thresh:.32}});
      const maskFile=workspace.path(`sam-${i}.mp4`);await gpu.download(maskArtifact(sam),maskFile);assertAligned(info,await probe(maskFile));
      const mask=await workspace.collect(maskFile,`SAM ${clip.key}`,"video","video/mp4");
      const maskId=await gpu.upload(maskFile,"video/mp4");
      const alpha=await gpu.execute(context,`${clip.key}:videomama`,{task_type:"videomama",timeout_seconds:5400,inputs:[{asset_id:inputId,role:"input"},{asset_id:maskId,role:"mask"}],parameters:{chunk_size:4}});
      const hints=alphaArtifacts(alpha,info.frames), masks=await extract(maskFile,await workspace.directory(`mask-${i}`),context.isStopped);
      const outputDir=await workspace.directory(`sequence-${i}`), previewDir=await workspace.directory(`preview-${i}`);
      const hintFiles:string[]=[];
      for(const [frame,hint] of hints.entries()) { const file=workspace.path(`hint-${i}-${frame}.png`);await gpu.download(hint,file);hintFiles.push(file); }
      const request=workspace.path(`worker-${i}.json`);await writeFile(request,JSON.stringify({root:workspace.root,width:info.width,height:info.height,rgb,masks,hints:hintFiles,output:outputDir,preview:previewDir}));
      await runTool("node",[join(extensionRoot(),"dist/creature-media-worker.js"),request],context.isStopped);
      await writeFile(join(outputDir,"sequence.json"),JSON.stringify({schema:"creature-rgba.v1",key:clip.key,width:info.width,height:info.height,fps:24,frames:info.frames,sourceFrames:clip.sourceFrames,sourceChecksum:clip.video.checksum,straightAlpha:true}));
      const archiveFile=workspace.path(`rgba-${i}.zip`);await pack(outputDir,archiveFile);
      const previewFile=workspace.path(`preview-${i}.mp4`);await encode(previewDir,previewFile,context.isStopped);
      const archive=await workspace.collect(archiveFile,`RGBA ${clip.key}`,"web","application/zip"), preview=await workspace.collect(previewFile,`透明底对照 · ${clip.actionId} · ${clip.directionId}`,"video","video/mp4",{directionId:clip.directionId,actionId:clip.actionId,outputKey:clip.key});
      results.push({key:clip.key,directionId:clip.directionId,actionId:clip.actionId,connectorFor:clip.connectorFor,frames:info.frames,archive,preview,rgb:clip.video,mask,sourceFrames:clip.sourceFrames});
      stage.structured={clips:results};stage.artifacts=results.map(c=>c.preview);await context.checkpoint();
    }}));
    await executeOutputJobs(context,jobs,new Set(results.map(result=>result.key)));
    return completed(results.map(c=>c.preview),{clips:results,fps:24,straightAlpha:true});
  } finally {await workspace.dispose();}
}
