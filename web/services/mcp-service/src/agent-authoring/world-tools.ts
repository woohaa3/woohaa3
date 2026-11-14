/**
 * Scoped assistant world tools (T11a).
 *
 * The tool arguments never carry a scope, lease, capability or run identity.
 * Every callback derives the host-issued context from `deps.grant.world`, which
 * was minted by the local host after resolving the canonical scope snapshot and
 * acquiring the atomic run lease. A grant without that binding is rejected
 * before any world write is attempted.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { type AssistantWorldCompletionOutcome, type AssistantWorldContextView, type AssistantWorldFailure, type AssistantWorldWriteOutcome, executeWorldAnimationScript, inspectWorldAnimationModelSample, worldAnimationSegmentSummary, sampleWorldAnimationInArea, somaSkeletonPrefix } from "@woohaa3/contracts";
import { auditWrap, structured, type AgentAuthoringToolDeps } from "./tool-policy.js";
import { registerWorldResourceTools } from "./world-resource-tools.js";

export type AssistantWorldToolClient = {
  humanoidMotion?: {
    animate(input:{canvasId:string;contextId:string;instanceId:string;prompt:string;duration:number;requestId:string;startTime?:number;rootMotion?:'in-place'|'translate';locomotion?:'scene-lap';replaceExisting?:boolean}):Promise<Record<string,unknown> & {ok:boolean}>;
    generate(input: {canvasId:string;contextId:string;instanceId:string;expectedVersion:string;prompt:string;duration:number;requestId:string}):Promise<Record<string,unknown> & {ok:boolean}>;
    get(input: {canvasId:string;contextId:string;instanceId:string;generationId?:string;assetId?:string;inspectTiming?:boolean}):Promise<Record<string,unknown> & {ok:boolean}>;
    apply(input: {canvasId:string;contextId:string;instanceId:string;generationId?:string;assetId?:string;upperBodyGenerationId?:string;expectedVersion:string;startTime:number;sourceStartTime?:number;blendInDuration?:number;loop?:boolean;rootMotion?:'in-place'|'translate';locomotion?:'scene-lap';replaceExisting?:boolean}):Promise<Record<string,unknown> & {ok:boolean}>;
  };
  read(input: { canvasId: string; contextId: string }): { ok: true; view: AssistantWorldContextView } | AssistantWorldFailure | Promise<{ ok: true; view: AssistantWorldContextView } | AssistantWorldFailure>;
  write(input: import("@woohaa3/contracts").AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome>;
  complete(input: import("@woohaa3/contracts").AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome>;
};

import { worldGrant, denied, worldFailure, motionConventions, channelCounting, animationBudget } from "./world-tool-shared.js";
export { worldGrant, worldFailure, denied, animationBudget } from "./world-tool-shared.js";

export function registerAssistantWorldTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  registerWorldResourceTools(server, deps);
  // Kimodo motion tools are contributed by remote-server. Keep the optional
  // branch only for compatibility with older embedders that explicitly inject
  // a motion client; the local host deliberately does not inject one.
  if (deps.world?.humanoidMotion || process.env.NODE_ENV === "test") registerHumanoidMotionTools(server, deps);
  registerAssistantWorldReadTools(server, deps);
}

function registerHumanoidMotionTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  const motionBase = {instanceId:z.string().min(1)};
  const registerMotion = (name:string, schema:any, method:'animate'|'generate'|'get'|'apply', description:string) => {
    server.registerTool(name,{description,inputSchema:schema,outputSchema:z.looseObject({ok:z.boolean()}),annotations:{readOnlyHint:method==='get',destructiveHint:false,openWorldHint:false}},async (args:any) => auditWrap(deps,name,{requestId:deps.grant?.workId},async()=>{
      const bound=worldGrant(deps);
      if(!bound?.client.humanoidMotion)return {result:denied('本轮没有人体动作生成权限')};
      const outcome=await bound.client.humanoidMotion[method]({...args,canvasId:bound.canvasId,contextId:bound.world.contextId,...((method==='generate'||method==='animate')?{requestId:deps.grant!.workId}:{})});
      return {result:structured(outcome,outcome.ok?'人体动作任务状态':'人体动作操作被拒绝')};
    }));
  };
  registerMotion('animate_humanoid',z.strictObject({...motionBase,prompt:z.string().min(1).max(10000),duration:z.number().finite().min(1).max(10),startTime:z.number().finite().min(0).max(3590).optional(),rootMotion:z.enum(['in-place','translate']).optional(),locomotion:z.literal('scene-lap').optional(),replaceExisting:z.boolean().optional()}),'animate','为导演区 SOMA 人物生成并应用动作。宿主负责骨架版本核验、等待 Kimodo 任务、校验稳定 NPZ、绑定时间轴。常规人物动作只调用此工具一次，无须手动查询轮询或采样修正。默认原子替换此角色旧动作并保留其他角色与镜头。duration最大10秒。绕场一周必须传locomotion:scene-lap，宿主规划闭合路线和朝向，不能只在prompt里描述绕圈；此时prompt只描述行走挥手等姿态。rootMotion 默认 in-place；translate 按 NPZ 根位移移动整个人物，单次播放并检查路径边界。 多人互动每次只描述一个角色的身体动作，startTime用于安排角色相对起点，不保证接触时刻。只有fallback.allowed=true、mode=joint-animation且taskSubmitted=false时，自动用read_world_resource(resourceType=world_model_rig)读取真实骨架并通过edit_scene_animation_script编写关节动画；已有generationId时先恢复查询，不因超时重复生成或自动兜底。');
  registerMotion('generate_humanoid_motion',z.strictObject({...motionBase,expectedVersion:z.string().min(1),prompt:z.string().min(1).max(10000),duration:z.number().finite().min(1).max(10)}),'generate','为当前导演区实际 SOMA77 角色生成动作。复用当前可用动作模型及持久化任务，不创建动作节点。返回 generationId，后续查询并应用。');
  registerMotion('get_humanoid_motion',z.strictObject({...motionBase,generationId:z.string().min(1).optional(),assetId:z.string().min(1).optional(),inspectTiming:z.boolean().optional()}),'get','查询本导演区角色的持久化动作任务（generationId），或用assetId读取此角色当前已绑定的素材；二者只选一个，旧会话缺generationId时先read_world_resource(resourceType=scene_animation_script)读取当前脚本的assetId，不要拿assetId冒充generationId。成功返回 canonical 资产身份及帧率帧数。inspectTiming:true读取校验后的NPZ，返回片内秒制的躯干倾斜、头手位移及左右脚向前运动的onsetTime/peakTime和稀疏曲线候选；不能证明击中或接触，不返回二进制或临时地址。');
  registerMotion('apply_humanoid_motion',z.strictObject({...motionBase,generationId:z.string().min(1).optional(),assetId:z.string().min(1).optional(),upperBodyGenerationId:z.string().min(1).optional(),expectedVersion:z.string().min(1),startTime:z.number().finite().min(0).max(3590),sourceStartTime:z.number().finite().min(0).max(10).optional(),blendInDuration:z.number().finite().min(0).max(1).optional(),loop:z.boolean().optional(),rootMotion:z.enum(['in-place','translate']).optional(),locomotion:z.literal('scene-lap').optional(),replaceExisting:z.boolean().optional()}),'apply','把已生成动作资产绑定到本导演区 SOMA77 角色。generationId或assetId二选一；assetId仅能重用此角色当前已绑定素材，适合旧会话缺任务ID的时序返修。保留现有动画源码，通过宿主租约与版本校验保存；默认原地播放保留根高度。replaceExisting:true原子替换此角色旧轨道并保留其他角色及镜头，不先清空。sourceStartTime为NPZ片内起点，默认0；事件的导演台时间=startTime+片内事件时间-sourceStartTime。裁切默认0.12秒入场过渡（blendInDuration可覆盖），过渡占用既有时间而不延后事件。仅原地动作支持裁切或过渡，位移/绕场仍用完整素材。不要使用负startTime。');

}

function registerAssistantWorldReadTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  server.registerTool(
    "get_world_context",
    {
      title: "读取世界助手上下文",
      description:
        "读取宿主签发的范围、bounds、版本、可写模型/镜头和只读参考摘要；不返回脚本源码。sceneArea 提供 areaId、resourceVersion、animationOrigin、hasAnimation；原脚本和资源版本通过 read_world_resource 查询。新导演区默认 4×4 米；是否允许内容提交时自动扩大范围由本轮锁定大小策略决定，工具不能自行改变该策略。读取不授予写权限。场景模型的标准 SOMA 人物只返回骨架摘要，常规动作直接调用 animate_humanoid；仅编辑骨骼时通过 read_world_resource 读取 world_model_rig 详情。",
      inputSchema: z.strictObject({}),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => {
      const bound = worldGrant(deps);
      if (!bound) return denied("本轮没有宿主签发的世界创作上下文");
      const outcome = await bound.client.read({ canvasId: bound.canvasId, contextId: bound.world.contextId });
      if (!outcome.ok) return worldFailure(outcome);
      const sceneModels = outcome.view.sceneModels?.map(model => {
        const prefix = somaSkeletonPrefix(model.animationRig?.groups ?? []);
        if (!prefix) return model;
        const { animationRig, ...modelSummary } = model;
        return { ...modelSummary, somaMotion: { skeletonId: "somaskel77", jointCount: 77, jointPrefix: prefix }, animationRig: { spatial: animationRig?.spatial } };
      });
      if (!deps.grant?.tools.includes("read_world_resource")) return structured({ ...outcome.view, ...(sceneModels ? { sceneModels } : {}), animationBudget: animationBudget(outcome.view.sceneArea?.animationScript), motionConventions, ok: true }, "世界上下文（旧工具协议）");
      const { modelScripts, sceneCameras, resourceVersions, ...summary } = outcome.view;
      void modelScripts; void sceneCameras; void resourceVersions;
      const { animationScript, ...areaSummary } = summary.sceneArea ?? {};
      return structured({ ...summary, ...(sceneModels ? { sceneModels: sceneModels.map(({ animationRig, ...model }) => { void animationRig; return model; }) } : {}), ...(summary.sceneArea ? { sceneArea: { ...areaSummary, hasAnimation: !!animationScript, animationVersion: outcome.view.resourceVersions?.[`scene_animation_script:${summary.sceneArea.areaId}`] } } : {}), animationBudget: animationBudget(outcome.view.sceneArea?.animationScript), motionConventions, ok: true }, `世界范围：${outcome.view.scope.scope.kind}`);
    }
  );

  server.registerTool("sample_scene_animation", {
    title: "采样导演区动画",
    description: "按给定时间采样当前发布脚本，返回原始世界坐标运动、局部部件四元数及每个模型合成后的前向/路径对齐、姿态保守包围盒、地面高度建议与导演区越界诊断。仅验证采样数据，不能证明视觉步态、接地或画面正确。",
    inputSchema: z.strictObject({ times: z.array(z.number().finite().nonnegative()).min(1).max(32) }),
    outputSchema: z.looseObject({ ok: z.boolean() }),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ times }) => {
    const bound = worldGrant(deps);
    if (!bound) return denied("本轮没有宿主签发的世界创作上下文");
    const result = await bound.client.read({ canvasId: bound.canvasId, contextId: bound.world.contextId });
    if (!result.ok) return worldFailure(result);
    const area = result.view.sceneArea;
    if (result.view.scope.scope.kind !== "scene-area" || !area?.animationScript) return worldFailure({ code: "invalid-data", message: "导演区没有已发布动画" });
    const script = area.animationScript;
    if (times.some(time => time > script.duration)) return worldFailure({ code: "invalid-data", message: "采样时间超过动画时长" });
    const compiled = executeWorldAnimationScript(script.script, { duration: script.duration, loop: script.loop });
    if (!compiled.ok) return worldFailure({ code: "invalid-data", message: compiled.message });
    const samples = times.map(time => {
      const sample = sampleWorldAnimationInArea(compiled.ir, time, area.animationOrigin, area.animationQuarterTurns);
      const neighboringTime = time < script.duration ? Math.min(script.duration, time + 0.01) : Math.max(0, time - 0.01);
      const neighbor = sampleWorldAnimationInArea(compiled.ir, neighboringTime, area.animationOrigin, area.animationQuarterTurns);
      const diagnostics = Object.fromEntries((result.view.sceneModels ?? []).map(model => [model.instanceId,
        inspectWorldAnimationModelSample(model, sample.instances.get(model.instanceId), neighbor.instances.get(model.instanceId), result.view.bounds, neighboringTime - time)
      ]));
      return { time, instances: Object.fromEntries(sample.instances), cameras: Object.fromEntries(sample.cameras), diagnostics };
    });
    return structured({ ok: true, verification: "sampled-data-only", animationBudget: { ...worldAnimationSegmentSummary(compiled.ir), counting: channelCounting }, motionConventions, diagnosticLimits: "Conservative posed geometry bounds only; no contact, IK, collision or visual verification", semantics: { position: "world-u-v-h; only animated channels are returned", rotation: "additive quaternion delta; not composed with base world rotation", scale: "absolute animated scale override", partRotations: "local additive quaternion delta from bind pose" }, revision: area.revision, animationRevision: script.revision, samples }, "仅完成动画数据采样；视觉效果尚未验证");
  });


}
