import sharp from "sharp";
import { createHash } from "node:crypto";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { creatureDesignSchema, identityPromptLayer, backgroundPromptLayer } from "../../../../state/shared/creature/creature-design.js";
import { directionPlanSchema, masterOf } from "../../../../state/shared/creature/direction.js";
import { actionGraphSchema, type ActionState } from "../../../../state/shared/creature/action.js";
import { WorkflowError, type Artifact } from "../../../../state/shared/workflow.js";
import type { ExecutionContext, StageResult } from "../../service.js";
import { task } from "../../task-runner.js";
import { Workspace } from "../media/workspace.js";
import { encode, extract, probe, runTool } from "../media/process.js";
import { artifactForSlot, outputModel, outputPrompt, stageOutputSlots } from "../../../../state/shared/stage-output.js";

export type Clip = {key:string;directionId:string;actionId:string;connectorFor:string|null;video:Artifact;first:Artifact;last:Artifact;frames:number;sourceFrames:number[]};
export const completed = (artifacts:Artifact[], structured:Record<string,unknown>):StageResult => ({artifacts, structured, checks:{hardPassed:true,agent:"pass",notes:[]}});
export function directionPrompt(id:string):string { return `头部朝向屏幕时钟 ${id.replace("_",":")}（12:00 朝上，3:00 朝右，6:00 朝下，9:00 朝左），身体轴线与头部方向一致，禁止调换头尾。`; }
async function sheet(files:string[], output:string):Promise<void> {
  const cells = await Promise.all(files.map(file => sharp(file).resize(384,384,{fit:"contain",background:"#e4e4e4"}).png().toBuffer()));
  const columns = Math.min(4,cells.length);
  await sharp({create:{width:columns*384,height:Math.ceil(cells.length/columns)*384,channels:3,background:"#e4e4e4"}})
    .composite(cells.map((input,i) => ({input,left:i%columns*384,top:Math.floor(i/columns)*384}))).png().toFile(output);
}
export async function executeDirectionStills(context:ExecutionContext, services:ApplicationExtensionServices):Promise<StageResult> {
  const {run} = context, stage = run.stages[context.stageId];
  const design = creatureDesignSchema.parse(run.stages["01_brief"].structured), plan = directionPlanSchema.parse(run.stages["03_direction_plan"].structured);
  if (!run.productionProfile) throw new WorkflowError("camera-not-configured","缺少制作相机配置。");
  const workspace = await Workspace.create(services, run.canvasId);
  const slots = stageOutputSlots(run, context.stageId), used = new Set<string>();
  const artifacts:Artifact[] = slots.flatMap(slot => {const artifact=artifactForSlot(slot,stage.artifacts,used);return artifact?[{...artifact,outputKey:slot.key}]:[];});
  const files = new Map<string,Promise<string>>();
  const file = (direction:string):Promise<string> => {
    let pending = files.get(direction);
    if (!pending) {
      const artifact = artifacts.find(item=>item.directionId===direction);
      if (!artifact) throw new WorkflowError("missing-direction", "缺少前序方向图。");
      pending = workspace.materialize(artifact,`direction-${direction}.png`); files.set(direction,pending);
    }
    return pending;
  };
  const save = async (artifact:Artifact) => { artifacts.push(artifact); stage.artifacts=[...artifacts]; await context.checkpoint(); };
  let sameSize = true;
  try {
    const jobs:OutputJob[] = plan.generationDirections.map(directionId=>({key:`direction:${directionId}`,dependencies:[],execute:async()=>{
      const key = `direction:${directionId}`, slot = slots.find(item=>item.key===key)!;
      const prompt = ["本次只输出一张单机位、单一主体的游戏生物站定图：画面中恰好一只完整生物，居中。参考身份板仅用于保持外观，不沿用三视图排布。",identityPromptLayer(design),run.productionProfile!.cameraSummary,directionPrompt(directionId),"Idle 起始站定姿态，完整单一主体，统一比例、脚底线和安全留白。禁止拼图、动作表、分镜、帧序列、多视角、多个姿态、文字、标题与编号；不要展示后续动作或死亡过程。",backgroundPromptLayer(design.backgroundKind),outputPrompt(stage.input,slot)].join("\n");
      const image = {...await task({...context,outputKey:key},services,`站定图 ${directionId}`,"image",prompt,run.stages["02_identity_board"].artifacts,run.productionProfile!.identityParameters,{modelKey:outputModel(stage.input,slot)}),directionId,outputKey:key};
      await save(image);
    }}));
    for (const mirror of plan.mirrors) jobs.push({key:`direction:${mirror.direction}`,dependencies:[`direction:${mirror.source}`],execute:async()=>{
      const output = workspace.path(`mirror-${mirror.direction}.png`);
      await sharp(await file(mirror.source)).flop().png().toFile(output);
      files.set(mirror.direction,Promise.resolve(output));
      await save(await workspace.collect(output,`站定图 ${mirror.direction}（镜像）`,"image","image/png",{directionId:mirror.direction,outputKey:`direction:${mirror.direction}`}));
    }});
    jobs.push({key:"contact",dependencies:jobs.map(job=>job.key),execute:async()=>{
      const paths = await Promise.all(plan.selectedDirections.map(file));
      const sizes = await Promise.all(paths.map(path=>sharp(path).metadata()));
      sameSize = sizes.every(size=>size.width===sizes[0].width && size.height===sizes[0].height);
      const contact=workspace.path("directions.png");await sheet(paths,contact);
      await save(await workspace.collect(contact,"方向对照","image","image/png",{outputKey:"contact"}));
    }});
    await executeOutputJobs(context,jobs,new Set(artifacts.map(artifact=>artifact.outputKey!)));
    return {...completed(artifacts,{directions:plan.selectedDirections,masters:plan.generationDirections,mirrors:plan.mirrors,sameSize}),checks:{hardPassed:true,agent:"pass",notes:sameSize?[]:["方向图尺寸不同，请检查主体尺度与脚底线。"]}};
  } finally { await workspace.dispose(); }
}

