/**
 * 核心层 · mcp：内置 MCP 服务与共享工具授权表。
 *
 * 工具授权表（`toolGrants`）由 ChatGPT 生成层签发、MCP 工具入口校验，所以同一实例要同时给
 * mcp 与 application；插件扩展的 MCP 工具清单在调用时从 application 懒取。
 */
import { createMcpService } from "@woohaa3/mcp-service";
import type { SkillStepClient } from "@woohaa3/mcp-service";
import type { HostPlugin } from "../context.js";
import { READINESS_ORDER, ROUTE_ORDER } from "../order.js";
import { catalogToolsForGrant, createToolGrantRegistry } from "../../ports/authoring-adapters.js";
import { createExtensionMcpBridge } from "../../ports/extension-mcp.js";
import { agentCanvasServiceToClient, modelMcpServiceToClient } from "../../ports/mcp-adapters.js";
import { groupScopedClient } from "../../ports/group-scoped-client.js";
import { withMcpPrincipal } from "../../ports/mcp-principal.js";
import { devPrincipalIdFromEnv } from "../base/access.js";
import { canvasGroupEpoch, withCanvasGroupScope } from "@woohaa3/canvas-service";

export const mcpPlugin: HostPlugin<{ env: Record<string, string | undefined> }> = {
  name: "mcp",
  inject: ["log", "gateway", "canvas"],
  apply(ctx, { env }) {
    const toolGrants = createToolGrantRegistry();
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
      agentClient: groupScopedClient(agentCanvasServiceToClient(services.agent, { principalId: devPrincipalIdFromEnv(env) }), ctx.canvas),
      toolGrant: {
        allowedTools: token => catalogToolsForGrant(toolGrants.verify(token)),
        resolve: token => toolGrants.verify(token),
        authorize: (input) => toolGrants.authorize(input)
      },
      logger: ctx.log.scope("mcp")
    });
    ctx.effect(() => () => mcp.close());
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
