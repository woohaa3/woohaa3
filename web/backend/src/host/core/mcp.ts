import {createHumanoidMotionTools} from "./humanoid-motion.js";
import {composeHumanoidMotionAsset} from '../../ports/humanoid-motion-compose.js';
import {prepareHumanoidMotionAsset} from "../../ports/humanoid-motion-asset.js";
import { readRuntimeGeneratedImages } from "@woohaa3/application-service";
/**
 * 核心层 · mcp：内置 MCP 服务与共享工具授权表。
 *
 * 工具授权表（`toolGrants`）由 ChatGPT 生成层签发、MCP 工具入口校验，所以同一实例要同时给
 * mcp 与 application；插件扩展的 MCP 工具清单在调用时从 application 懒取。
 */
import { createMcpService } from "@woohaa3/mcp-service";
import path from "node:path";
import { createMemoryToolGrantStore, createSqliteToolGrantStore } from "../../ports/tool-grant-store.js";
import type { SkillStepClient } from "@woohaa3/mcp-service";
import type { HostPlugin } from "../context.js";
import { READINESS_ORDER, ROUTE_ORDER } from "../order.js";
import { catalogToolsForGrant, createToolGrantRegistry } from "../../ports/authoring-adapters.js";
import { createExtensionMcpBridge } from "../../ports/extension-mcp.js";
import { agentCanvasServiceToClient, modelMcpServiceToClient } from "../../ports/mcp-adapters.js";
import { groupScopedClient } from "../../ports/group-scoped-client.js";
import { withMcpPrincipal } from "../../ports/mcp-principal.js";
import { devPrincipalIdFromEnv } from "../base/access.js";
import { decodeWorkflowGroupData } from "@woohaa3/contracts";
import { importCodexGeneratedImage } from "../../ports/import-generated-image.js";
import { canvasGroupEpoch, currentCanvasGroupScope, withCanvasGroupScope } from "@woohaa3/canvas-service";

