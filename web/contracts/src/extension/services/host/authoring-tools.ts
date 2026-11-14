import type { McpToolRegistrationContext } from "../../../mcp/authoring-tools.js";

/**
 * Director-area MCP tools contributed by a trusted backend extension.
 *
 * The registrar is deliberately transport-neutral: the MCP service supplies the
 * real server and its grant wrapper, while extensions only provide schemas and
 * callbacks.  A contribution never receives an owner/canvas from tool args.
 */
export type AgentAuthoringToolRegistrar = {
  register(
    name: string,
    config: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>
  ): void;
};

export type AgentAuthoringToolContribution = {
  id: string;
  available?: () => boolean;
  register(registrar: AgentAuthoringToolRegistrar, context: McpToolRegistrationContext): void;
};

export type HostAgentAuthoringToolService = {
  register(contribution: AgentAuthoringToolContribution): () => void;
  list(): readonly AgentAuthoringToolContribution[];
};
