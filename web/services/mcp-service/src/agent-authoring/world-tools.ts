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
import { type HumanoidInteractionInput, type AssistantWorldCompletionOutcome, type AssistantWorldContextView, type AssistantWorldFailure, type AssistantWorldWriteOutcome, PREFERRED_MODEL_SCRIPT_VERSION, type WorldRotation, type WorldTransform, executeWorldAnimationScript, analyzeWorldAnimationData, inspectWorldAnimationModelSample, worldAnimationSegmentSummary, sampleWorldAnimationInArea, somaSkeletonPrefix } from "@woohaa3/contracts";
import { auditWrap, structured, type AgentAuthoringToolDeps } from "./tool-policy.js";
import { registerWorldResourceTools } from "./world-resource-tools.js";
import { hashText } from "./planner-hash.js";

export type AssistantWorldToolClient = {
  humanoidMotion?: {
    interact?(input:HumanoidInteractionInput):Promise<Record<string,unknown>&{ok:boolean}>;
    animate(input:{canvasId:string;contextId:string;instanceId:string;prompt:string;duration:number;requestId:string;startTime?:number;rootMotion?:'in-place'|'translate';locomotion?:'scene-lap';replaceExisting?:boolean}):Promise<Record<string,unknown> & {ok:boolean}>;
    generate(input: {canvasId:string;contextId:string;instanceId:string;expectedVersion:string;prompt:string;duration:number;requestId:string}):Promise<Record<string,unknown> & {ok:boolean}>;
    get(input: {canvasId:string;contextId:string;instanceId:string;generationId?:string;assetId?:string;inspectTiming?:boolean}):Promise<Record<string,unknown> & {ok:boolean}>;
    apply(input: {canvasId:string;contextId:string;instanceId:string;generationId?:string;assetId?:string;upperBodyGenerationId?:string;expectedVersion:string;startTime:number;sourceStartTime?:number;blendInDuration?:number;loop?:boolean;rootMotion?:'in-place'|'translate';locomotion?:'scene-lap';replaceExisting?:boolean}):Promise<Record<string,unknown> & {ok:boolean}>;
  };
  read(input: { canvasId: string; contextId: string }): { ok: true; view: AssistantWorldContextView } | AssistantWorldFailure | Promise<{ ok: true; view: AssistantWorldContextView } | AssistantWorldFailure>;
  write(input: import("@woohaa3/contracts").AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome>;
  complete(input: import("@woohaa3/contracts").AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome>;
};

import { groundAabb, transform, cameraSettingsInput, cameraSettingsPatchInput, resolveCameraRotation, cameraSettingsPayload, cameraSettingsPatchPayload, cameraViewSuffix, worldGrant, denied, worldFailure, defaultAreaNote, motionConventions, channelCounting, animationBudget } from "./world-tool-shared.js";
export { worldGrant, worldFailure, denied, animationBudget } from "./world-tool-shared.js";

export function registerAssistantWorldTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  registerWorldResourceTools(server, deps);
  registerHumanoidMotionTools(server, deps);
  registerLegacyAssistantWorldTools(server, deps);
}

function registerHumanoidMotionTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  const motionBase = {instanceId:z.string().min(1)};
  const registerMotion = (name:string, schema:any, method:'animate'|'generate'|'get'|'apply'|'interact', description:string) => {
    server.registerTool(name,{description,inputSchema:schema,outputSchema:z.looseObject({ok:z.boolean()}),annotations:{readOnlyHint:method==='get',destructiveHint:false,openWorldHint:false}},async (args:any) => auditWrap(deps,name,{requestId:deps.grant?.workId},async()=>{
      const bound=worldGrant(deps);
      if(!bound?.client.humanoidMotion?.[method])return {result:denied('本轮没有人体动作生成权限')};
      const outcome=await bound.client.humanoidMotion[method]({...args,canvasId:bound.canvasId,contextId:bound.world.contextId,...((method==='generate'||method==='animate'||method==='interact')?{requestId:deps.grant!.workId}:{})});
      return {result:structured(outcome,outcome.ok?'人体动作任务状态':'人体动作操作被拒绝')};
    }));
  };
  const interactionActor=z.strictObject({instanceId:z.string().min(1),expectedVersion:z.string().min(1),prompt:z.string().min(1).max(10000),duration:z.number().finite().min(1).max(10),rootMotion:z.enum(['in-place','translate']),allowInPlaceTravel:z.boolean().optional()});
  registerMotion('animate_humanoid_interaction',z.strictObject({initiator:interactionActor,responder:interactionActor,initiatorEvent:z.enum(['leftHandForward','rightHandForward','handsForward','leftFootForward','rightFootForward'])}),'interact','双人推/击打/受击等配合必须使用此入口。选择双方真实instanceId与expectedVersion，分别写单人动作prompt，明确各自rootMotion，选择发力端伸展候选initiatorEvent（双手推用handsForward）。宿主固定生成双方素材、读取时序和根位移、校验translate路径、对齐并应用，不能跳过检查。被推开、后退、踉跄后退按translate处理；只有用户明确要求原地时才可allowInPlaceTravel:true。in-place素材根位移超过0.2米会返回movement-decision-required，必须处理不能直接报完成。原地反应可裁掉等待；translate保留完整源路径，通过双方非负起点对齐。返回kinematic-alignment-only不证明接触或自然度；失败返回phase/generationIds/appliedActors，不要重复生成满意素材、不要把部分完成说成整体完成。');
  registerMotion('animate_humanoid',z.strictObject({...motionBase,prompt:z.string().min(1).max(10000),duration:z.number().finite().min(1).max(10),startTime:z.number().finite().min(0).max(3590).optional(),rootMotion:z.enum(['in-place','translate']).optional(),locomotion:z.literal('scene-lap').optional(),replaceExisting:z.boolean().optional()}),'animate','为导演区 SOMA 人物生成并应用动作。宿主负责骨架版本核验、等待 Kimodo 任务、校验稳定 NPZ、绑定时间轴。常规人物动作只调用此工具一次，无须手动查询轮询或采样修正。默认原子替换此角色旧动作并保留其他角色与镜头。duration最大10秒。绕场一周必须传locomotion:scene-lap，宿主规划闭合路线和朝向，不能只在prompt里描述绕圈；此时prompt只描述行走挥手等姿态。rootMotion 默认 in-place；translate 按 NPZ 根位移移动整个人物，单次播放并检查路径边界。 本工具仅用于单人或互不关联的动作；双人推/击打/受击配合必须使用animate_humanoid_interaction，由宿主检查时序和位移，不能用两次本工具跳过。只有fallback.allowed=true、mode=joint-animation且taskSubmitted=false时，自动用read_world_resource(resourceType=world_model_rig)读取真实骨架并通过edit_scene_animation_script编写关节动画；已有generationId时先恢复查询，不因超时重复生成或自动兜底。');
  registerMotion('generate_humanoid_motion',z.strictObject({...motionBase,expectedVersion:z.string().min(1),prompt:z.string().min(1).max(10000),duration:z.number().finite().min(1).max(10)}),'generate','为当前导演区实际 SOMA77 角色生成动作。复用当前可用动作模型及持久化任务，不创建动作节点。返回 generationId，后续查询并应用。');
  registerMotion('get_humanoid_motion',z.strictObject({...motionBase,generationId:z.string().min(1).optional(),assetId:z.string().min(1).optional(),inspectTiming:z.boolean().optional()}),'get','查询本导演区角色的持久化动作任务（generationId），或用assetId读取此角色当前已绑定的素材；二者只选一个，旧会话缺generationId时先read_world_resource(resourceType=scene_animation_script)读取当前脚本的assetId，不要拿assetId冒充generationId。成功返回 canonical 资产身份及帧率帧数。inspectTiming:true读取校验后的NPZ，返回片内秒制的躯干倾斜、头手位移及左右脚向前运动的onsetTime/peakTime和稀疏曲线候选；不能证明击中或接触，不返回二进制或临时地址。');
  registerMotion('apply_humanoid_motion',z.strictObject({...motionBase,generationId:z.string().min(1).optional(),assetId:z.string().min(1).optional(),upperBodyGenerationId:z.string().min(1).optional(),expectedVersion:z.string().min(1),startTime:z.number().finite().min(0).max(3590),sourceStartTime:z.number().finite().min(0).max(10).optional(),blendInDuration:z.number().finite().min(0).max(1).optional(),loop:z.boolean().optional(),rootMotion:z.enum(['in-place','translate']).optional(),locomotion:z.literal('scene-lap').optional(),replaceExisting:z.boolean().optional()}),'apply','把已生成动作资产绑定到本导演区 SOMA77 角色。generationId或assetId二选一；assetId仅能重用此角色当前已绑定素材，适合旧会话缺任务ID的时序返修。保留现有动画源码，通过宿主租约与版本校验保存；默认原地播放保留根高度。replaceExisting:true原子替换此角色旧轨道并保留其他角色及镜头，不先清空。sourceStartTime为NPZ片内起点，默认0；事件的导演台时间=startTime+片内事件时间-sourceStartTime。裁切默认0.12秒入场过渡（blendInDuration可覆盖），过渡占用既有时间而不延后事件。仅原地动作支持裁切或过渡，位移/绕场仍用完整素材。不要使用负startTime。');

}

function registerLegacyAssistantWorldTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  server.registerTool(
    "get_world_context",
    {
      title: "读取世界助手上下文",
      description:
        "读取宿主签发的范围、bounds、版本、可写模型/镜头和只读参考摘要；不返回脚本源码。sceneArea 提供 areaId、resourceVersion、animationOrigin、hasAnimation；原脚本和资源版本通过 read_world_resource 查询。场景模型的标准SOMA人物只返回骨架摘要，常规动作直接调用 animate_humanoid；仅编辑骨骼时通过 read_world_resource 读取 world_model_rig 详情。新导演区默认 4×4 米；大场景先用 edit_scene_area 的 update 与 patch.bounds 扩区，再重读上下文。读取不授予写权限。",
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
        return { ...modelSummary, somaMotion: { skeletonId: "somaskel77", jointCount: 77, jointPrefix: prefix, tool: "animate_humanoid", interactionTool: "animate_humanoid_interaction" }, animationRig: { spatial: animationRig?.spatial, detailsTool: "read_world_resource", resourceType: "world_model_rig" } };
      });
      if (!deps.grant?.tools.includes("read_world_resource")) return structured({ ...outcome.view, ...(sceneModels ? { sceneModels } : {}), animationBudget: animationBudget(outcome.view.sceneArea?.animationScript), motionConventions, ok: true }, "世界上下文（旧工具协议）");
      const { modelScripts, sceneCameras, resourceVersions, ...summary } = outcome.view;
      void modelScripts; void sceneCameras; void resourceVersions;
      const { animationScript, ...areaSummary } = summary.sceneArea ?? {};
      return structured({ ...summary, ...(sceneModels ? { sceneModels: sceneModels.map(({ animationRig, ...model }) => { void animationRig; return model; }) } : {}), ...(summary.sceneArea ? { sceneArea: { ...areaSummary, hasAnimation: !!animationScript, animationVersion: outcome.view.resourceVersions?.[`scene_animation_script:${summary.sceneArea.areaId}`] } } : {}), animationBudget: animationBudget(outcome.view.sceneArea?.animationScript), motionConventions, ok: true }, `世界范围：${outcome.view.scope.scope.kind}`);
    }
  );

  server.registerTool("get_world_model_rig", {
    title: "读取模型动画部件",
    description: "读取本轮导演区模型的实际编译部件 ID、父子层级、绑定姿态与保存的 rig。返回 transform、空间前向/地面锚点与动画预算。motionReference 若存在，返回实际 longAxisLocal、肢体链与由绑定姿态推导的 armsDownPose；walkProfile 非 null 时支持共用接地行走生成；只能使用返回的真实 group ID；不推测关节。",
    inputSchema: z.strictObject({ instanceId: z.string().min(1) }),
    outputSchema: z.looseObject({ ok: z.boolean() }),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ instanceId }) => {
    const bound = worldGrant(deps);
    if (!bound) return denied("本轮没有宿主签发的世界创作上下文");
    const result = await bound.client.read({ canvasId: bound.canvasId, contextId: bound.world.contextId });
    if (!result.ok) return worldFailure(result);
    if (result.view.scope.scope.kind !== "scene-area") return denied("本轮不是导演区范围");
    const model = result.view.sceneModels?.find(model => model.instanceId === instanceId);
    if (!model) return worldFailure({ code: "outside-scope", message: `模型 ${instanceId} 不在本轮读取范围` });
    if (!model.animationRig) return worldFailure({ code: "not-ready", message: `模型 ${instanceId} 的动画部件无法编译` });
    return structured({ ok: true, instanceId, transform: model.transform, animationRig: model.animationRig, animationBudget: animationBudget(result.view.sceneArea?.animationScript), motionConventions }, "实际模型动画部件");
  });

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

  server.registerTool(
    "create_world_model",
    {
      title: "在导演区创建模型",
      description:
        "在宿主签发的导演区内创建新模型实例。transform.position 是模型根的世界 u/v/h，不等于脚底；变换后的稳定地面锚点须落在 get_world_context.bounds 内（边线算内部）；" + defaultAreaNote + "节点身份由宿主生成，传入的 nodeId 会被忽略。人形使用绑定姿态脚底锚点，其他已准备模型使用几何底部中心；身体越界不影响归属，2D 组范围没有此能力。失败回执会带 code/失败类别（如 outside-scope、version-conflict、version-unknown）与处理建议：outside-scope 表示超出本轮 bounds，version-conflict/version-unknown 表示版本已变化或无法确认，需重新 get_world_context 取真实版本后重试，不要伪造版本。",
      inputSchema: z.strictObject({
        instanceId: z.string().min(1).optional(),
        // 省略或传空串 = 只建骨架：先拿到稳定身份与版本，再分段追加。
        modelScript: z.string().optional(),
        // 节点身份由宿主生成；保留字段仅为兼容旧客户端，传入值被忽略。
        nodeId: z.string().min(1).optional(),
        // 兼容旧客户端传入；实际版本由宿主固定为当前支持的脚本版本。
        modelScriptVersion: z.string().min(1).optional(),
        // 新建模型的卡片落点；缺省由画布按非重叠规则决定。
        cardPosition: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
        transform
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ instanceId, modelScript, cardPosition, transform: pose }) =>
      auditWrap(deps, "create_world_model", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const script = modelScript ?? "";
        const scriptVersion = PREFERRED_MODEL_SCRIPT_VERSION;
        const contentHash = hashText(JSON.stringify({
          workId: deps.grant!.workId,
          instanceId: instanceId ?? null,
          modelScript: script,
          modelScriptVersion: scriptVersion,
          transform: pose
        }));
        // 始终由宿主派生稳定 id：不信任模型传入的节点身份（常被误填为导演区节点），
        // 同一工具调用重试幂等，不同模型互不冲突。
        const resolvedNodeId = `asset-model3d-${contentHash}`;
        const operation = {
          kind: "create-model" as const,
          operationId: `${deps.grant!.workId}:create:${resolvedNodeId}:${contentHash}`,
          nodeId: resolvedNodeId,
          ...(instanceId ? { instanceId } : {}),
          content: { modelScript: script, modelScriptVersion: scriptVersion, ...(cardPosition ? { cardPosition } : {}) },
          transform: pose as WorldTransform
        };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return {
          result: structured({ ...outcome, ok: true, modelScriptLength: script.length },
            script === "" ? `已创建骨架模型 ${outcome.instanceId ?? resolvedNodeId}，脚本为空，待分段填充` : `已创建模型 ${outcome.instanceId ?? resolvedNodeId}`),
          code: undefined
        };
      })
  );

  server.registerTool(
    "replace_world_model_content",
    {
      title: "替换导演区模型内容",
      description:
        "替换宿主可写集合中模型的权威内容并保留共享世界实例身份；expectedVersion 必须是本轮上下文里的真实版本。",
      inputSchema: z.strictObject({
        instanceId: z.string().min(1),
        expectedVersion: z.string().min(1),
        modelScript: z.string().min(1),
        modelScriptVersion: z.string().min(1).optional(),
        transform: transform.optional()
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ instanceId, expectedVersion, modelScript, transform: pose }) =>
      auditWrap(deps, "replace_world_model_content", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const scriptVersion = PREFERRED_MODEL_SCRIPT_VERSION;
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "replace-model-content",
            operationId: `${deps.grant!.workId}:replace:${instanceId}:${hashText(JSON.stringify({ expectedVersion, modelScript, modelScriptVersion: scriptVersion, transform: pose ?? null }))}`,
            instanceId,
            expectedVersion,
            content: { modelScript, modelScriptVersion: scriptVersion },
            ...(pose ? { transform: pose as WorldTransform } : {})
          }
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已替换模型 ${instanceId}`), code: undefined };
      })
  );

  server.registerTool(
    "get_world_model_script",
    {
      title: "读取导演区模型脚本",
      description:
        "读取宿主受控范围内某个模型的当前权威脚本、modelContentVersion 与字节长度。includeSource=false 时只返回版本与长度（分批写入前取版本、确认是否还是骨架时用），为 true 时返回完整脚本文本。本轮只读或区外的对象同样可以读取，但读取不授予写权限；追加与修补仍须目标在可写集合内。目标不存在时返回 not-found，不要猜测脚本内容。",
      inputSchema: z.strictObject({
        instanceId: z.string().min(1),
        includeSource: z.boolean().optional()
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ instanceId, includeSource }) =>
      auditWrap(deps, "get_world_model_script", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const result = await bound.client.read({ canvasId: bound.canvasId, contextId: bound.world.contextId });
        if (!result.ok) return { result: worldFailure(result) };
        const view = result.view;
        const object = view.objects.find(entry => entry.identity.kind === "instance" && entry.identity.instanceId === instanceId);
        const listed = view.writable.some(entry => entry.kind === "instance" && entry.instanceId === instanceId)
          || view.readOnly.some(entry => entry.kind === "instance" && entry.instanceId === instanceId);
        if (!listed && !object) return { result: worldFailure({ code: "outside-scope", message: `模型 ${instanceId} 不在本轮可见范围` }) };
        const summary = view.sceneModels?.find(model => model.instanceId === instanceId);
        const version = object?.version ?? null;
        const writable = view.writable.some(entry => entry.kind === "instance" && entry.instanceId === instanceId);
        const script = typeof view.modelScripts?.[instanceId] === "string" ? view.modelScripts[instanceId] : null;
        const payload = {
          ok: true,
          instanceId,
          ...(summary?.nodeId ? { nodeId: summary.nodeId } : {}),
          ...(version ? { modelContentVersion: version } : {}),
          writable,
          scriptLength: script === null ? null : script.length,
          ...(includeSource ? { modelScript: script, includeSource: true } : { includeSource: false })
        };
        return {
          result: structured(payload, `模型 ${instanceId}${version ? ` 版本 ${version}` : ""}${script === null ? "；脚本不可读" : `；长度 ${script.length}`}`)
        };
      })
  );

  server.registerTool(
    "append_world_model_script",
    {
      title: "追加导演区模型脚本",
      description:
        "把一段脚本片段追加到宿主可写集合中某个模型权威内容的末尾，等价于在文件尾部续写：回读脚本等于「原脚本 + 各次有效片段按顺序拼接」，不插入分隔符也不重排。每次追加都必须携带上一次回执（或 get_world_model_script / get_world_context）给出的 expectedVersion；版本不匹配返回 version-conflict 与当前真实版本，内容不变。拼接后的完整脚本会重新编译与校验，片段语法不完整或占地未知时整段被拒绝、已提交内容保持不变。每次追加必须是可在尾部拼接的完整语句块（括号与语句闭合）。同一 requestId 同参数重试返回首次回执，不会重复拼接；同 requestId 不同参数返回 request-id-reused。目标不在本轮可写集合返回 outside-scope。",
      inputSchema: z.strictObject({
        instanceId: z.string().min(1),
        expectedVersion: z.string().min(1),
        chunk: z.string().min(1)
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ instanceId, expectedVersion, chunk }) =>
      auditWrap(deps, "append_world_model_script", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "append-model-script",
            // 片段内容进入 identity：同一 requestId 换片段必须报 request-id-reused，
            // 同参数重传才命中冻结回执而不重复拼接。
            operationId: `${deps.grant!.workId}:append:${instanceId}:${hashText(JSON.stringify({ expectedVersion, chunk }))}`,
            instanceId,
            expectedVersion,
            chunk
          }
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已追加模型 ${instanceId} 的脚本，当前长度 ${outcome.scriptLength ?? "?"}，版本 ${outcome.version ?? "?"}`), code: undefined };
      })
  );

  server.registerTool(
    "patch_world_model_script",
    {
      title: "修补导演区模型脚本",
      description:
        "用精确文本替换修补宿主可写集合中某个模型脚本的一处内容（oldString → newString），语义与编辑器 edit 一致。oldString 必须在当前脚本中恰好命中一次：未命中返回 patch-not-found 并附带脚本长度与最近相似片段，命中多处返回 patch-ambiguous 并附带命中次数与每处行号，oldString 等于 newString 返回 patch-noop（不推进版本）。携带 expectedVersion，版本不匹配返回 version-conflict 与当前真实版本。只做精确文本替换，不做重排、格式化或结构化改写；回执 replaced 表示替换处数（成功恒为 1）。",
      inputSchema: z.strictObject({
        instanceId: z.string().min(1),
        expectedVersion: z.string().min(1),
        oldString: z.string().min(1),
        newString: z.string()
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ instanceId, expectedVersion, oldString, newString }) =>
      auditWrap(deps, "patch_world_model_script", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "patch-model-script",
            operationId: `${deps.grant!.workId}:patch:${instanceId}:${hashText(JSON.stringify({ expectedVersion, oldString, newString }))}`,
            instanceId,
            expectedVersion,
            oldString,
            newString
          }
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已修补模型 ${instanceId} 的脚本，替换 ${outcome.replaced ?? 1} 处，版本 ${outcome.version ?? "?"}`), code: undefined };
      })
  );

  server.registerTool(
    "move_world_model",
    {
      title: "移动导演区模型",
      description:
        "用完整世界变换移动宿主可写集合中的模型。位置/高度都经过权威原子占用；部分包含与只读参考会被拒绝。",
      inputSchema: z.strictObject({
        instanceId: z.string().min(1),
        expectedVersion: z.string().min(1),
        transform
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ instanceId, expectedVersion, transform: pose }) =>
      auditWrap(deps, "move_world_model", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "set-model-transform",
            operationId: `${deps.grant!.workId}:move:${instanceId}:${hashText(JSON.stringify({ expectedVersion, transform: pose }))}`,
            instanceId,
            expectedVersion,
            transform: pose as WorldTransform
          }
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已移动模型 ${instanceId}`), code: undefined };
      })
  );

  server.registerTool(
    "set_scene_animation_script",
    {
      title: "设置导演区动画脚本",
      description:
        "行走优先使用共用 motion.instance.walk(instanceId, {startTime:0,endTime:duration,path:[[u0,v0],[u1,v1],[u2,v2],[u3,v3]],cornerRadius:0.6,strideLength,stepHeight,scale,baseYawDegrees,profile})。profile 必须原样取 get_world_model_rig 返回的 animationRig.walkProfile；null 表示不支持，不能伪造。path 是相对 animationOrigin 的地面锚点闭合路线，不重复首点；至少三个点，不自交，圆角自动保持路径和切线连续。scale 取当前 transform.scale；直立模型 baseYawDegrees=2*atan2(transform.rotation[2],transform.rotation[3])*180/Math.PI。腿长 L=min(左右 upperLength+lowerLength)*scale，建议 strideLength=0.8*L、stepHeight=0.12*L；均为世界米。strideLength 是同一只脚两次落地之间的完整步幅；未指定时长时，按路线长度/strideLength 估算周期数，再选每周期约 0.8~1.2 秒，避免长路线短时长造成高频小碎步。若可达性校验拒绝，缩短步幅或为路径增加转弯半径/空间，不伪造 profile。每次声明在 startTime..endTime 绕一周，按路程同步整数个步态周期、转向沿路径切线、支撑脚目标固定并由双骨 IK 求解膝/踝，手臂作对侧摆动。闭合路线从首个圆角出口起步；规划时允许这一偏移并保留合理转弯空间。仅支持返回实际 profile 的直立 humanoid-v1，不能混入同模型独立 instance/part 轨道；其他模型仍用显式轨道。旧脚本返修需要改用 walk 时移除该模型旧轨道，保留其它模型/镜头。生成器不处理地形、碰撞、避障或视觉验收；检查采样和 warnings。\n" +
        "先 get_world_context 读取 animationBudget（最多 256 个逻辑通道；按 kind/target/part/property 去重，同通道多次 tween 或 cycle 只算一个通道，非调用次数或骨骼总数），再 get_world_model_rig 读取真实部件、spatial.forwardLocal 与 rootToGroundHeightMeters。人形模型局部 +Z 对应世界 -v；基础朝向为零时，沿 (du,dv) 前进的偏航角为 atan2(du,-dv)*180/Math.PI，有基础转向须合成计算。脚底路线应扣除旋转/缩放后的 groundAnchorLocal 水平偏移。导演区归属按稳定地面锚点判定，身体包围盒越界仅为构图诊断，不要求所有肢体都收进范围，也不为此自动扩大导演区。按模型真实前向推导 heading，以实际姿态包围盒验证接地，不把根节点当脚底；沿运动段及转角前后采样。不可为绕过通道预算降低步态频率；重复步态应使用 motion.part.cycle 保存单个可复用周期，运行时取模循环，不按时长展开。例如 motion.part.cycle(instanceId, partId, {property:\"rotation\",startTime:0,endTime:18,period:1,phase:0.5,keyframes:[{time:0,value:[-20,0,0]},{time:0.5,value:[20,0,0]},{time:1,value:[-20,0,0]}],easing:\"linear\"})，phase 为秒，左右肢体可错开 0.5 秒。关键帧时间严格递增并覆盖 0..period，首尾值必须一致。先使用 animationRig.motionReference 的实际绑定姿态、longAxisLocal 和 armsDownPose：T-pose 手臂先放下，再摆动；标准人形肩部在每个 rotation 关键帧保留放下的 Z 值并加入 X 前后摆动（左 [-20,0,-90] 到 [20,0,-90]，右 Z=90）；同一 rotation 通道的独立轨道不会相加，后轨道会覆盖前轨道。不能把水平手臂的 X 轴扭转当摆臂。肘部绕垂直于前臂长轴的轴弯曲，标准人形前臂 X 轴也是扭转，不是屈肘；前屈使用左肘负 Y、右肘正 Y，以 motionReference 的实际 flexionAxisLocal 为准；未知 rig 不猜轴。用 sample_scene_animation 对比 diagnostics.landmarksLocal 中的关节/手脚位置与 jointEndpointsInParent（parent-relative endpoint）；整体移动不能代替局部摆动。行走若出现 knee-hyperextension、sideways-motion、path-tangent-discontinuity、apparent-support-foot-drift 或 joint-twist-without-swing 警告，应修正轴与姿态并重新采样；有意轴向扭转仍可保存，按用户意图说明，不拒绝。真实关节应有各自的周期关键姿态；保存条目少不代表视觉质量好。普通 part.cycle 只是局部旋转，不会自动锁脚或同步速度。标准人形膝盖向后屈曲使用 +X，髋关节向前抬腿使用 -X；不能把两者用同一符号。超过通道预算时明确报告限制并调整经用户认可的动作设计。再用 motion.part.tween(instanceId, partId, { property: rotation, startTime, endTime, from, to, easing }) 声明局部叠加旋转：[X,Y,Z] 为模型空间欧拉角度，按 Y-X-Z 组合，与世界轴约定不同。整体摇摆不等于行走步态；关节运动应使用真实 partId。写入后自动回读精确保存的脚本并返回 motionVerification 有界数据采样。结束前必须根据用户意图处理 warnings：倒走或跳跃可能是有意设计，应核对意图后修正或明确说明；身体包围盒越界只是构图信息，不是归属违规。unavailable/partial 不代表验证通过；仍可用 sample_scene_animation 检查关键时间。只能报告数据验证，未看画面不可宣称视觉验收。用 JS 动画脚本声明导演区内模型实例与镜头的运动。脚本通过注入的 motion 对象：motion.instance.tween(instanceId, { property: position|rotation|scale, startTime, endTime, from, to, easing }) 与 motion.camera.tween({ cameraId, property: position|rotation|zoom, startTime, endTime, from, to, easing })。只允许本轮可写的导演区内部部件。\n" +
        "坐标与轴向（务必按此约定，写错轴会得到横滚而不是想要的朝向）：position 的 u/v 是动画局部坐标，先按 sceneArea.animationQuarterTurns 顺时针转相应的 90° 次数再加 animationOrigin；世界位置写回局部时应用逆旋转，h 为绝对高度（米），零方位时镜头朝 +v、上方为 +h；rotation 为欧拉角 [x, y, z] 度、按 Y-X-Z 组合，其中 x 绕 u 轴俯仰（抬头/低头）、y 绕 v 轴横滚（歪地平线，一般不要用）、z 绕 h 轴偏航（左右转头）——要让镜头转向某个物体就改 z，不要改 y；zoom 为镜头倍率，1 为原始视野，>1 更广（拉远/全景），<1 更窄（推近/特写）。from/to 长度：position 为 [u,v,h]，rotation 为 [x,y,z] 度，scale 与 zoom 为单元素数组 [值]。\n" +
        "要「从特写拉到全景」优先用 zoom，例如 motion.camera.tween({ cameraId, property: \"zoom\", startTime: 0, endTime: 4, from: [1], to: [2.2], easing: \"easeOut\" })；确实需要移动机位或转头时再加 position 与 property:\"rotation\"（只改 z）轨道。设置后请读取返回的相机朝向/地面落点，确认对准目标再结束。脚本编译一次后按时间确定性求值，播放不写规范文档。",
      inputSchema: z.strictObject({
        duration: z.number().finite().positive().max(3600),
        loop: z.boolean().optional(),
        script: z.string().min(1)
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ duration, loop, script }) =>
      auditWrap(deps, "set_scene_animation_script", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "set-scene-animation-script",
            operationId: `${deps.grant!.workId}:animation-script:${hashText(JSON.stringify({ duration, loop: loop ?? false, script }))}`,
            script,
            duration,
            loop: loop ?? false
          }
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        // Saving already succeeded. Readback or diagnostic failure must not turn
        // the committed write into a reported failure or certify another script.
        const unavailable = (reason: string) => ({ verification: "sampled-data-only" as const, status: "unavailable" as const, reason });
        let motionVerification;
        try {
          const current = await bound.client.read({ canvasId: bound.canvasId, contextId: bound.world.contextId });
          if (!current.ok) {
            motionVerification = unavailable(current.message);
          } else {
            const area = current.view.sceneArea;
            const saved = area?.animationScript;
            if (current.view.canvasId !== bound.canvasId || current.view.contextId !== bound.world.contextId ||
                current.view.scope.scope.kind !== "scene-area" || bound.world.scope.scope.kind !== "scene-area" ||
                current.view.scope.scope.areaId !== bound.world.scope.scope.areaId) {
              motionVerification = unavailable("保存后读取的上下文与本轮导演区不一致");
            } else if (!area || !saved) {
              motionVerification = unavailable("保存后未能读取导演区动画");
            } else if (area.revision < outcome.revision) {
              motionVerification = unavailable("读取的导演区版本早于本次保存，尚未验证已提交状态");
            } else if (saved.script !== script || saved.duration !== duration || saved.loop !== (loop ?? false)) {
              motionVerification = unavailable("当前动画与本次保存内容不同，可能已被并发修改");
            } else {
              const compiled = executeWorldAnimationScript(saved.script, { duration: saved.duration, loop: saved.loop });
              motionVerification = compiled.ok
                ? { ...analyzeWorldAnimationData(compiled.ir, current.view.sceneModels ?? [], area.animationOrigin, current.view.bounds, area.animationQuarterTurns), observedRevision: area.revision }
                : unavailable("已保存脚本无法编译，未执行数据验证");
            }
          }
        } catch (error) {
          motionVerification = unavailable(error instanceof Error ? error.message : "保存后数据验证不可用");
        }
        const message = motionVerification.status === "warnings"
          ? "已保存导演区动画脚本；数据采样有警告，须按用户意图处理；未进行视觉验收"
          : motionVerification.status === "unavailable"
            ? "已保存导演区动画脚本；数据验证不可用；未进行视觉验收"
            : motionVerification.status === "partial"
              ? "已保存导演区动画脚本；有界数据采样不完整，部分目标不可验证；未进行视觉验收"
              : "已保存导演区动画脚本；仅完成有界数据采样，未进行视觉验收";
        return { result: structured({ ...outcome, ok: true, motionVerification }, message), code: undefined };
      })
  );

  server.registerTool(
    "resize_scene_area",
    {
      title: "调整导演区范围",
      description:
        "显式扩大或缩小导演区的地面范围。bounds 使用世界 u/v 米，min 不能超过 max；只改范围，不移动、不缩放模型与镜头，缩小后落在范围外的对象会变成只读。expectedScopeVersion 必须来自 get_world_context.sceneArea.scopeVersion，写入成功后会推进，因此扩区后必须重新 get_world_context 才能继续写入。标准SOMA人物只返回骨架摘要，常规动作直接调用animate_humanoid；仅编辑骨骼时读取get_world_model_rig详情。新建导演区默认 4×4 米；大场景模型/镜头放不下时先用本工具（resize_scene_area）显式扩区，扩区后必须重新 get_world_context 取得新 bounds 与版本再写入，不要靠移动对象去绕过范围。范围调整必须对应用户的明确要求，不能作为取得对象写权限的隐含步骤。",
      inputSchema: z.strictObject({
        expectedScopeVersion: z.string().min(1),
        bounds: groundAabb
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ expectedScopeVersion, bounds }) =>
      auditWrap(deps, "resize_scene_area", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        if (bounds.min.u > bounds.max.u || bounds.min.v > bounds.max.v) {
          return {
            result: worldFailure({ code: "invalid-data", message: "bounds.min 不能超过 bounds.max" }),
            code: "invalid-data"
          };
        }
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "resize-scene-area",
            operationId: `${deps.grant!.workId}:area-resize:${hashText(JSON.stringify({ expectedScopeVersion, bounds }))}`,
            expectedScopeVersion,
            bounds
          }
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, "已调整导演区范围"), code: undefined };
      })
  );

  server.registerTool(
    "create_world_camera",
    {
      title: "在导演区创建镜头",
      description:
        "在宿主签发的导演区内创建一台新的世界镜头。镜头身份（nodeId/cameraId）由宿主从内容派生，传入值会被忽略；定位点（settings.position）必须落在 get_world_context.bounds 内；若镜头机身落在导演区外，宿主会自动扩大导演区把它包含进来。省略 cardPosition 时卡片会自动落在该镜头世界位置的上方，不需要为它编造画布坐标。height 轴朝上；projection 可选等距或透视；boundInstanceId 为 null 时看全世界。朝向用 settings.lookAt（世界 u/v/h 的注视点，推荐）或 settings.rotation（单位四元数 [x,y,z,w]，必须是全精度值，不要传四舍五入后的 0.7071）。只允许导演区范围，2D 组没有此能力。",
      inputSchema: z.strictObject({
        settings: cameraSettingsInput,
        cardPosition: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional()
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ settings, cardPosition }) =>
      auditWrap(deps, "create_world_camera", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const resolved = resolveCameraRotation(settings);
        if ("message" in resolved) {
          return { result: worldFailure({ code: "invalid-data", message: resolved.message }), code: "invalid-data" };
        }
        const payload = cameraSettingsPayload(settings, resolved.rotation);
        const contentHash = hashText(JSON.stringify({ workId: deps.grant!.workId, settings: payload, cardPosition: cardPosition ?? null }));
        const cameraId = `asset-camera-${contentHash}`;
        const nodeId = `asset-camera-node-${contentHash}`;
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "create-world-camera",
            operationId: `${deps.grant!.workId}:camera-create:${nodeId}:${contentHash}`,
            nodeId,
            cameraId,
            settings: payload,
            ...(cardPosition ? { cardPosition } : {})
          }
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已创建镜头 ${outcome.cameraId ?? cameraId}${cameraViewSuffix(outcome.view)}`), code: undefined };
      })
  );

  server.registerTool(
    "set_world_camera",
    {
      title: "调整镜头",
      description:
        "修改宿主可写集合中的透视镜头设置。settings 是增量补丁：只传要改的字段，省略的字段保留当前 canonical 值。朝向用 settings.lookAt（世界 u/v/h 的注视点，推荐，且必须同时给 position）或 settings.rotation（单位四元数 [x,y,z,w]，必须是全精度值）。每次成功写入都会更新 settingsVersion；下一次写入要么先 get_world_context，要么使用上一次返回的 settingsVersion，否则会以 version-conflict 拒绝（错误信息里带当前版本）。",
      inputSchema: z.strictObject({
        cameraId: z.string().min(1),
        expectedSettingsVersion: z.string().min(1),
        settings: cameraSettingsPatchInput
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ cameraId, expectedSettingsVersion, settings }) =>
      auditWrap(deps, "set_world_camera", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        let derived: WorldRotation | undefined;
        if (settings.lookAt || settings.rotation) {
          const resolved = resolveCameraRotation(settings);
          if ("message" in resolved) {
            return { result: worldFailure({ code: "invalid-data", message: resolved.message }), code: "invalid-data" };
          }
          derived = resolved.rotation;
        }
        const patch = cameraSettingsPatchPayload(settings, derived);
        if (Object.keys(patch).length === 0) {
          return {
            result: worldFailure({ code: "invalid-data", message: "镜头设置至少需要一个字段" }),
            code: "invalid-data"
          };
        }
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "set-world-camera",
            operationId: `${deps.grant!.workId}:camera:${cameraId}:${hashText(JSON.stringify({ expectedSettingsVersion, settings: patch }))}`,
            cameraId,
            expectedSettingsVersion,
            settings: patch
          }
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已保存镜头 ${cameraId}${cameraViewSuffix(outcome.view)}`), code: undefined };
      })
  );

  server.registerTool(
    "complete_world_camera",
    {
      title: "登记导演区镜头完成",
      description:
        "登记本轮真实写入过的镜头完成。宿主只在本轮对应应用回合到达成功终态后记录一次稳定 completionId 与镜头版本并留档；活动/失败/取消的运行以及客户端自报的 completed 都会被拒绝。重复登记同一完成身份幂等。",
      inputSchema: z.strictObject({
        cameraId: z.string().min(1),
        settingsVersion: z.string().min(1)
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ cameraId, settingsVersion }) =>
      auditWrap(deps, "complete_world_camera", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const outcome = await bound.client.complete({
          contextId: bound.world.contextId,
          completion: {
            canvasId: bound.canvasId,
            runId: bound.world.runId,
            completionId: bound.world.completionId,
            cameraId,
            settingsVersion
          },
          evidence: { grantToken: deps.grant!.token }
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `镜头完成已留档 ${cameraId}`), code: undefined };
      })
  );
}