export const mcpPlugin: HostPlugin<{ env: Record<string, string | undefined> }> = {
  name: "mcp",
  inject: ["log", "gateway", "canvas", "task", "media", "storage"],
  apply(ctx, { env }) {
    // 持久 grant registry（change: 2026-11-10-split-agent-runtime-lifecycle，任务 2.2）：
    // 与应用库同目录的独立文件，避免与业务表争锁；没有可用库路径时退回内存。
    const storePath = env.WOOHAA3_APPLICATION_STORE_PATH?.trim() || env.WOOHAA3_TASK_STORE_PATH?.trim() || "";
    const grantStore = storePath
      ? createSqliteToolGrantStore({ path: path.join(path.dirname(path.resolve(storePath)), "tool-grants.sqlite") })
      : createMemoryToolGrantStore();
    const toolGrants = createToolGrantRegistry({ store: grantStore });
    const application = () => {
      const module = ctx.get("application");
      if (!module) throw new Error("插件宿主尚未就绪");
      return module.service;
    };
    const services = ctx.canvas.mcpServices();
    /**
     * Skill 步骤续接的 MCP 适配
     * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 4.1–4.4）。
     *
     * owner 只来自受信任的请求上下文（已认证 principal），不接受工具参数自报；
     * 等待与查询不提交生成。
     */
    const skillClient: SkillStepClient = {
      async wait(input) {
        const media = application().skillMedia();
        if (!media) return { ok: false, code: "unavailable", message: "Skill 续接未启用" };
        const owner = env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "";
        if (!owner) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
        const result = await media.wait({
          owner,
          canvasId: input.canvasId,
          skillRunId: input.skillRunId,
          stepId: input.stepId,
          waitMs: input.waitMs,
          ...(input.followLatest !== undefined ? { followLatest: input.followLatest } : {})
        });
        return result.ok ? { ok: true, value: result.view } : { ok: false, code: result.code, message: result.message };
      },
      async latestOutput(input) {
        const media = application().skillMedia();
        if (!media) return { ok: false, code: "unavailable", message: "Skill 续接未启用" };
        const owner = env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "";
        if (!owner) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
        const result = await media.latestOutput({
          owner,
          canvasId: input.canvasId,
          skillRunId: input.skillRunId,
          stepId: input.stepId,
          ...(input.allowFallback !== undefined ? { allowFallback: input.allowFallback } : {})
        });
        return result.ok ? { ok: true, value: result.view } : { ok: false, code: result.code, message: result.message };
      },
      async snapshot(input) {
        const media = application().skillMedia();
        if (!media) return { ok: false, code: "unavailable", message: "Skill 续接未启用" };
        const owner = env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "";
        if (!owner) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
        const result = await media.snapshot({
          owner,
          canvasId: input.canvasId,
          skillRunId: input.skillRunId,
          stepId: input.stepId
        });
        return result.ok ? { ok: true, value: result.step } : { ok: false, code: result.code, message: result.message };
      },
      async events(input) {
        const media = application().skillMedia();
        if (!media) return { ok: false, code: "unavailable", message: "Skill 续接未启用" };
        const owner = env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "";
        if (!owner) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
        const result = await media.events({
          owner,
          canvasId: input.canvasId,
          skillRunId: input.skillRunId,
          stepId: input.stepId,
          ...(input.after !== undefined ? { after: input.after } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {})
        });
        return result.ok ? { ok: true, value: result.page } : { ok: false, code: result.code, message: result.message };
      }
    };
    const assistantWorld: import("@woohaa3/mcp-service").AssistantWorldToolClient = {
      read: (input) => {
        const world = ctx.canvas.assistantWorld;
        if (!world) return { ok: false, code: "capability-unsupported", message: "世界助手权威未装配" };
        return world.read(input);
      },
      write: async (input) => {
        const world = ctx.canvas.assistantWorld;
        if (!world) return { ok: false, code: "capability-unsupported", message: "世界助手权威未装配" };
        return world.write(input);
      },
      complete: async (input) => {
        const world = ctx.canvas.assistantWorld;
        if (!world) return { ok: false, code: "capability-unsupported", message: "世界助手权威未装配" };
        return world.complete(input);
      }
    };
    assistantWorld.humanoidMotion = createHumanoidMotionTools({
      compose: (canvasId,walk,wave) => composeHumanoidMotionAsset(ctx.media.port(),canvasId,walk,wave),
      readBytes: async ({canvasId,storageKey,maxBytes}) => {
        const bucket=ctx.storage.bucket('media',{canvasId});
        const stat=await bucket.head(storageKey);
        if(!stat||stat.size>maxBytes)throw new Error('动作资源不可读取或超出大小限制');
        return (await bucket.get(storageKey)).bytes;
      },
      world: assistantWorld,
      task: ctx.task.port(),
      catalog: () => ctx.task.catalog(),
      materialize: (canvasId, result, createdAt) => prepareHumanoidMotionAsset(ctx.media.port(),canvasId,result,createdAt)
    });
    const mcp = createMcpService({
      env,
      skillClient,
      skillAvailability: { available: true },
      assistantWorld,
      extensionTools: createExtensionMcpBridge({
        definitions: () => ctx.get("application")?.definitions ?? [],
        application,
        grants: toolGrants,
        developmentPrincipal: env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL,
        loopbackDevelopment: ["1", "true"].includes(env.WOOHAA3_AGENT_LOOPBACK_MODE ?? "")
      }),
      canvasClient: groupScopedClient(modelMcpServiceToClient(services.modelMcp), ctx.canvas),
      // 每请求可信主体由网关按 bearer grant 注入（见下方 route）；此处的静态值只作缺省回退，
      // 与本地单实例 owner（`dev-admin`）保持一致，绝不凭空捏造多用户身份。
      agentClient: groupScopedClient({
        ...agentCanvasServiceToClient(services.agent, { principalId: devPrincipalIdFromEnv(env) }),
        // Codex 生图导入：目标只来自当前受信的 2D 组作用域，不接受工具参数自报。
        importGeneratedImage: async (input: { canvasId?: string; requestId: string; index?: number }) => {
          const scope = currentCanvasGroupScope();
          const media = ctx.get("media");
          if (!scope || !media) {
            return { ok: false as const, code: "group-scope-required", message: "生图导入需要当前 2D 组授权与媒体存储" };
          }
          if (!scope.valid()) {
            return { ok: false as const, code: "group-scope-revoked", message: "2D 组创作授权已失效" };
          }
          if (scope.authorize && !(await scope.authorize("write"))) {
            return { ok: false as const, code: "forbidden", message: "画布写入权限已撤销" };
          }
          if (input.canvasId !== undefined && input.canvasId !== scope.canvasId) {
            return { ok: false as const, code: "group-scope-forbidden", message: "目标画布不在当前 2D 组作用域" };
          }
          const room = await ctx.canvas.sync?.registry.resolve(scope.canvasId);
          const snapshot = room?.exportCanvas();
          if (!snapshot?.ok) {
            return { ok: false as const, code: "canvas-unavailable", message: "画布当前不可用" };
          }
          const groupNode = snapshot.canvas.document.nodes.find(node => node.id === scope.rootGroupId && node.type === "workflow-group-2d");
          const groupNodeData = snapshot.canvas.nodeData[scope.rootGroupId] as Record<string, unknown> | undefined;
          const workflowGroup = groupNodeData ? decodeWorkflowGroupData(groupNodeData.workflowGroup2d) : null;
          if (!groupNode || !groupNodeData || !workflowGroup?.ok) {
            return { ok: false as const, code: "group-target-missing", message: "2D 组已删除或成员表无效" };
          }
          let images: { codexHome: string; paths: string[] };
          try {
            images = await readRuntimeGeneratedImages({
              socketPath: env.WOOHAA3_AGENT_RUNTIME_SOCKET ?? "",
              token: env.WOOHAA3_AGENT_RUNTIME_TOKEN ?? "",
              workspaceKey: env.WOOHAA3_AGENT_WORKSPACE_KEY ?? ""
            }, scope.owner, input.requestId);
          } catch (error) {
            return { ok: false as const, code: "generated-image-unavailable", message: error instanceof Error ? error.message : String(error) };
          }
          const result = await importCodexGeneratedImage({
            canvasId: scope.canvasId,
            requestId: input.requestId,
            index: input.index ?? 0,
            group: { nodeId: scope.rootGroupId, nodeData: groupNodeData, workflowGroup: workflowGroup.value },
            codexHome: images.codexHome,
            paths: images.paths,
            importBytes: (bytes) => media.port().importBytes(bytes),
            apply: async (commands, commandId) => {
              const agent = ctx.canvas.mcpServices().agent;
              if (!agent) return { ok: false as const, code: "unavailable", message: "画布写入未就绪" };
              const latest = room?.exportCanvas();
              const outcome = await agent.apply({
                principalId: scope.owner,
                canvasId: scope.canvasId,
                requestId: input.requestId,
                commandId,
                payloadHash: commandId,
                baseRevision: latest?.ok ? latest.canvas.revision : 0,
                commands
              });
              return outcome.ok
                ? { ok: true as const, revision: outcome.revision }
                : { ok: false as const, code: outcome.code, message: outcome.message };
            }
          });
          return result.ok
            ? { ok: true as const, duplicate: result.duplicate, receipt: result.receipt }
            : result;
        }
      }, ctx.canvas),
      toolGrant: {
        allowedTools: token => catalogToolsForGrant(toolGrants.verify(token)),
        resolve: token => toolGrants.verify(token),
        authorize: (input) => toolGrants.authorize(input)
      },
      logger: ctx.log.scope("mcp")
    });
    ctx.effect(() => () => { toolGrants.close?.(); mcp.close(); });
    ctx.provide("toolGrants", toolGrants);
    ctx.provide("mcp", mcp);
    // 2D 组作用域：grant 命中组绑定时，把本轮 MCP 调用放进受信作用域；成员/写膜由
    // canvas-service 的 group-scope 与 command-execution 校验，模型参数无法伪造。
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.mcp, (req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const grant = toolGrants.verify(token);
      const scope = grant?.groupScope;
      // 已验证 grant 的主体是本轮 MCP 调用的可信 principal（模型不可自报）；组作用域另加范围膜。
      const owner = token ? toolGrants.subject(token) : undefined;
      const handle = () => mcp.handle(req, res);
      const scoped = scope && owner
        ? () => withCanvasGroupScope({
            ...scope,
            owner,
            valid: () => Boolean(toolGrants.verify(token)) && canvasGroupEpoch(scope.canvasId, scope.rootGroupId) === scope.scopeEpoch,
            authorize: async (permission) => (await services.agent?.authorizeCanvas({ principalId: owner, canvasId: scope.canvasId, permission }))?.ok === true
          }, handle)
        : handle;
      return owner ? withMcpPrincipal(owner, scoped) : scoped();
    }));
    ctx.effect(() => ctx.gateway.readiness(READINESS_ORDER.mcp, () => mcp.readiness()));
  }
};
