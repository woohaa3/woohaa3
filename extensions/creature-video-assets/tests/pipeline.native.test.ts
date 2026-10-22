import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import JSZip from "jszip";
import type { ApplicationExtensionServices, MediaMetadata } from "@woohaa3/contracts";
import { WorkflowRepository } from "../src/state/backend/repository.js";
import { WorkflowService } from "../src/authoring/backend/service.js";
import { createTaskExecutor } from "../src/authoring/backend/task-executor.js";
import { createRun, initialInput } from "../src/state/shared/workflow.js";
import { STAGES } from "../src/state/shared/recipe.js";
import { DEFAULT_PRODUCTION_PROFILE } from "../src/authoring/backend/production-profile.js";
import { GpuClient } from "../src/authoring/backend/production/providers/gpu.js";
import { executeMatting } from "../src/authoring/backend/production/stages/matting.js";
import { executePublish, type Candidate } from "../src/authoring/backend/production/stages/publish.js";
import { runTool } from "../src/authoring/backend/production/media/process.js";
import { memoryDocuments } from "./memory-documents.js";
import { actionGraphSchema, assertValidActionGraph } from "../src/state/shared/creature/action.js";
import { unpackFile } from "../src/authoring/backend/production/media/archive.js";

it.skipIf(process.env.WOOHAA_CREATURE_NATIVE_TEST!=="1")("production ZIP extraction streams files and rejects traversal",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"creature-native-zip-"));
  try{
    const out=join(dir,"out");await mkdir(out);const zip=new JSZip();zip.file("frames/000001.png",Buffer.alloc(2*1024**2,42));const file=join(dir,"frames.zip");await writeFile(file,await zip.generateAsync({type:"nodebuffer"}));await unpackFile(file,out,()=>false);expect((await readFile(join(out,"frames/000001.png"))).length).toBe(2*1024**2);
    const bad=new JSZip();bad.file("../escaped.png","payload");const unsafe=join(dir,"unsafe.zip");await writeFile(unsafe,await bad.generateAsync({type:"nodebuffer"}));await expect(unpackFile(unsafe,out,()=>false)).rejects.toThrow();await expect(readFile(join(dir,"escaped.png"))).rejects.toThrow();
  }finally{await rm(dir,{recursive:true,force:true});}
});

