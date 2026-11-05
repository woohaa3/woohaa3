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
  worldCameraRotationLookingAt
} from "@woohaa3/contracts";
import { auditWrap, errorResult, structured, type AgentAuthoringToolDeps } from "./tool-policy.js";
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

export function registerAssistantWorldTools(server: McpServer, deps: AgentAuthoringToolDeps): void {
  server.registerTool(
    "get_world_context",
    {
      title: "读取世界助手上下文",
      description:
        "读取宿主为本轮签发的导演区/2D 组/所选镜头范围、版本、可写模型/镜头和只读参考；镜头范围返回 camera.settings 完整配置与 sceneModels 只读空间信息，只能调整该镜头；导演区 sceneArea 返回当前发布 revision、animationOrigin 与完整 animationScript（null 表示没有动画），sceneModels 返回导演区内可写/只读模型的世界变换（含朝向）与本地包围盒，用于推导动画支点、尺寸和镜头取景，bounds 是导演区地面范围。返修前先读取原脚本，保留未要求修改的轨道和参数。目标与版本来自宿主任命，不接受模型自报；2D 组只返回只读参考。",
      inputSchema: z.strictObject({}),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => {
      const bound = worldGrant(deps);
      if (!bound) return denied("本轮没有宿主签发的世界创作上下文");
      const outcome = await bound.client.read({ canvasId: bound.canvasId, contextId: bound.world.contextId });
      if (!outcome.ok) return errorResult({ code: outcome.code, message: outcome.message } as never);
      return structured({ ...outcome.view, ok: true }, `世界范围：${outcome.view.scope.scope.kind}`);
    }
  );

  server.registerTool(
    "create_world_model",
    {
      title: "在导演区创建模型",
      description:
        "在宿主签发的导演区内创建新模型实例。transform.position 使用世界 u/v 坐标，必须落在 get_world_context.bounds 内；节点身份由宿主生成，传入的 nodeId 会被忽略。只允许完整包含在导演区的模型，2D 组范围没有此能力。",
      inputSchema: z.strictObject({
        instanceId: z.string().min(1).optional(),
        modelScript: z.string().min(1),
        // 节点身份由宿主生成；保留字段仅为兼容旧客户端，传入值被忽略。
        nodeId: z.string().min(1).optional(),
        // 兼容旧客户端传入；实际版本由宿主固定为当前支持的脚本版本。
        modelScriptVersion: z.string().min(1).optional(),
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
        const scriptVersion = PREFERRED_MODEL_SCRIPT_VERSION;
        const contentHash = hashText(JSON.stringify({
          workId: deps.grant!.workId,
          instanceId: instanceId ?? null,
          modelScript,
          modelScriptVersion: scriptVersion,
          cardPosition: cardPosition ?? null,
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
          content: { modelScript, modelScriptVersion: scriptVersion, ...(cardPosition ? { cardPosition } : {}) },
          transform: pose as WorldTransform
        };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation
        });
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
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
        cardPosition: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
        transform: transform.optional()
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ instanceId, expectedVersion, modelScript, cardPosition, transform: pose }) =>
      auditWrap(deps, "replace_world_model_content", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const scriptVersion = PREFERRED_MODEL_SCRIPT_VERSION;
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "replace-model-content",
            operationId: `${deps.grant!.workId}:replace:${instanceId}:${hashText(JSON.stringify({ expectedVersion, modelScript, modelScriptVersion: scriptVersion, cardPosition: cardPosition ?? null, transform: pose ?? null }))}`,
            instanceId,
            expectedVersion,
            content: { modelScript, modelScriptVersion: scriptVersion, ...(cardPosition ? { cardPosition } : {}) },
            ...(pose ? { transform: pose as WorldTransform } : {})
          }
        });
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
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
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已移动模型 ${instanceId}`), code: undefined };
      })
  );

  server.registerTool(
    "set_scene_animation_script",
    {
      title: "设置导演区动画脚本",
      description:
        "用 JS 动画脚本声明导演区内模型实例与镜头的运动。脚本通过注入的 motion 对象：motion.instance.tween(instanceId, { property: position|rotation|scale, startTime, endTime, from, to, easing }) 与 motion.camera.tween({ cameraId, property: position|rotation|zoom, startTime, endTime, from, to, easing })。只允许本轮可写的导演区内部部件。\n" +
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
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, "已设置导演区动画脚本"), code: undefined };
      })
  );

  server.registerTool(
    "resize_scene_area",
    {
      title: "调整导演区范围",
      description:
        "显式扩大或缩小导演区的地面范围。bounds 使用世界 u/v 米，min 不能超过 max；只改范围，不移动、不缩放模型与镜头，缩小后落在范围外的对象会变成只读。expectedScopeVersion 必须来自 get_world_context.sceneArea.scopeVersion，写入成功后会推进。范围调整必须对应用户的明确要求，不能作为取得对象写权限的隐含步骤。",
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
            result: errorResult({ code: "invalid-data", message: "bounds.min 不能超过 bounds.max" } as never),
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
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
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
          return { result: errorResult({ code: "invalid-data", message: resolved.message } as never), code: "invalid-data" };
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
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
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
            return { result: errorResult({ code: "invalid-data", message: resolved.message } as never), code: "invalid-data" };
          }
          derived = resolved.rotation;
        }
        const patch = cameraSettingsPatchPayload(settings, derived);
        if (Object.keys(patch).length === 0) {
          return {
            result: errorResult({ code: "invalid-data", message: "镜头设置至少需要一个字段" } as never),
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
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
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
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `镜头完成已留档 ${cameraId}`), code: undefined };
      })
  );
}
