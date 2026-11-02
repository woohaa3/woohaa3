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
  type WorldTransform
} from "@woohaa3/contracts";
import { auditWrap, errorResult, structured, type AgentAuthoringToolDeps } from "./tool-policy.js";
import { hashText } from "./planner-hash.js";

export type AssistantWorldToolClient = {
  read(input: { canvasId: string; contextId: string }): { ok: true; view: AssistantWorldContextView } | AssistantWorldFailure;
  write(input: import("@woohaa3/contracts").AssistantWorldWriteInput): Promise<AssistantWorldWriteOutcome>;
  complete(input: import("@woohaa3/contracts").AssistantWorldCompletionInput): Promise<AssistantWorldCompletionOutcome>;
};

const point = z.strictObject({ u: z.number().finite(), v: z.number().finite(), h: z.number().finite() });
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
const cameraSettings = z.strictObject({
  position: point,
  rotation,
  projection,
  captureMode: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("static") }), z.strictObject({ kind: z.literal("dynamic") })]),
  aspect: z.strictObject({ width: z.number().finite().positive(), height: z.number().finite().positive() }),
  boundInstanceId: z.string().min(1).nullable()
});

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
        "读取宿主为本轮签发的场景区/2D 组范围、版本、可写模型/镜头和只读参考。目标与版本来自宿主任命，不接受模型自报；2D 组只返回只读参考。",
      inputSchema: z.strictObject({}),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async () => {
      const bound = worldGrant(deps);
      if (!bound) return denied("本轮没有宿主签发的世界创作上下文");
      const outcome = bound.client.read({ canvasId: bound.canvasId, contextId: bound.world.contextId });
      if (!outcome.ok) return errorResult({ code: outcome.code, message: outcome.message } as never);
      return structured({ ...outcome.view, ok: true }, `世界范围：${outcome.view.scope.scope.kind}`);
    }
  );

  server.registerTool(
    "create_world_model",
    {
      title: "在场景区创建模型",
      description:
        "在宿主签发的场景区内创建新模型实例。节点与共享世界实例身份由本次提交绑定；只允许完整包含在场景区的模型，2D 组范围没有此能力。",
      inputSchema: z.strictObject({
        nodeId: z.string().min(1),
        instanceId: z.string().min(1).optional(),
        modelScript: z.string().min(1),
        modelScriptVersion: z.string().min(1).optional(),
        cardPosition: z.strictObject({ x: z.number().finite(), y: z.number().finite() }).optional(),
        transform
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ nodeId, instanceId, modelScript, modelScriptVersion, cardPosition, transform: pose }) =>
      auditWrap(deps, "create_world_model", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const operation = {
          kind: "create-model" as const,
          operationId: `${deps.grant!.workId}:create:${nodeId}:${hashText(JSON.stringify({ instanceId: instanceId ?? null, modelScript, modelScriptVersion: modelScriptVersion ?? null, cardPosition: cardPosition ?? null, transform: pose }))}`,
          nodeId,
          ...(instanceId ? { instanceId } : {}),
          content: { modelScript, ...(modelScriptVersion ? { modelScriptVersion } : {}), ...(cardPosition ? { cardPosition } : {}) },
          transform: pose as WorldTransform
        };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation
        });
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已创建模型 ${outcome.instanceId ?? nodeId}`), code: undefined };
      })
  );

  server.registerTool(
    "replace_world_model_content",
    {
      title: "替换场景区模型内容",
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
    async ({ instanceId, expectedVersion, modelScript, modelScriptVersion, cardPosition, transform: pose }) =>
      auditWrap(deps, "replace_world_model_content", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "replace-model-content",
            operationId: `${deps.grant!.workId}:replace:${instanceId}:${hashText(JSON.stringify({ expectedVersion, modelScript, modelScriptVersion: modelScriptVersion ?? null, cardPosition: cardPosition ?? null, transform: pose ?? null }))}`,
            instanceId,
            expectedVersion,
            content: { modelScript, ...(modelScriptVersion ? { modelScriptVersion } : {}), ...(cardPosition ? { cardPosition } : {}) },
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
      title: "移动场景区模型",
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
    "set_world_camera",
    {
      title: "修改场景区镜头",
      description:
        "修改宿主可写集合中的世界镜头设置。镜头资格按空间定位点判定，不读卡片位置；旧 settingsVersion 会被拒绝。",
      inputSchema: z.strictObject({
        cameraId: z.string().min(1),
        expectedSettingsVersion: z.string().min(1),
        settings: cameraSettings
      }),
      outputSchema: z.looseObject({ ok: z.boolean() }),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ cameraId, expectedSettingsVersion, settings }) =>
      auditWrap(deps, "set_world_camera", { requestId: deps.grant?.workId }, async () => {
        const bound = worldGrant(deps);
        if (!bound) return { result: denied("本轮没有宿主签发的世界创作上下文") };
        const outcome = await bound.client.write({
          contextId: bound.world.contextId,
          operation: {
            kind: "set-world-camera",
            operationId: `${deps.grant!.workId}:camera:${cameraId}:${hashText(JSON.stringify({ expectedSettingsVersion, settings }))}`,
            cameraId,
            expectedSettingsVersion,
            settings
          }
        });
        if (!outcome.ok) return { result: errorResult({ code: outcome.code, message: outcome.message } as never), code: outcome.code };
        return { result: structured({ ...outcome, ok: true }, `已保存镜头 ${cameraId}`), code: undefined };
      })
  );

  server.registerTool(
    "complete_world_camera",
    {
      title: "登记场景区镜头完成",
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
