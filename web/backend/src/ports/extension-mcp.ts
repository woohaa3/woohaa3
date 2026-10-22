import type { ApplicationBackendExtensionDefinition } from "@woohaa3/contracts";
import type { ApplicationService } from "@woohaa3/application-service";
import type { ModelMcpHttpOptions } from "@woohaa3/mcp-service";
import type { ToolGrantRegistry } from "./authoring-adapters.js";

/** 将扩展声明映射到当前公共实例；恢复命名空间不进入外部工具目录。 */
export function createExtensionMcpBridge(options: {
  definitions: () => readonly ApplicationBackendExtensionDefinition[];
  application: () => ApplicationService;
  grants: ToolGrantRegistry;
  developmentPrincipal?: string;
  loopbackDevelopment: boolean;
}): NonNullable<ModelMcpHttpOptions["extensionTools"]> {
  const entries = () => options.definitions().flatMap(definition => (definition.mcpTools ?? []).map(tool => ({ extensionId: definition.extensionId, tool })));
  return {
    list: () => entries().filter(({ extensionId, tool }) => {
      const state = options.application().plugins().status(extensionId)?.actualState;
      return state === "active" || (state === "draining" && !tool.newWork);
    }).map(({ tool }) => tool),
    async call(input) {
      const entry = entries().find(({ tool }) => tool.name === input.name);
      if (!entry) return { ok: false, code: "not-found", message: "工具未注册" };
      let subject: string | undefined;
      // 主体来源同时决定 identityProvider（冻结 principal 的身份权威）；两者都可信但不混同。
      let identityProvider: string | undefined;
      if (input.bearerToken) {
        const grant = options.grants.verify(input.bearerToken);
        if (grant?.nodeIds.length && typeof input.args.nodeId !== "string") {
          return { ok: false, code: "unauthorized", message: "节点范围委托不能创建范围外的新节点" };
        }
        const decision = options.grants.authorize({ token: input.bearerToken, tool: input.name,
          canvasId: String(input.args.canvasId ?? ""), ...(typeof input.args.nodeId === "string" ? { nodeId: input.args.nodeId } : {}) });
        if (!decision.ok) return { ok: false, code: "unauthorized", message: decision.reason };
        subject = options.grants.subject(input.bearerToken);
        identityProvider = "extension-tool-grant";
      } else if (input.loopback && options.loopbackDevelopment) {
        subject = options.developmentPrincipal;
        identityProvider = "mcp-loopback-development";
      }
      if (!subject?.trim() || identityProvider === undefined) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
      const app = options.application();
      const state = app.plugins().status(entry.extensionId)?.actualState;
      if (state !== "active" && !(state === "draining" && !entry.tool.newWork)) {
        return { ok: false, code: "plugin-disabled", message: "扩展尚未启用或正在停止新工作" };
      }
      try {
        const result = await app.host().dispatch(entry.tool.route, { extensionId: entry.extensionId, body: input.args,
          context: { authLevel: "authenticated", principal: { subject, identityProvider }, actor: subject, correlationId: String(input.args.requestId ?? "") } });
        return result.body as Record<string, unknown>;
      } catch (error) {
        return { ok: false, code: (error as { code?: string }).code ?? "extension-failed", message: error instanceof Error ? error.message : "扩展操作失败" };
      }
    }
  };
}
