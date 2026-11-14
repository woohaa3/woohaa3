import type { McpServer } from "@modelcontextprotocol/server";
import type {
  AgentAuthoringToolContribution,
  AgentAuthoringToolRegistrar,
  HostAgentAuthoringToolService,
  McpToolRegistrationContext
} from "@woohaa3/contracts";

export type AgentAuthoringToolRegistry = HostAgentAuthoringToolService & {
  registerForRequest(server: McpServer, context: McpToolRegistrationContext): void;
};

export function createAgentAuthoringToolRegistry(): AgentAuthoringToolRegistry {
  const contributions = new Map<string, AgentAuthoringToolContribution>();
  return {
    register(contribution) {
      if (!contribution || typeof contribution.id !== "string" || contribution.id.trim() === "") {
        throw new Error("authoring-tool-contribution-invalid");
      }
      if (contributions.has(contribution.id)) throw new Error(`authoring-tool-contribution-duplicate:${contribution.id}`);
      contributions.set(contribution.id, contribution);
      return () => {
        if (contributions.get(contribution.id) === contribution) contributions.delete(contribution.id);
      };
    },
    list: () => [...contributions.values()],
    registerForRequest(server, context) {
      const registrar: AgentAuthoringToolRegistrar = {
        register(name, config, handler) {
          server.registerTool(name, config as never, async args => handler(args as Record<string, unknown>) as never);
        }
      };
      for (const contribution of contributions.values()) {
        if (contribution.available && !contribution.available()) continue;
        contribution.register(registrar, context);
      }
    }
  };
}
