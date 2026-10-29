import { groupScopedClient } from "../../ports/group-scoped-client.js";
/**
 * 核心层 · mcp：内置 MCP 服务与共享工具授权表。
 *
 * 工具授权表（`toolGrants`）由 ChatGPT 生成层签发、MCP 工具入口校验，所以同一实例要同时给
 * mcp 与 application；插件扩展的 MCP 工具清单在调用时从 application 懒取。
 */
import { createMcpService } from "@woohaa3/mcp-service";
import type { SkillStepClient } from "@woohaa3/mcp-service";
import { canvasGroupEpoch, currentCanvasGroupScope, withCanvasGroupScope } from "@woohaa3/canvas-service";
import type { HostPlugin } from "../context.js";
import { READINESS_ORDER, ROUTE_ORDER } from "../order.js";
import { catalogToolsForGrant, createToolGrantRegistry } from "../../ports/authoring-adapters.js";
import { createExtensionMcpBridge } from "../../ports/extension-mcp.js";
import { createContentMcpBridge } from "../../ports/content-mcp.js";
import { agentCanvasServiceToClient, modelMcpServiceToClient } from "../../ports/mcp-adapters.js";

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
     * owner 与组作用域只来自受信任的请求上下文（`withCanvasGroupScope` / 已认证 principal），
     * 不接受工具参数自报；等待与查询不提交生成。
     */
    const skillClient: SkillStepClient = {
      async wait(input) {
        const media = application().skillMedia();
        if (!media) return { ok: false, code: "unavailable", message: "Skill 续接未启用" };
        const scope = currentCanvasGroupScope();
        const owner = scope?.owner ?? env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "";
        if (!owner) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
        const result = await media.wait({
          owner,
          canvasId: scope?.canvasId ?? input.canvasId,
          ...(scope ? { rootGroupId: scope.rootGroupId, scopeEpoch: canvasGroupEpoch(scope.canvasId, scope.rootGroupId) } : {}),
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
        const scope = currentCanvasGroupScope();
        const owner = scope?.owner ?? env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "";
        if (!owner) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
        const result = await media.latestOutput({
          owner,
          canvasId: scope?.canvasId ?? input.canvasId,
          ...(scope ? { rootGroupId: scope.rootGroupId, scopeEpoch: canvasGroupEpoch(scope.canvasId, scope.rootGroupId) } : {}),
          skillRunId: input.skillRunId,
          stepId: input.stepId,
          ...(input.allowFallback !== undefined ? { allowFallback: input.allowFallback } : {})
        });
        return result.ok ? { ok: true, value: result.view } : { ok: false, code: result.code, message: result.message };
      },
      async snapshot(input) {
        const media = application().skillMedia();
        if (!media) return { ok: false, code: "unavailable", message: "Skill 续接未启用" };
        const scope = currentCanvasGroupScope();
        const owner = scope?.owner ?? env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "";
        if (!owner) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
        const result = await media.snapshot({
          owner,
          canvasId: scope?.canvasId ?? input.canvasId,
          ...(scope ? { rootGroupId: scope.rootGroupId, scopeEpoch: canvasGroupEpoch(scope.canvasId, scope.rootGroupId) } : {}),
          skillRunId: input.skillRunId,
          stepId: input.stepId
        });
        return result.ok ? { ok: true, value: result.step } : { ok: false, code: result.code, message: result.message };
      },
      async events(input) {
        const media = application().skillMedia();
        if (!media) return { ok: false, code: "unavailable", message: "Skill 续接未启用" };
        const scope = currentCanvasGroupScope();
        const owner = scope?.owner ?? env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "";
        if (!owner) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
        const result = await media.events({
          owner,
          canvasId: scope?.canvasId ?? input.canvasId,
          ...(scope ? { rootGroupId: scope.rootGroupId, scopeEpoch: canvasGroupEpoch(scope.canvasId, scope.rootGroupId) } : {}),
          skillRunId: input.skillRunId,
          stepId: input.stepId,
          ...(input.after !== undefined ? { after: input.after } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {})
        });
        return result.ok ? { ok: true, value: result.page } : { ok: false, code: result.code, message: result.message };
      }
    };
    const extensionBridge = createExtensionMcpBridge({
      definitions: () => ctx.get("application")?.definitions ?? [],
      application,
      grants: toolGrants,
      developmentPrincipal: env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL,
      loopbackDevelopment: ["1", "true"].includes(env.WOOHAA3_AGENT_LOOPBACK_MODE ?? "")
    });
    const contentBridge = createContentMcpBridge({
      content: () => ctx.canvas.content,
      grants: toolGrants,
      developmentPrincipal: env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL,
      loopbackDevelopment: ["1", "true"].includes(env.WOOHAA3_AGENT_LOOPBACK_MODE ?? ""),
      authorizeCanvas: async ({ subject, canvasId, permission }) => {
        const agent = ctx.canvas.mcpServices().agent;
        if (!agent) return false;
        return (await agent.authorizeCanvas({ principalId: subject, canvasId, permission }))?.ok === true;
      }
    });
    const mcp = createMcpService({
      env,
      skillClient,
      skillAvailability: { available: true },
      extensionTools: {
        list: () => {
          const seen = new Set<string>();
          const merged: import("@woohaa3/contracts").ApplicationExtensionMcpTool[] = [];
          for (const tool of [...extensionBridge.list(), ...contentBridge.list()]) {
            if (seen.has(tool.name)) {
              ctx.log.scope("mcp")({ event: "mcp-tool-name-conflict", level: "warn", tool: tool.name });
              continue;
            }
            seen.add(tool.name);
            merged.push(tool);
          }
          return merged;
        },
        async call(input) {
          const names = new Set(extensionBridge.list().map((tool) => tool.name));
          return names.has(input.name)
            ? extensionBridge.call(input)
            : contentBridge.call(input);
        }
      },
      canvasClient: groupScopedClient(modelMcpServiceToClient(services.modelMcp, {
        ...(services.createFilmSetNode ? { createFilmSetNode: services.createFilmSetNode } : {}),
        ...(services.importModelSnapshot ? { importModelSnapshot: services.importModelSnapshot } : {}),
        ...(services.commitAnimation ? { commitAnimation: services.commitAnimation } : {}),
        ...(services.addFilmSetMedia ? { addFilmSetMedia: services.addFilmSetMedia } : {}),
        ...(services.exportFilmSetClip ? { exportFilmSetClip: services.exportFilmSetClip } : {}),
        ...(services.getFilmSetExport ? { getFilmSetExport: services.getFilmSetExport } : {}),
        ...(services.mutateFilmSetItem ? { mutateFilmSetItem: services.mutateFilmSetItem } : {})
      }), ctx.canvas),
      // 只共享显式配置的 Canvas 身份；缺省/空值不得凭空造身份。
      agentClient: groupScopedClient(agentCanvasServiceToClient(services.agent, { principalId: env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL ?? "" }), ctx.canvas),
      toolGrant: { allowedTools: token => catalogToolsForGrant(toolGrants.verify(token)), authorize: (input) => toolGrants.authorize(input) },
      logger: ctx.log.scope("mcp")
    });
    ctx.effect(() => () => mcp.close());
    ctx.provide("toolGrants", toolGrants);
    ctx.provide("mcp", mcp);
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.mcp, (req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
      const grant = toolGrants.verify(token);
      if (!grant?.groupScope) return mcp.handle(req, res);
      const scope = grant.groupScope;
      const owner = toolGrants.subject(token);
      if (!owner) return mcp.handle(req, res);
      return withCanvasGroupScope({ ...scope, owner,
        ownsRun: (nodeId, runId) => {
          const record = ctx.get("application")?.service.agentConversations().queryTurn({ owner, requestId: grant.workId ?? "" });
          const receipt = record?.ok ? record.turn.receipt as { kind?: string; actions?: { nodeId?: string; runId?: string }[] } | undefined : undefined;
          return receipt?.kind === "canvas-group" && receipt.actions?.some(action => action.nodeId === nodeId && action.runId === runId) === true;
        },
        authorize: async permission => (await services.agent?.authorizeCanvas({ principalId: owner, canvasId: scope.canvasId, permission }))?.ok === true,
        onAction: action => ctx.get("application")?.service.agentConversations().recordGroupAction({ owner, requestId: grant.workId ?? "", action }),
        valid: () => Boolean(toolGrants.verify(token)) && canvasGroupEpoch(scope.canvasId, scope.rootGroupId) === scope.scopeEpoch
      }, () => mcp.handle(req, res));
    }));
    ctx.effect(() => ctx.gateway.readiness(READINESS_ORDER.mcp, () => mcp.readiness()));
  }
};