export function orderedStates(states:ActionState[]):ActionState[] {
  const result:ActionState[] = [], remaining = [...states];
  while (remaining.length) {
    const ready = remaining.filter(state => [state.clipGeneration.startFrameFromStateId,state.clipGeneration.endFrameFromStateId].every(id => id === null || result.some(s => s.stateId === id)));
    if (!ready.length) throw new WorkflowError("invalid-clip-dependency","动作首末帧依赖成环或缺少前序动作。");
    result.push(...ready); remaining.splice(0,remaining.length,...remaining.filter(s => !ready.includes(s)));
  }
  return result;
}

export { runOutputJobs } from "../../output-jobs.js";
import { executeOutputJobs, type OutputJob } from "../../output-jobs.js";
/** Each direction has its own dependency chain. Pilot media and operations survive the batch gate. */
export async function executeRgbVideos(context:ExecutionContext, services:ApplicationExtensionServices):Promise<StageResult> {
  const {run} = context, stage = run.stages[context.stageId], graph = actionGraphSchema.parse(run.stages["04_action_design"].structured), plan = directionPlanSchema.parse(run.stages["03_direction_plan"].structured);
  const design = creatureDesignSchema.parse(run.stages["01_brief"].structured);
  const workspace = await Workspace.create(services, context.run.canvasId);
  const clips = (stage.structured?.clips ?? []) as Clip[], shared = (stage.structured?.shared ?? {}) as Record<string,Artifact>;
  const save = async () => {stage.structured = {clips,shared};stage.artifacts = clips.map(c => c.video); await context.checkpoint();};
  const directions = stage.gate === "pilot" ? [plan.generationDirections.includes("6_00") ? "6_00" : plan.generationDirections[0]] : plan.generationDirections;
  const states = orderedStates(graph.states);
  const slots = stageOutputSlots(run, context.stageId);
  const stillSlots = stageOutputSlots(run,"05_direction_stills").filter(slot => slot.modelType === "image");
  const stillModel = stillSlots.length ? outputModel(run.stages["05_direction_stills"].input,stillSlots[0]!) : run.stages["05_direction_stills"].input.modelKey;
  const sharedPending = new Map<string,Promise<Artifact>>();
  try {
    const produce = async (context:ExecutionContext,directionId:string,state:ActionState,connectorFor:string|null,connectorSource?:Clip) => {
      const key = `${directionId}|${state.stateId}|${connectorFor ?? "state"}`;
      const slot = slots.find(item => item.key === key)!;
      const seconds = Math.max(5,Math.ceil(state.durationSeconds));
      if (clips.some(c => c.key === key)) return;
      const previous = (id:string|null) => id === null ? undefined : clips.find(c => c.directionId === directionId && c.actionId === id && c.connectorFor === null);
      let first = run.stages["05_direction_stills"].artifacts.find(a => a.directionId === directionId);
      const image = state.clipGeneration.sharedStartImage;
      if (connectorSource) first = connectorSource.last;
      else if (image) {
        if (!shared[image.anchorId]) {
          let pending = sharedPending.get(image.anchorId);
          if (!pending) { pending = task({...context,outputKey:undefined},services,`共用起手图 ${image.anchorId}`,"image",[image.identity,image.action,...image.invariants,run.productionProfile!.cameraSummary,backgroundPromptLayer(design.backgroundKind)].join("\n"),run.stages["02_identity_board"].artifacts,run.productionProfile!.identityParameters,{modelKey:stillModel,stableAcrossGates:true}); sharedPending.set(image.anchorId,pending); }
          shared[image.anchorId] = await pending; await save();
        }
        first = shared[image.anchorId];
      } else if (state.phase !== "idle" && state.phase !== "loop" && state.clipGeneration.startFrameFromStateId) first = previous(state.clipGeneration.startFrameFromStateId)?.last;
      const last = connectorFor ? undefined : previous(state.clipGeneration.endFrameFromStateId)?.first;
      if (!first || (!connectorFor && state.clipGeneration.endFrameFromStateId && !last)) throw new WorkflowError("missing-clip-frame","缺少当前方向的前序视频帧。");
      const prompt = outputPrompt(stage.input,slot);
      const raw = await task(context,services,`RGB ${key}`,"video",prompt,[{...first,role:"first_frame"},...(last?[{...last,role:"last_frame"}]:[])],{durationSeconds:seconds,ratio:"adaptive",resolution:"720p",generateAudio:false,generationMode:"first_last_frame"},{modelKey:outputModel(stage.input,slot),stableAcrossGates:true});
      const index = createHash("sha256").update(key).digest("hex").slice(0,24), input = await workspace.materialize(raw,`source-${index}.mp4`), source = await probe(input);
      const frames = state.clipGeneration.timeline.mode === "keep_full" ? Math.round((state.clipGeneration.timeline.seconds ?? state.durationSeconds)*24) : state.motionContract.frameCount;
      const dir = await workspace.directory(`clip-${index}`), normalized = workspace.path(`normalized-${index}.mp4`);
      const filter = state.clipGeneration.timeline.mode === "keep_full" ? `setpts=${frames / 24 / (source.frames/source.fps)}*PTS,fps=24` : "fps=24";
      await runTool("ffmpeg",["-v","error","-y","-i",input,"-vf",filter,"-frames:v",String(frames),"-an","-c:v","libx264","-crf","16","-pix_fmt","yuv420p",normalized],context.isStopped);
      const files = await extract(normalized,dir,context.isStopped);
      if (files.length !== frames) throw new WorkflowError("short-video",`动作 ${state.displayName} 视频不足 ${frames} 帧。`);
      if (last) {const file = await workspace.materialize(last,`end-${index}.png`);await sharp(file).resize(source.width,source.height,{fit:"fill"}).png().toFile(files[files.length-1]);}
      const output = workspace.path(`rgb-${index}.mp4`); await encode(dir,output,context.isStopped);
      const video = await workspace.collect(output,`${state.displayName} · ${directionId}${connectorFor?" · 衔接":""}`,"video","video/mp4",{directionId,actionId:state.stateId,outputKey:key});
      const decoded = await extract(output,await workspace.directory(`decoded-${index}`),context.isStopped);
      const firstArtifact = await workspace.collect(decoded[0],"实际首帧","image","image/png"), lastArtifact = await workspace.collect(files[files.length-1],"实际末帧","image","image/png");
      clips.push({key,directionId,actionId:state.stateId,connectorFor,video,first:firstArtifact,last:lastArtifact,frames,sourceFrames:Array.from({length:frames},(_,i)=>state.clipGeneration.timeline.mode === "keep_full" ? Math.min(source.frames-1,Math.floor(i*source.frames/frames)) : i)});
      await save();
    };
    const completedKeys = new Set(clips.map(clip => clip.key));
    const stateJobs:OutputJob[] = [];
    for (const directionId of directions) for (const state of states) {
      if (!state.directionCoverage.some(d=>masterOf(d,plan.policy)===directionId)) continue;
      const key = `${directionId}|${state.stateId}|state`;
      const dependencies = [
        ...(state.clipGeneration.sharedStartImage || state.phase === "idle" || state.phase === "loop" || !state.clipGeneration.startFrameFromStateId ? [] : [`${directionId}|${state.clipGeneration.startFrameFromStateId}|state`]),
        ...(state.clipGeneration.endFrameFromStateId ? [`${directionId}|${state.clipGeneration.endFrameFromStateId}|state`] : [])
      ];
      stateJobs.push({key,dependencies,execute:()=>produce({...context,outputKey:key},directionId,state,null)});
    }
    if (stage.gate === "batch") {

      for (const transition of graph.transitions.filter(t=>t.authoredConnector === "stop_or_exit_clip")) {
        for (const directionId of [...new Set(transition.directions.map(d=>masterOf(d,plan.policy)))]) {
          const key = `${directionId}|${transition.toStateId}|${transition.transitionId}`;
          const sourceKey = `${directionId}|${transition.fromStateId}|state`;
          stateJobs.push({key,dependencies:[sourceKey],execute:async()=>{
            const source = clips.find(c=>c.key===sourceKey);
            if (!source) throw new WorkflowError("missing-connector-source","衔接视频缺少实际来源片段。");
            await produce({...context,outputKey:key},directionId,graph.states.find(s=>s.stateId===transition.toStateId)!,transition.transitionId,source);
          }});
        }
      }
    }
    stateJobs.push({key:"events",dependencies:stateJobs.map(job=>job.key),execute:async()=>{
      const samples = await Promise.all(clips.map((clip,i)=>workspace.materialize(clip.first,`sample-${i}.png`)));
      const contact = workspace.path("events.png"); await sheet(samples,contact);
      stage.artifacts = [...clips.map(c=>c.video),await workspace.collect(contact,"动作首帧对照","image","image/png",{outputKey:"events"})];
      await context.checkpoint();
    }});
    await executeOutputJobs(context,stateJobs,completedKeys);
    if (!clips.length) throw new WorkflowError("empty-clips","当前方向没有可制作的动作。");
    return completed(stage.artifacts,{clips,shared,gate:stage.gate,fps:24});
  } finally { await workspace.dispose(); }
}
