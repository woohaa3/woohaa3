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

import { type AssistantWorldCompletionOutcome, type AssistantWorldContextView, type AssistantWorldFailure, type AssistantWorldWriteOutcome, type WorldCameraCaptureMode, type WorldCameraProjection, type WorldCameraSettings, type WorldCameraSettingsPatch, type WorldCameraView, type WorldPoint, type WorldRotation, executeWorldAnimationScript, worldAnimationSegmentSummary, WORLD_ANIMATION_MAX_CHANNELS, worldCameraRotationLookingAt } from "@woohaa3/contracts";
import { type AgentAuthoringToolDeps } from "./tool-policy.js";


export type AssistantWorldToolClient = {
  read(input: { canvasId: string; contextId: string }): { ok: true; view: AssistantWorldContextView } | AssistantWorldFailure | Promise<{ ok: true; view: AssistantWorldContextView } | AssistantWorldFailure>;
  write(input: import("@woohaa3/contracts").AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome>;
  complete(input: import("@woohaa3/contracts").AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome>;
};

export const point = z.strictObject({ u: z.number().finite(), v: z.number().finite(), h: z.number().finite() });
export const groundPoint = z.strictObject({ u: z.number().finite(), v: z.number().finite() });
export const groundAabb = z.strictObject({ min: groundPoint, max: groundPoint });
export const rotation = z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]);
export const transform = z.strictObject({
  version: z.literal("shared-world-v1"),
  position: point,
  rotation,
  scale: z.number().finite().positive()
});
export const projection = z.discriminatedUnion("kind", [
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
export const captureMode = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("static") }), z.strictObject({ kind: z.literal("dynamic") })]);
export const aspect = z.strictObject({ width: z.number().finite().positive(), height: z.number().finite().positive() });
export const boundInstanceId = z.string().min(1).nullable();

/**
 * Camera settings for creation. The orientation is supplied either as a unit
 * quaternion (`rotation`) or as a point to look at (`lookAt`, preferred: the host
 * derives an exact quaternion, so no hand-rounded decimals can fail the write).
 */
export const cameraSettingsInput = z.strictObject({
  position: point,
  rotation: rotation.optional(),
  lookAt: point.optional(),
  projection,
  captureMode,
  aspect,
  boundInstanceId
});

/** Scoped adjustment: every field is optional and omitted fields keep their canonical value. */
export const cameraSettingsPatchInput = z.strictObject({
  position: point.optional(),
  rotation: rotation.optional(),
  lookAt: point.optional(),
  projection: projection.optional(),
  captureMode: captureMode.optional(),
  aspect: aspect.optional(),
  boundInstanceId: boundInstanceId.optional()
});

export type CameraSettingsInput = {
  position: WorldPoint;
  rotation?: WorldRotation;
  lookAt?: WorldPoint;
  projection: WorldCameraProjection;
  captureMode: WorldCameraCaptureMode;
  aspect: { width: number; height: number };
  boundInstanceId: string | null;
};

export type CameraSettingsPatchInput = {
  position?: WorldPoint;
  rotation?: WorldRotation;
  lookAt?: WorldPoint;
  projection?: WorldCameraProjection;
  captureMode?: WorldCameraCaptureMode;
  aspect?: { width: number; height: number };
  boundInstanceId?: string | null;
};

