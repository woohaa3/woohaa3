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
import {
  type AssistantWorldCompletionOutcome,
  type AssistantWorldContextView,
  type AssistantWorldFailure,
  type AssistantWorldWriteOutcome,
  PREFERRED_MODEL_SCRIPT_VERSION,
  type WorldCameraCaptureMode,
  type WorldCameraProjection,
  type WorldCameraSettings,
  type WorldCameraSettingsPatch,
  type WorldCameraView,
  type WorldPoint,
  type WorldRotation,
  type WorldTransform,
  executeWorldAnimationScript,
  analyzeWorldAnimationData,
  inspectWorldAnimationModelSample,
  worldAnimationSegmentSummary,
  WORLD_ANIMATION_MAX_CHANNELS,
  sampleWorldAnimationInArea,
  worldCameraRotationLookingAt
} from "@woohaa3/contracts";
import { auditWrap, structured, type AgentAuthoringToolDeps } from "./tool-policy.js";
import { hashText } from "./planner-hash.js";

export type AssistantWorldToolClient = {
  read(input: { canvasId: string; contextId: string }): { ok: true; view: AssistantWorldContextView } | AssistantWorldFailure | Promise<{ ok: true; view: AssistantWorldContextView } | AssistantWorldFailure>;
  write(input: import("@woohaa3/contracts").AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome>;
  complete(input: import("@woohaa3/contracts").AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome>;
};

const point = z.strictObject({ u: z.number().finite(), v: z.number().finite(), h: z.number().finite() });
const groundPoint = z.strictObject({ u: z.number().finite(), v: z.number().finite() });
const groundAabb = z.strictObject({ min: groundPoint, max: groundPoint });
const rotation = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
const transform = z.strictObject({
  version: z.literal("shared-world-v1"),
  position: point,
  rotation,
  scale: z.number().finite().positive()
});
const projection = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("isometric"),
    verticalSizeMeters: z.number().finite().positive(),
    nearMeters: z.number().finite().positive(),
    farMeters: z.number().finite().positive()
  }),
  z.strictObject({
    kind: z.literal("perspective"),
    verticalFovRadians: z.number().finite().positive(),
    nearMeters: z.number().finite().positive(),
    farMeters: z.number().finite().positive()
  })
]);
const captureMode = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("static") }), z.strictObject({ kind: z.literal("dynamic") })]);
const aspect = z.strictObject({ width: z.number().finite().positive(), height: z.number().finite().positive() });
const boundInstanceId = z.string().min(1).nullable();

/**
 * Camera settings for creation. The orientation is supplied either as a unit
 * quaternion (`rotation`) or as a point to look at (`lookAt`, preferred: the host
 * derives an exact quaternion, so no hand-rounded decimals can fail the write).
 */
const cameraSettingsInput = z.strictObject({
  position: point,
  rotation: rotation.optional(),
  lookAt: point.optional(),
  projection,
  captureMode,
  aspect,
  boundInstanceId
});

/** Scoped adjustment: every field is optional and omitted fields keep their canonical value. */
const cameraSettingsPatchInput = z.strictObject({
  position: point.optional(),
  rotation: rotation.optional(),
  lookAt: point.optional(),
  projection: projection.optional(),
  captureMode: captureMode.optional(),
  aspect: aspect.optional(),
  boundInstanceId: boundInstanceId.optional()
});

type CameraSettingsInput = {
  position: WorldPoint;
  rotation?: WorldRotation;
  lookAt?: WorldPoint;
  projection: WorldCameraProjection;
  captureMode: WorldCameraCaptureMode;
  aspect: { width: number; height: number };
  boundInstanceId: string | null;
};

type CameraSettingsPatchInput = {
  position?: WorldPoint;
  rotation?: WorldRotation;
  lookAt?: WorldPoint;
  projection?: WorldCameraProjection;
  captureMode?: WorldCameraCaptureMode;
  aspect?: { width: number; height: number };
  boundInstanceId?: string | null;
};

