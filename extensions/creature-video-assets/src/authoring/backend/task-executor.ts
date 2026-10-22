import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApplicationExtensionServices } from "@woohaa3/contracts";
import { creatureDesignSchema, identityPromptLayer, backgroundPromptLayer } from "../../state/shared/creature/creature-design.js";
import { planDirections } from "../../state/shared/creature/direction.js";
import { actionGraphSchema, assertValidActionGraph } from "../../state/shared/creature/action.js";
import { ValidationError } from "../../state/shared/creature/errors.js";
import { stageDefinition } from "../../state/shared/recipe.js";
import { WorkflowError, type Artifact } from "../../state/shared/workflow.js";
import type { ExecutionContext, StageExecutor, StageResult } from "./service.js";
import { inspectImage } from "./image-check.js";
import { imageRequestParameters } from "./image-request.js";
import { setOutputState } from "./output-jobs.js";
import { task } from "./task-runner.js";
import { executeDirectionStills, executeRgbVideos } from "./production/stages/generation.js";
import { productionPlan } from "../../state/shared/production-plan.js";
import { outputModel, outputPrompt, stageOutputSlots } from "../../state/shared/stage-output.js";

function parseJson(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  try { const value: unknown = JSON.parse(trimmed); if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>; }
  catch { /* 下方输出可操作错误。 */ }
  throw new WorkflowError("invalid-structured-output", "助手未返回合法结构化结果，请修改要求后重新制作。");
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type ProductionStageBridge = (context: ExecutionContext) => Promise<StageResult>;
function planArtifact(run: ExecutionContext["run"]): Artifact {
  const plan = productionPlan(run);
  if (!plan) throw new WorkflowError("invalid-production-plan", "动作与方向无法形成制作计划。");
  return { id: `plan-${digest(plan)}`, title: "制作数量与费用范围", kind: "text", outputKey:"production-plan", text: `身份板 ${plan.identityImages} 张、母方向图 ${plan.masterImages} 张、共享起手图 ${plan.sharedStartImages} 张；视频 ${plan.videoTasks} 条，SAM3 与 Alpha GPU 任务合计 ${plan.gpuTasks} 次。\n独立锚点制图已废弃；衔接帧从实际 RGB 视频派生。\n按所选模型实际计费，未包含失败重做或新候选。\n${JSON.stringify(plan, null, 2)}` };
}
export function createTaskExecutor(services: ApplicationExtensionServices, production?: ProductionStageBridge): StageExecutor {
  const execute:StageExecutor = async context => {
    const { run, stageId } = context, stage = run.stages[stageId], definition = stageDefinition(stageId);
    const mainOutput = stageOutputSlots(run, stageId)[0]!;
    const mainPrompt = outputPrompt(stage.input, mainOutput);
    const mainModel = outputModel(stage.input, mainOutput);
    if (production && stage.operations.some(op=>op.key.startsWith("production-") && op.state !== "failed")) return production(context);
    const upstream = Object.entries(stage.inputVersions).map(([id]) => run.stages[id as keyof typeof run.stages]);
    const designState = run.stages["01_brief"].structured;
    const contextText = JSON.stringify(upstream.map(item => ({ structured: item.structured, ...(!item.structured ? {artifacts:item.artifacts.filter(artifact => artifact.kind === "text")} : {}) })));
    let artifacts: Artifact[] = [], structured: Record<string, unknown> | null = null, hardPassed = true;
    if (stageId === "01_brief" || stageId === "04_action_design") {
      const schema = stageId === "01_brief" ? creatureDesignSchema : actionGraphSchema;
      const taskPrompt = stageId === "01_brief"
        ? "原样保留 userRequest，设计生物解剖、材质、识别特征、镜像安全及动作候选；必须只有一个 Idle，并包含 terminal。"
        : "根据已批准的生物设计和方向规划设计动作图。声明事件帧、循环/收势分段、触发与硬切；不使用 blend。仅使用已批准的动作和方向。必须唯一 Idle 初始状态并包含 terminal，terminal 不能有出边，其余非 entry 状态都须有入边。帧数=round(durationSeconds*24)，事件帧严格递增且包含0和末帧；锚点指向自身动作，start.frame=0、end.frame=末帧，loop首尾anchorId相同，转换引用两端实际锚点。clipSegments通常留空[]：只有同一条视频确实包含循环和作者收势时才分段，且loop在前、stop在后，连续完整覆盖全部帧。不得仅填loop或仅填stop分段。缺省clipGeneration沿用通用规则，不凭空添加视频依赖。";
      // 第四步只根据前序步骤的结构化文本设计动作图。身份板是上游产物，
      // 但这里不需要把它再次作为视觉参考提交给 LLM；否则不支持视觉输入的
      // 语言模型会在宿主能力门禁处被误拒。第一步仍然保留用户拖入的参考图。
      const inputImages: Artifact[] = stageId === "01_brief"
        ? stage.input.referenceImages.map(ref => ({ id: ref.assetId, kind: "image", ...ref }))
        : [];
      const artifact = await task(context, services, definition.output, "language", `用户需求：${mainPrompt}\n上游：${contextText}`, inputImages, {
        system:`${taskPrompt}\n只输出满足下述 schema 的 JSON：${JSON.stringify(z.toJSONSchema(schema))}`,
        maxTokens:16384,jsonMode:true
      }, { modelKey: mainModel });
      const parsed=schema.safeParse(parseJson(artifact.text ?? ""));
      if(!parsed.success)throw new WorkflowError("invalid-structured-output",`生成结果格式有误：${parsed.error.issues.slice(0,4).map(issue=>`${issue.path.join(".")} ${issue.message}`).join("；")}`);
      structured = parsed.data as unknown as Record<string, unknown>;
      if (stageId === "01_brief") {
        const design = creatureDesignSchema.parse(structured);
        if (design.userRequest.trim() !== mainPrompt.trim() || design.actionCandidates.filter(item => item.phase === "idle").length !== 1 || !design.actionCandidates.some(item => item.phase === "terminal")) throw new WorkflowError("invalid-design", "设计必须保留原始需求，并包含唯一 Idle 与 terminal 状态。");
      } else {
        const graph = actionGraphSchema.parse(structured), design = creatureDesignSchema.parse(designState);
        try { assertValidActionGraph(graph, stage.input.directions); }
        catch(error) { if(error instanceof ValidationError)throw new WorkflowError("invalid-action-graph",error.message);throw error; }
        if (graph.states.some(state => !design.actionCandidates.some(candidate => candidate.stateId === state.stateId))) throw new WorkflowError("invalid-action-coverage", "动作图加入了设计阶段未批准的动作。");
        if (graph.states.filter(state => state.phase === "idle").length !== 1 || !graph.states.some(state => state.terminal && state.phase === "terminal")) throw new WorkflowError("invalid-action-coverage", "动作图必须包含唯一 Idle 和 terminal 状态。");
      }
      artifacts = [{ ...artifact, text: JSON.stringify(structured, null, 2) }];
      if (stageId === "04_action_design") {
        stage.structured = structured;
        artifacts.push(planArtifact(run));
      }
    } else if (stageId === "03_direction_plan") {
      const design = creatureDesignSchema.parse(designState);
      structured = planDirections(stage.input.directions, { mirrorSafety: design.mirrorSafety, mirrorDecision: stage.input.mirrorDecision }) as unknown as Record<string, unknown>;
      artifacts = [{ id: `direction-${digest(structured)}`, title: definition.output, kind: "text", text: JSON.stringify(structured, null, 2) }];
    } else if (stageId === "02_identity_board") {
      const design = creatureDesignSchema.parse(designState);
      const references = run.stages["01_brief"].input.referenceImages.map(ref => ({ id: ref.assetId, kind: "image" as const, ...ref }));
      const profile = run.productionProfile;
      if (!profile) throw new WorkflowError("camera-not-configured", "项目相机和身份板制图参数尚未配置。");
      const prompt = `${identityPromptLayer(design)}\n相机：${profile.cameraSummary}\n本张三视图身份板采用 ${String(profile.identityParameters.aspectRatio)} 输出画幅；相机摘要中的画幅描述项目场景，不改变本张身份板画幅。\n同一生物的正面、侧面、背面身份板，固定相机、比例一致，完整主体及安全留白。禁止把侧面或背面画成正面的复制。\n${backgroundPromptLayer(design.backgroundKind)}\n${mainPrompt}`;
      const parameters=imageRequestParameters(mainModel,profile.identityParameters);
      const image = await task(context, services, "三视图身份板", "image", prompt, references, parameters, { modelKey: mainModel });
      stage.artifacts = artifacts = [image]; await context.checkpoint();
      structured = { ...await inspectImage(services, image, profile.identityAspectRatio, run.canvasId), cameraHash: profile.cameraHash, promptHash: digest(prompt), modelKey: mainModel, requestParameters: parameters };
    } else if (stageId === "05_direction_stills") {
      return executeDirectionStills(context, services);
    } else if (stageId === "07_rgb_videos") {
      return executeRgbVideos(context, services);
    } else {
      if (!production) throw new WorkflowError("production-not-configured", "制作内核尚未连接：需要方向图镜像、视频帧处理、GPU 抠像与 G-buffer 验收适配。");
      const result = await production(context);
      artifacts = result.artifacts; structured = result.structured; hardPassed = result.checks.hardPassed;
      stage.artifacts = artifacts; stage.structured = structured; await context.checkpoint();
    }
    stage.artifacts = artifacts; stage.structured = structured; await context.checkpoint();
    const notes=[...definition.review];
    if(stageId === "02_identity_board" && (structured?.warningCodes as string[]|undefined)?.includes("identity_aspect_mismatch"))notes.push(`实际图片 ${structured!.width} × ${structured!.height}，与请求画幅不同；请查看三视图完整性，确认可用后继续。`);
    return { artifacts, structured, checks: { hardPassed, agent: "pass", notes } };
  };
  return async context => {
    const stage = context.run.stages[context.stageId];
    if (context.stageId === "04_action_design" && stage.targetOutputs && !stage.targetOutputs.includes("main")) {
      const scoped = {...context,outputKey:"production-plan"};
      try {
        await setOutputState(scoped,"processing");
        if (!stage.structured || !stage.artifacts.some(artifact=>artifact.outputKey==="main")) throw new WorkflowError("missing-action-design","请先制作动作设计。");
        stage.artifacts = [...stage.artifacts.filter(artifact=>artifact.outputKey!=="production-plan"),planArtifact(context.run)];
        await setOutputState(scoped,"succeeded");
        return {artifacts:stage.artifacts,structured:stage.structured,checks:{hardPassed:true,agent:"pass",notes:[]}};
      } catch (error) {
        stage.outputIssues["production-plan"]={state:"blocked",code:"missing-action-design",message:error instanceof Error?error.message:"请先制作动作设计。"};
        await setOutputState(scoped,"blocked");throw error;
      }
    }
    const multi = ["05_direction_stills","07_rgb_videos","08_matting"].includes(context.stageId);
    if (multi) return execute(context);
    const scoped = {...context,outputKey:"main"};
    try {
      await setOutputState(scoped,"processing");
      const result = await execute(scoped);
      result.artifacts = result.artifacts.map((artifact,index)=>({...artifact,outputKey:index===0?"main":"production-plan"}));
      await setOutputState(scoped,"succeeded");
      if (result.artifacts.length>1) { context.run.stages[context.stageId].outputs!["production-plan"]="succeeded"; await context.checkpoint(); }
      return result;
    } catch (error) {
      await setOutputState(scoped,error instanceof WorkflowError && error.code==="submit-unknown"?"unknown":"failed");
      context.run.stages[context.stageId].outputIssues.main={state:"failed",code:error instanceof WorkflowError?error.code:"output-failed",message:error instanceof Error?error.message:"制作失败，请重试。"};
      await context.checkpoint();throw error;
    }
  };

}