/** `lookAt` wins over `rotation`; a returned message means no orientation could be derived. */
export function resolveCameraRotation(input: {
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

export function cameraSettingsPayload(input: CameraSettingsInput, rotation: WorldRotation): WorldCameraSettings {
  return {
    position: input.position,
    rotation,
    projection: input.projection,
    captureMode: input.captureMode,
    aspect: input.aspect,
    boundInstanceId: input.boundInstanceId
  };
}

export function cameraSettingsPatchPayload(input: CameraSettingsPatchInput, rotation?: WorldRotation): WorldCameraSettingsPatch {
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
export function cameraViewSuffix(view: WorldCameraView | undefined): string {
  if (!view) return "";
  const n = (value: number) => Number(value.toFixed(3));
  const forward = `朝向 (u,v,h)=(${n(view.forward.u)}, ${n(view.forward.v)}, ${n(view.forward.h)})`;
  const ground = view.groundIntersection
    ? `地面落点 (u,v)=(${n(view.groundIntersection.u)}, ${n(view.groundIntersection.v)})`
    : "镜头水平或朝上，没有地面落点";
  return `；${forward}；${ground}`;
}

export function worldGrant(deps: AgentAuthoringToolDeps) {
  const grant = deps.grant;
  if (!grant?.world || !deps.world) return null;
  return { world: grant.world, client: deps.world, canvasId: grant.canvasIds[0] ?? "" };
}

export function denied(message: string) {
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
export type HostFailure = {
  references?: Array<{ nodeId: string; kind: string }>;
  editIndex?: number;
  code: string;
  message: string;
  conflicts?: unknown;
  spatialReason?: string;
  spatialDiagnostic?: unknown;
  patchDiagnostic?: unknown;
  currentVersion?: string;
};

export const versionUnknownReason = "version-unknown";

/** Treat a host reason of `version-unknown` as its own action-visible failure kind. */
export function failureKind(failure: HostFailure): "outside-scope" | "version-conflict" | "version-unknown" | string {
  if (failure.spatialReason === versionUnknownReason) return "version-unknown";
  return failure.code;
}

export const kindRemedies: Record<string, string> = {
  "outside-scope": "目标不在本轮宿主签发范围内：不要填写其他范围，也不要猜测版本；改动范围须用户明确要求后再用 resize_scene_area 并重新 get_world_context。",
  "version-conflict": "目标的版本已变化：重新 get_world_context（或使用上一条写入回执的 version）取得真实版本后重试，不要复用旧版本或换对象绕过。",
  "version-unknown": "宿主无法确认目标的当前版本（通常是旧宿主或模型资源未就绪）：不要伪造版本、不要换对象绕过；如实说明无法验证该项，必要时重新 get_world_context 后再尝试。",
  "invalid-data": "内容被拒绝：编译、引用或占地校验没有通过，既有内容未被修改。修正脚本或参数后重试，不要原样重发；追加失败的段可在后续重试同一段。",
  "lease-conflict": "目标正被其他运行占用：如实报告占用，不要换对象绕过或伪造版本。",
  "stale-epoch": "写能力已失效：本轮不能继续写入，如实报告并等待宿主重新签发。",
  "not-ready": "目标尚未就绪：如实报告现状，不要猜测版本或伪造诊断。",
  "patch-not-found": "oldString 没有命中：用 patchDiagnostic.closest.excerpt 与 line 核对真实文本后带上更长的上下文重试；也可以 read_world_resource 重新读取脚本。",
  "patch-ambiguous": "oldString 命中多处：按 patchDiagnostic.matches 的行号把上下文加长到唯一，不要改写成全部替换。",
  "patch-noop": "oldString 与 newString 相同：内容与版本都没变化，不要重复提交，也不要换个写法掩盖。"
};

/**
 * Assistant-visible failure receipt. Keeps every host field (structured `code`,
 * `message`, `conflicts`, `spatialReason`, patch diagnostics, current version) so
 * the caller can tell outside-scope and version-conflict/version-unknown apart,
 * and adds an action hint without inventing diagnostics the host did not report.
 */
export function worldFailure(failure: HostFailure) {
  const kind = failureKind(failure);
  const code = failure.code;
  const remedy = kindRemedies[kind];
  const reasonLine = failure.spatialReason ? `（宿主原因：${failure.spatialReason}）` : "";
  const conflictLine = failure.conflicts ? `\n占用/冲突信息：${JSON.stringify(failure.conflicts)}` : "";
  const versionLine = failure.currentVersion ? `\n当前真实版本：${failure.currentVersion}` : "";
  const patchLine = failure.patchDiagnostic ? `\n修补诊断：${JSON.stringify(failure.patchDiagnostic)}` : "";
  const referencesLine = failure.references ? `\n引用：${JSON.stringify(failure.references)}` : "";
  const editLine = failure.editIndex !== undefined ? `\n失败 edits 索引：${failure.editIndex}` : "";
  const geometryLine = failure.spatialDiagnostic ? `\n空间诊断：${JSON.stringify(failure.spatialDiagnostic)}` : "";
  const text = `[${kind}] ${failure.message}${reasonLine}${conflictLine}${versionLine}${patchLine}${referencesLine}${editLine}${geometryLine}${remedy ? `\n处理建议：${remedy}` : ""}`;
  const payload: Record<string, unknown> = { code, message: failure.message, failureKind: kind };
  if (failure.spatialDiagnostic !== undefined) payload.spatialDiagnostic = failure.spatialDiagnostic;
  if (failure.spatialReason !== undefined) payload.spatialReason = failure.spatialReason;
  if (failure.conflicts !== undefined) payload.conflicts = failure.conflicts;
  if (failure.patchDiagnostic !== undefined) payload.patchDiagnostic = failure.patchDiagnostic;
  if (failure.references !== undefined) payload.references = failure.references;
  if (failure.editIndex !== undefined) payload.editIndex = failure.editIndex;
  if (failure.currentVersion !== undefined) payload.currentVersion = failure.currentVersion;
  if (remedy) payload.remedy = remedy;
  return { content: [{ type: "text" as const, text }], structuredContent: { ok: false, ...payload }, isError: true as const };
}

export const defaultAreaSideMeters = 4;
export const defaultAreaNote = `新建导演区默认 ${defaultAreaSideMeters}×${defaultAreaSideMeters} 米（以地面中心为原点，u/v 各 ±${defaultAreaSideMeters / 2} 米）；大场景须先用 resize_scene_area 显式扩区，扩区后重新 get_world_context 取得新的 bounds 与 scopeVersion 再写入。`;

export const motionConventions = {
  walking: "Prefer motion.instance.walk with animationRig.walkProfile for supported upright humanoids: distance-driven strides, rounded constant-speed closed route, tangent heading and fixed stance sole targets with two-bone IK. Other profiles use explicit part animation; no guessed IK.",
  modelForward: "Use animationRig.spatial.forwardLocal in model XYZ; humanoid +Z maps to world -v at identity; unsupported profiles may be unknown",
  cameraForward: "camera local -Z; identity looks world +v",
  directorMembership: "Stable bind-pose ground anchor; humanoid foot geometry or other prepared geometry bottom-center. Body overflow is diagnostic, not automatic unbinding. Boundary is inside.",
  modelPosition: "World u/v/h; animation position replaces base position after rotating u/v clockwise by sceneArea.animationQuarterTurns * 90 degrees and adding sceneArea.animationOrigin",
  grounding: "Use actual posed conservative geometry bounds and rootToGroundHeightMeters; root position is not a foot contact"
};

export const channelCounting = "unique kind + target + part (when applicable) + property; repeated tween calls and cycles on one channel count once; segments/keyframes count authored interpolation data, without runtime loop expansion";

export function animationBudget(script?: { script: string; duration: number; loop: boolean } | null) {
  const compiled = script ? executeWorldAnimationScript(script.script, { duration: script.duration, loop: script.loop }) : null;
  return {
    maxChannels: WORLD_ANIMATION_MAX_CHANNELS,
    counting: channelCounting,
    ...(compiled?.ok ? worldAnimationSegmentSummary(compiled.ir) : {})
  };
}