/** Real FFmpeg/sharp/worker/Python/toktx, controlled Task/GPU responses. Explicitly NOT a paid-service E2E. */
it.skipIf(process.env.WOOHAA_CREATURE_NATIVE_TEST!=="1")("runs all eight stages, both RGB gates, all layers, candidate publication and offline bundle",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"creature-chain-"));
  try{
    const objects=new Map<string,{bytes:Uint8Array;contentType:string}>();
    const save=async(bytes:Uint8Array,contentType:string):Promise<MediaMetadata>=>{const checksum=createHash("sha256").update(bytes).digest("hex"),storageKey=`sha256-${checksum}`;objects.set(storageKey,{bytes,contentType});return {storageKey,checksum,size:bytes.length,contentType,mediaKind:contentType.startsWith("image")?"image":contentType.startsWith("video")?"video":"other"};};
    const png=await sharp({create:{width:48,height:48,channels:3,background:"#b78c65"}}).png().toBuffer(),image=await save(png,"image/png");
    const videoFile=join(dir,"rgb.mp4"),maskFile=join(dir,"mask.mp4");
    await runTool("ffmpeg",["-v","error","-y","-f","lavfi","-i","color=c=0xb78c65:s=48x32:r=24:d=1","-an","-c:v","libx264","-pix_fmt","yuv420p",videoFile]);
    await runTool("ffmpeg",["-v","error","-y","-f","lavfi","-i","color=c=white:s=48x32:r=24","-frames:v","4","-an","-c:v","libx264","-pix_fmt","yuv420p",maskFile]);
    const video=await save(await readFile(videoFile),"video/mp4"),mask=await readFile(maskFile),alpha=await sharp({create:{width:48,height:32,channels:3,background:"#fff"}}).png().toBuffer();
    const design={schema:"project-a.creature-video-creature-design.v1",displayName:"测试生物",summary:"灰棕色四足生物",anatomy:["四足"],locomotion:"四足行走",materials:["毛发"],palette:["灰棕"],signatureFeatures:["短角"],scaleMeters:2,footBaselineNote:"水平",backgroundKind:"green_screen",forbiddenChanges:["身份"],mirrorSafety:{safe:true,asymmetricFeatures:[],handednessConstraints:[],textOrSymbolsPresent:false,userAcceptedSemanticMirroring:false},actionCandidates:[{stateId:"idle",displayName:"待机",kind:"loop",phase:"idle",durationSeconds:1/6,description:"站定",required:true,userRequested:true},{stateId:"death",displayName:"终态",kind:"one_shot",phase:"terminal",durationSeconds:1/6,description:"倒地",required:true,userRequested:true}],promptInvariants:["固定相机"],userRequest:"测试生物"};
    const graph={schema:"project-a.creature-video-action-graph.v1",fps:24,initialStateId:"idle",actionOrder:["idle","death"],transitions:[],states:["idle","death"].map(id=>({stateId:id,displayName:id,description:id,kind:id==="idle"?"loop":"one_shot",phase:id==="idle"?"idle":"terminal",directionCoverage:["6_00"],durationSeconds:1/6,fps:24,mirrorSafe:true,handednessConstraints:[],startAnchor:{anchorId:`${id}-start`,actionStateId:id,directionId:"6_00",role:"start",frame:0,description:"start",source:"direction_still",reusedFromArtifactId:null},endAnchor:{anchorId:id==="idle"?"idle-start":"death-end",actionStateId:id,directionId:"6_00",role:"end",frame:3,description:"end",source:"direction_still",reusedFromArtifactId:null},motionContract:{schema:"motion-contract.v1",fps:24,frameCount:4,rhythmToleranceFrames:1,events:[{id:"start",frame:0,instruction:"开始"},{id:"end",frame:3,instruction:"结束"}],repeatGroups:[],symmetryPairs:[]},clipSegments:[],terminal:id==="death"}))};
    (graph.transitions as unknown[]).push({transitionId:"die",fromStateId:"idle",toStateId:"death",directions:["6_00"],fromEndAnchorId:"idle-start",toStartAnchorId:"death-start",authoredConnector:"none",hardCutRequired:true});
    assertValidActionGraph(actionGraphSchema.parse(graph),["6_00"]);
    for(const state of graph.states)state.directionCoverage.push("12_00");
    const tasks=new Map<string,{modelType:string;prompt:string;parameters:Record<string,unknown>}>(),submit=vi.fn(async(input:{workerTaskKey:string;modelType:string;prompt:string;parameters:Record<string,unknown>})=>{tasks.set(input.workerTaskKey,input);return {ok:true,workerTaskKey:input.workerTaskKey,state:"queued",reused:false};});
    const services={tasks:{submit,status:vi.fn(),cancel:vi.fn(),result:async(key:string)=>{const t=tasks.get(key)!;return {workerTaskKey:key,state:"succeeded",result:t.modelType==="language"?{text:JSON.stringify(String(t.parameters.system).includes("clipGeneration")?graph:design)}:t.modelType==="image"?image:video};}},media:{resources:{read:async(key:string)=>objects.get(key)!,write:async(input:{bytes:Uint8Array;contentType:string})=>save(input.bytes,input.contentType),openRead:async(key:string)=>{const o=objects.get(key)!;return {...o,size:o.bytes.length,bytes:(async function*(){yield o.bytes;})(),cancel(){}};},writeStream:async(input:{bytes:AsyncIterable<Uint8Array>;contentType:string})=>{const chunks:Buffer[]=[];for await(const chunk of input.bytes)chunks.push(Buffer.from(chunk));return save(Buffer.concat(chunks),input.contentType);}},verify:async(key:string)=>({exists:true,metadata:await save(objects.get(key)!.bytes,objects.get(key)!.contentType)}),stat:async()=>({exists:true})},canvas:{}} as unknown as ApplicationExtensionServices;
    let uploads=0,remoteTasks=0;const paidKinds:string[]=[],remote=new Map<string,Uint8Array>();
    const request=vi.fn(async(url:URL,init:RequestInit)=>{
      if(url.pathname==="/v1/assets"){for await(const _chunk of init.body as unknown as AsyncIterable<Uint8Array>){/* consume upload */}return Response.json({asset_id:`asset_${String(++uploads).padStart(16,"0")}`});}
      if(url.pathname==="/v1/tasks"){
        const payload=JSON.parse(init.body as string);paidKinds.push(payload.task_type);const id=`task_${++remoteTasks}`,artifacts:{name:string;url:string}[]=[];
        const add=(name:string,bytes:Uint8Array)=>{const path=`/v1/assets/${id}-${name}/content`;remote.set(path,bytes);artifacts.push({name,url:path});};
        if(payload.task_type==="sam3")add("mask.mp4",mask);
        if(payload.task_type==="videomama")for(let i=0;i<4;i++)add(`frame_${String(i).padStart(6,"0")}.png`,alpha);
        if(payload.task_type==="cosmos-renderer")for(let i=0;i<payload.parameters.num_video_frames;i++)for(const pass of ["basecolor","normal","depth","roughness","metallic"]){const color=pass==="normal"?{r:128,g:128,b:255}:pass==="basecolor"?{r:183,g:140,b:101}:{r:127,g:127,b:127};add(`${i}.0.${pass}.png`,await sharp({create:{width:48,height:32,channels:3,background:color}}).png().toBuffer());}
        remote.set(`/v1/tasks/${id}`,Buffer.from(JSON.stringify({state:"succeeded",artifacts})));return Response.json({task_id:id});
      }
      const bytes=remote.get(url.pathname);if(!bytes)throw Error("unexpected request");return new Response(bytes as BodyInit);
    }) as unknown as typeof fetch;
    const gpu=new GpuClient({baseUrl:"https://gpu.example",token:"fixture",fetch:request,pollMs:1}),repository=new WorkflowRepository(memoryDocuments()),executor=createTaskExecutor(services,ctx=>ctx.stageId==="08_matting"?executeMatting(ctx,services,gpu):executePublish(ctx,services,gpu)),service=new WorkflowService(repository,executor);
    let run=createRun("canvas","creature","instance-native");run.productionProfile=structuredClone(DEFAULT_PRODUCTION_PROFILE);
    for(const definition of STAGES){
      const input={...initialInput(),directions:["6_00" as const,"12_00" as const],modelKey:`model-${definition.kind}`,prompt:definition.id==="01_brief"?"测试生物":""};
      await service.start(run,definition.id,input);await service.settled();run=await repository.read(run.canvasId,run.nodeId,run.instanceId);
      expect(run.stages[definition.id].error,definition.id).toBeNull();expect(run.stages[definition.id].status,definition.id).toBe("review");
      await service.approve(run,{stageId:definition.id,revision:run.stages[definition.id].revision,gate:run.stages[definition.id].gate,accepted:[],actor:"fixture"});
      if(definition.id==="07_rgb_videos"){
        const count=submit.mock.calls.length;await service.start(run,definition.id,input);await service.settled();run=await repository.read(run.canvasId,run.nodeId,run.instanceId);expect(submit.mock.calls.length).toBe(count+2);expect(run.stages[definition.id].status).toBe("review");await service.approve(run,{stageId:definition.id,revision:1,gate:"batch",accepted:[],actor:"fixture"});
      }
    }
    const candidate=run.stages["09_publish"].structured!.candidate as Candidate;
    expect(run.publication?.current.bundle.checksum).toBe(candidate.bundle.checksum);expect(paidKinds.sort()).toEqual(Array.from({length:4},()=>["cosmos-renderer","sam3","videomama"]).flat().sort());
    const zip=await JSZip.loadAsync(objects.get(candidate.bundle.storageKey!)!.bytes),manifest=JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.streams).toHaveLength(4);for(const stream of manifest.streams){expect(stream.frames).toHaveLength(4);expect(Object.keys(stream.pages[0]).sort()).toEqual(["baseColor","body","mask","material","shadow","surface"]);}
    expect(zip.file("viewer.js")).not.toBeNull();
    if(process.env.WOOHAA_CREATURE_NATIVE_OUTPUT){const output=process.env.WOOHAA_CREATURE_NATIVE_OUTPUT;await mkdir(output,{recursive:true});await writeFile(join(output,"bundle.zip"),objects.get(candidate.bundle.storageKey!)!.bytes);for(const name of ["index.html","viewer.js","manifest.json"]){await writeFile(join(output,name),await zip.file(name)!.async("uint8array"));}for(const name of Object.keys(manifest.files).filter(p=>p.endsWith(".png")))await writeFile(join(output,name),await zip.file(name)!.async("uint8array"));}
  }finally{await rm(dir,{recursive:true,force:true});}
},120_000);