/** `lookAt` wins over `rotation`; a returned message means no orientation could be derived. */
function resolveCameraRotation(input: {
  position?: WorldPoint;
  rotation?: WorldRotation;
  lookAt?: WorldPoint;
}): { rotation: WorldRotation } | { message: string } {
  if (input.lookAt) {
    if (!input.position) return { message: "使用 lookAt 时必须同时提供 position" };
    const rotation = worldCameraRotationLookingAt(input.position, input.lookAt);
    if (!rotation) return { message: "lookAt 与机位重合或方向垂直，无法确定镜头朝向" };
    return { rotation };
  }
  return input.rotation ? { rotation: input.rotation } : { message: "镜头设置需要 rotation 或 lookAt" };
}

function cameraSettingsPayload(input: CameraSettingsInput, rotation: WorldRotation): WorldCameraSettings {
  return {
    position: input.position,
    rotation,
    projection: input.projection,
    captureMode: input.captureMode,
    aspect: input.aspect,
    boundInstanceId: input.boundInstanceId
  };
}

function cameraSettingsPatchPayload(input: CameraSettingsPatchInput, rotation?: WorldRotation): WorldCameraSettingsPatch {
  const patch: WorldCameraSettingsPatch = {};
  if (input.position) patch.position = input.position;
  if (input.projection) patch.projection = input.projection;
  if (input.captureMode) patch.captureMode = input.captureMode;
  if (input.aspect) patch.aspect = input.aspect;
  if (input.boundInstanceId !== undefined) patch.boundInstanceId = input.boundInstanceId;
  const resolved = rotation ?? input.rotation;
  if (resolved) patch.rotation = resolved;
  return patch;
}

/**
 * Human-readable camera view appended to camera-write results. A successful write
 * only proves the value was stored; handing back where the lens points lets the
 * caller notice a backwards or rolled camera instead of claiming a framing.
 */
function cameraViewSuffix(view: WorldCameraView | undefined): string {
  if (!view) return "";
  const n = (value: number) => Number(value.toFixed(3));
  const forward = `朝向 (u,v,h)=(${n(view.forward.u)}, ${n(view.forward.v)}, ${n(view.forward.h)})`;
  const ground = view.groundIntersection
    ? `地面落点 (u,v)=(${n(view.groundIntersection.u)}, ${n(view.groundIntersection.v)})`
    : "镜头水平或朝上，没有地面落点";
  return `；${forward}；${ground}`;
}

function worldGrant(deps: AgentAuthoringToolDeps) {
  const grant = deps.grant;
  if (!grant?.world || !deps.world) return null;
  return { world: grant.world, client: deps.world, canvasId: grant.canvasIds[0] ?? "" };
}

function denied(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { ok: false, code: "capability-unsupported", message } as Record<string, unknown>,
    isError: true as const
  };
}

/**
 * Host failure codes that must stay distinguishable in the assistant-visible
 * receipt. `version-unknown` is the host's reason for "cannot verify the current
 * version", so it must not be flattened into an ordinary `outside-scope`.
 */
type HostFailure = {
  code: string;
  message: string;
  conflicts?: unknown;
  spatialReason?: string;
};

const versionUnknownReason = "version-unknown";

/** Treat a host reason of `version-unknown` as its own action-visible failure kind. */
function failureKind(failure: HostFailure): "outside-scope" | "version-conflict" | "version-unknown" | string {
  if (failure.spatialReason === versionUnknownReason) return "version-unknown";
  return failure.code;
}

const kindRemedies: Record<string, string> = {
  "outside-scope": "目标不在本轮宿主签发范围内：不要填写其他范围，也不要猜测版本；改动范围须用户明确要求后再用 resize_scene_area 并重新 get_world_context。",
  "version-conflict": "目标的版本已变化：重新 get_world_context（或使用上一条写入回执的 version）取得真实版本后重试，不要复用旧版本或换对象绕过。",
  "version-unknown": "宿主无法确认目标的当前版本（通常是旧宿主或模型资源未就绪）：不要伪造版本、不要换对象绕过；如实说明无法验证该项，必要时重新 get_world_context 后再尝试。",
  "lease-conflict": "目标正被其他运行占用：如实报告占用，不要换对象绕过或伪造版本。",
  "stale-epoch": "写能力已失效：本轮不能继续写入，如实报告并等待宿主重新签发。",
  "not-ready": "目标尚未就绪：如实报告现状，不要猜测版本或伪造诊断。"
};

