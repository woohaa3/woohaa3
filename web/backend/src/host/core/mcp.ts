import { groupScopedClient } from "../../ports/group-scoped-client.js";
/**
 * 核心层 · mcp：内置 MCP 服务与共享工具授权表。
 *
 * 工具授权表（`toolGrants`）由 ChatGPT 生成层签发、MCP 工具入口校验，所以同一实例要同时给
 * mcp 与 application；插件扩展的 MCP 工具清单在调用时从 application 懒取。
 */
import { createMcpService } from "@woohaa3/mcp-service";
import { canvasGroupEpoch, withCanvasGroupScope } from "@woohaa3/canvas-service";
import type { HostPlugin } from "../context.js";
import { READINESS_ORDER, ROUTE_ORDER } from "../order.js";
import { createToolGrantRegistry } from "../../ports/authoring-adapters.js";
import { createExtensionMcpBridge } from "../../ports/extension-mcp.js";
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
    const mcp = createMcpService({
      env,
      extensionTools: createExtensionMcpBridge({
        definitions: () => ctx.get("application")?.definitions ?? [],
        application,
        grants: toolGrants,
        developmentPrincipal: env.WOOHAA3_MCP_DEVELOPMENT_PRINCIPAL,
        loopbackDevelopment: ["1", "true"].includes(env.WOOHAA3_AGENT_LOOPBACK_MODE ?? "")
      }),
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
      toolGrant: { allowedTools: token => toolGrants.verify(token)?.groupScope ? toolGrants.verify(token)!.tools : undefined, authorize: (input) => toolGrants.authorize(input) },
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
          const record = ctx.get("application")?.service.agentConversations().queryTurn({ owner, requestId: (grant as typeof grant & { workId?: string }).workId ?? "" });
          const receipt = record?.ok ? record.turn.receipt as { kind?: string; actions?: { nodeId?: string; runId?: string }[] } | undefined : undefined;
          return receipt?.kind === "canvas-group" && receipt.actions?.some(action => action.nodeId === nodeId && action.runId === runId) === true;
        },
        authorize: async permission => (await services.agent?.authorizeCanvas({ principalId: owner, canvasId: scope.canvasId, permission }))?.ok === true,
        onAction: action => ctx.get("application")?.service.agentConversations().recordGroupAction({ owner, requestId: (grant as typeof grant & { workId?: string }).workId ?? "", action }),
        valid: () => Boolean(toolGrants.verify(token)) && canvasGroupEpoch(scope.canvasId, scope.rootGroupId) === scope.scopeEpoch
      }, () => mcp.handle(req, res));
    }));
    ctx.effect(() => ctx.gateway.readiness(READINESS_ORDER.mcp, () => mcp.readiness()));
  }
};
