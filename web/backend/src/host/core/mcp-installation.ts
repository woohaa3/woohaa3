import type { HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";
import { createMcpInstaller } from "../../mcp-installation/service.js";
import { createMcpInstallationApi } from "../../api/mcp-installation-api.js";

export const mcpInstallationPlugin: HostPlugin<{ env: NodeJS.ProcessEnv; basePath: string }> = {
  name: "mcpInstallation",
  inject: ["gateway", "access"],
  apply(ctx, { env, basePath }) {
    const handler = createMcpInstallationApi({ installer: createMcpInstaller({ env }), basePath, authenticator: ctx.access.authenticator, accessEnforcer: ctx.access.accessEnforcer });
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.mcpInstallation, handler));
  }
};