/**
 * Assistant-visible failure receipt. Keeps every host field (structured `code`,
 * `message`, `conflicts`, `spatialReason`) so the caller can tell outside-scope
 * and version-conflict/version-unknown apart, and adds an action hint without
 * inventing diagnostics the host did not report.
 */
function worldFailure(failure: HostFailure) {
  const kind = failureKind(failure);
  const code = failure.code;
  const remedy = kindRemedies[kind];
  const reasonLine = failure.spatialReason ? `（宿主原因：${failure.spatialReason}）` : "";
  const conflictLine = failure.conflicts ? `\n占用/冲突信息：${JSON.stringify(failure.conflicts)}` : "";
  const text = `[${kind}] ${failure.message}${reasonLine}${conflictLine}${remedy ? `\n处理建议：${remedy}` : ""}`;
  const payload: Record<string, unknown> = { code, message: failure.message, failureKind: kind };
  if (failure.spatialReason !== undefined) payload.spatialReason = failure.spatialReason;
  if (failure.conflicts !== undefined) payload.conflicts = failure.conflicts;
  if (remedy) payload.remedy = remedy;
  return { content: [{ type: "text" as const, text }], structuredContent: { ok: false, ...payload }, isError: true as const };
}

const defaultAreaSideMeters = 4;
const defaultAreaNote = `新建导演区默认 ${defaultAreaSideMeters}×${defaultAreaSideMeters} 米（以地面中心为原点，u/v 各 ±${defaultAreaSideMeters / 2} 米）；大场景须先用 resize_scene_area 显式扩区，扩区后重新 get_world_context 取得新的 bounds 与 scopeVersion 再写入。`;

const motionConventions = {
  walking: "Prefer motion.instance.walk with animationRig.walkProfile for supported upright humanoids: distance-driven strides, rounded constant-speed closed route, tangent heading and fixed stance sole targets with two-bone IK. Other profiles use explicit part animation; no guessed IK.",
  modelForward: "Use animationRig.spatial.forwardLocal in model XYZ; humanoid +Z maps to world -v at identity; unsupported profiles may be unknown",
  cameraForward: "camera local -Z; identity looks world +v",
  directorMembership: "Stable bind-pose ground anchor; humanoid foot geometry or other prepared geometry bottom-center. Body overflow is diagnostic, not automatic unbinding. Boundary is inside.",
  modelPosition: "World u/v/h; animation position replaces base position after adding sceneArea.animationOrigin to u/v",
  grounding: "Use actual posed conservative geometry bounds and rootToGroundHeightMeters; root position is not a foot contact"
};

const channelCounting = "unique kind + target + part (when applicable) + property; repeated tween calls and cycles on one channel count once; segments/keyframes count authored interpolation data, without runtime loop expansion";

function animationBudget(script?: { script: string; duration: number; loop: boolean } | null) {
  const compiled = script ? executeWorldAnimationScript(script.script, { duration: script.duration, loop: script.loop }) : null;
  return {
    maxChannels: WORLD_ANIMATION_MAX_CHANNELS,
    counting: channelCounting,
    ...(compiled?.ok ? worldAnimationSegmentSummary(compiled.ir) : {})
  };
}

