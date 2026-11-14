import { z } from "zod";
import { createHumanoidMotionTools, type HumanoidMotionTools } from "./motion.js";
import { composeHumanoidMotionAsset } from "./compose.js";
import { prepareHumanoidMotionAsset } from "./asset.js";
import type { AgentAuthoringToolContribution, AgentAuthoringToolRegistrar, McpToolRegistrationContext } from "@woohaa3/contracts";
import type { BackendMediaPort, BackendTaskPort } from "@woohaa3/contracts";

const motionBase = { instanceId: z.string().min(1) };

function structured(value: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: "text" as const, text: `${summary}\n${JSON.stringify(value, null, 2)}` }],
    structuredContent: value
  };
}

function denied(message: string) {
  return structured({ ok: false, code: "capability-unavailable", message }, "人体动作能力不可用");
}

function mediaPort(context: McpToolRegistrationContext): BackendMediaPort {
  const resources = {
    read: async (storageKey: string, canvasId?: string) => {
      if (!canvasId) throw new Error("媒体读取需要画布范围");
      return { bytes: await context.media.readBytes({ canvasId, storageKey, maxBytes: 128 * 1024 * 1024 }), contentType: "application/x-npz" };
    },
    write: async (input: { bytes: Uint8Array; contentType: string; canvasId?: string }) => {
      if (!input.canvasId) throw new Error("媒体写入需要画布范围");
      return context.media.writeBytes({ canvasId: input.canvasId, bytes: input.bytes, contentType: input.contentType });
    }
  };
  return {
    resources,
    async verify(storageKey, expected, scope) {
      if (!scope?.canvasId) return { exists: false, matches: false };
      try {
        const bytes = await context.media.readBytes({ canvasId: scope.canvasId, storageKey, maxBytes: 128 * 1024 * 1024 });
        const crypto = await import("node:crypto");
        const checksum = crypto.createHash("sha256").update(bytes).digest("hex");
        const matches = (expected?.size === undefined || expected.size === bytes.length) && (expected?.checksum === undefined || expected.checksum === checksum);
        return { exists: true, matches, metadata: { storageKey, size: bytes.length, checksum, contentType: expected?.contentType ?? "application/x-npz" } };
      } catch {
        return { exists: false, matches: false };
      }
    },
    async sign() { throw new Error("动作扩展不直接签发媒体地址"); },
    async importFromUrl() { throw new Error("动作扩展不接受 URL 媒体"); },
    async importBytes(input) {
      const bytes = Uint8Array.from(Buffer.from(input.bytesBase64, "base64"));
      if (!input.canvasId) throw new Error("媒体写入需要画布范围");
      const value = await context.media.writeBytes({ canvasId: input.canvasId, bytes, contentType: input.contentType });
      return value;
    },
    async importFromLocator(input) {
      if (!input.canvasId) throw new Error("媒体导入需要画布范围");
      return context.media.importLocator({ canvasId: input.canvasId, locator: input.locator, ...(input.contentType ? { contentType: input.contentType } : {}), ...(input.expected ? { expected: input.expected } : {}) });
    }
  };
}

function taskPort(context: McpToolRegistrationContext): BackendTaskPort {
  return {
    async submit(request) { return context.task.submit(request as unknown as Record<string, unknown>) as never; },
    async cancel(key) { await context.task.cancel(key); },
    async status(key) { return context.task.status(key) as never; },
    async history() { return { items: [], cursor: 0 }; },
    async canvasActivity() { return { cursor: "0", items: [] } as never; },
    async canvasActivitySince() { return { cursor: "0", items: [] } as never; },
    async canvasActivityChanges() { return { cursor: "0", items: [] } as never; }
  };
}

function createTools(context: McpToolRegistrationContext): HumanoidMotionTools | null {
  if (!context.grant?.world || !context.world) return null;
  const media = mediaPort(context);
  return createHumanoidMotionTools({
    world: context.world,
    task: taskPort(context),
    catalog: context.task.catalog,
    readBytes: context.media.readBytes,
    compose: (canvasId, walk, wave) => composeHumanoidMotionAsset(media, canvasId, walk, wave),
    materialize: (canvasId, result, createdAt) => prepareHumanoidMotionAsset(media, canvasId, result, createdAt)
  });
}

export function createHumanoidMotionContribution(available: () => boolean): AgentAuthoringToolContribution {
  return {
    id: "remote-server/kimodo-humanoid-motion",
    available,
    register(registrar: AgentAuthoringToolRegistrar, context: McpToolRegistrationContext) {
      const tools = createTools(context);
      const register = (name: string, schema: unknown, method: keyof HumanoidMotionTools, description: string) => {
        registrar.register(name, {
          description,
          inputSchema: schema,
          outputSchema: z.looseObject({ ok: z.boolean() }),
          annotations: { readOnlyHint: method === "get", destructiveHint: false, openWorldHint: false }
        }, async args => {
          if (!tools) return denied("本轮没有远端服务或导演区动作权限");
          try {
            const bound = context.grant?.world;
            const input = { ...args, canvasId: context.grant?.canvasIds[0] ?? "", contextId: bound?.contextId ?? "", requestId: context.grant?.workId ?? "" } as never;
            const result = await tools[method](input);
            return structured(result, result.ok ? "人体动作任务状态" : "人体动作操作被拒绝");
          } catch (error) {
            return denied(error instanceof Error ? error.message : "人体动作执行失败");
          }
        });
      };
      register("animate_humanoid", z.strictObject({ ...motionBase, prompt: z.string().min(1).max(10000), duration: z.number().finite().min(1).max(10), startTime: z.number().finite().min(0).max(3590).optional(), rootMotion: z.enum(["in-place", "translate"]).optional(), locomotion: z.literal("scene-lap").optional(), replaceExisting: z.boolean().optional() }), "animate", "为导演区 SOMA 人物生成并应用动作。只有 remote-server 已连接且动作模型可执行时可用。");
      register("generate_humanoid_motion", z.strictObject({ ...motionBase, expectedVersion: z.string().min(1), prompt: z.string().min(1).max(10000), duration: z.number().finite().min(1).max(10) }), "generate", "为当前导演区 SOMA77 角色生成动作，不创建动作节点。");
      register("get_humanoid_motion", z.strictObject({ ...motionBase, generationId: z.string().min(1) }), "get", "查询本导演区角色的远端动作任务和稳定资产身份。");
      register("apply_humanoid_motion", z.strictObject({ ...motionBase, generationId: z.string().min(1), upperBodyGenerationId: z.string().min(1).optional(), expectedVersion: z.string().min(1), startTime: z.number().finite().min(0).max(3590), loop: z.boolean().optional(), rootMotion: z.enum(["in-place", "translate"]).optional(), locomotion: z.literal("scene-lap").optional(), replaceExisting: z.boolean().optional() }), "apply", "把远端生成的动作资产绑定到当前导演区 SOMA77 角色。");
    }
  };
}