export function registerAssistantWorldTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  server.registerTool(
    "get_world_context",
    {
      title: "读取世界助手上下文",
      description:
        "读取宿主为本轮签发的导演区/2D 组/所选镜头范围、版本、可写模型/镜头和只读参考；镜头范围返回 camera.settings 完整配置与 sceneModels 只读空间信息，只能调整该镜头；导演区 sceneArea 返回当前发布 revision、animationOrigin 与完整 animationScript（null 表示没有动画），sceneModels 返回导演区内可写/只读模型的世界变换（含朝向）与本地包围盒、真实 rig 空间描述，animationBudget 返回逻辑通道预算与已编写插值段、关键帧和循环的分项计数，motionConventions 区分模型 +Z 与镜头 -Z，用于推导动画支点、尺寸和镜头取景，bounds 是导演区地面范围。新建导演区默认 4×4 米；大场景须先用 resize_scene_area 显式扩区，扩区后重新 get_world_context 取得新 bounds 与 scopeVersion 再写入。返修前先读取原脚本，保留未要求修改的轨道和参数。目标与版本来自宿主任命，不接受模型自报；2D 组只返回只读参考。",
      inputSchema: z.strictObject({}),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => {
      const bound = worldGrant(deps);
      if (!bound) return denied("本轮没有宿主签发的世界创作上下文");
      const outcome = await bound.client.read({ canvasId: bound.canvasId, contextId: bound.world.contextId });
      if (!outcome.ok) return worldFailure(outcome);
      return structured({ ...outcome.view, animationBudget: animationBudget(outcome.view.sceneArea?.animationScript), motionConventions, ok: true }, `世界范围：${outcome.view.scope.scope.kind}`);
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
      const sample = sampleWorldAnimationInArea(compiled.ir, time, area.animationOrigin);
      const neighboringTime = time < script.duration ? Math.min(script.duration, time + 0.01) : Math.max(0, time - 0.01);
      const neighbor = sampleWorldAnimationInArea(compiled.ir, neighboringTime, area.animationOrigin);
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
        modelScript: z.string().min(1),
        // 节点身份由宿主生成；保留字段仅为兼容旧客户端，传入值被忽略。
        nodeId: z.string().min(1).optional(),
        // 兼容旧客户端传入；实际版本由宿主固定为当前支持的脚本版本。
        modelScriptVersion: z.string().min(1).optional(),
        transform
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ instanceId, modelScript, transform: pose }) =>
      auditWrap(deps, "create_world_model", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const scriptVersion = PREFERRED_MODEL_SCRIPT_VERSION;
        const contentHash = hashText(JSON.stringify({
          workId: deps.grant!.workId,
          instanceId: instanceId ?? null,
          modelScript,
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
          content: { modelScript, modelScriptVersion: scriptVersion },
          transform: pose as WorldTransform
        };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation
        });
        if (!outcome.ok) return { result: worldFailure(outcome), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已创建模型 ${outcome.instanceId ?? resolvedNodeId}`), code: undefined };
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
        "坐标与轴向（务必按此约定，写错轴会得到横滚而不是想要的朝向）：position 的 u/v 是相对 sceneArea.animationOrigin 的偏移、h 为绝对高度（米），零方位时镜头朝 +v、上方为 +h；rotation 为欧拉角 [x, y, z] 度、按 Y-X-Z 组合，其中 x 绕 u 轴俯仰（抬头/低头）、y 绕 v 轴横滚（歪地平线，一般不要用）、z 绕 h 轴偏航（左右转头）——要让镜头转向某个物体就改 z，不要改 y；zoom 为镜头倍率，1 为原始视野，>1 更广（拉远/全景），<1 更窄（推近/特写）。from/to 长度：position 为 [u,v,h]，rotation 为 [x,y,z] 度，scale 与 zoom 为单元素数组 [值]。\n" +
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
                ? { ...analyzeWorldAnimationData(compiled.ir, current.view.sceneModels ?? [], area.animationOrigin, current.view.bounds), observedRevision: area.revision }
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
        "显式扩大或缩小导演区的地面范围。bounds 使用世界 u/v 米，min 不能超过 max；只改范围，不移动、不缩放模型与镜头，缩小后落在范围外的对象会变成只读。expectedScopeVersion 必须来自 get_world_context.sceneArea.scopeVersion，写入成功后会推进，因此扩区后必须重新 get_world_context 才能继续写入。新建导演区默认 4×4 米；大场景模型/镜头放不下时先用本工具（resize_scene_area）显式扩区，扩区后必须重新 get_world_context 取得新 bounds 与版本再写入，不要靠移动对象去绕过范围。范围调整必须对应用户的明确要求，不能作为取得对象写权限的隐含步骤。",
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
        "在宿主签发的导演区内创建一台新的世界镜头。镜头身份（nodeId/cameraId）由宿主从内容派生，传入值会被忽略；定位点（settings.position）必须落在 get_world_context.bounds 内；若镜头机身落在导演区外，宿主会自动扩大导演区把它包含进来。height 轴朝上；projection 可选等距或透视；boundInstanceId 为 null 时看全世界。朝向用 settings.lookAt（世界 u/v/h 的注视点，推荐）或 settings.rotation（单位四元数 [x,y,z,w]，必须是全精度值，不要传四舍五入后的 0.7071）。只允许导演区范围，2D 组没有此能力。",
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
