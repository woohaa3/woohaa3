import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ModelMcpHttpOptions } from "./http-types.js";
import { jsonResult, toolError } from "./tool-results.js";

/** 可信扩展声明自己的工具；MCP 层不认识任何具体扩展的业务。 */
export function registerExtensionTools(server: McpServer, options: ModelMcpHttpOptions, context: { bearerToken: string | null; loopback: boolean }): void {
  for (const tool of options.extensionTools?.list() ?? []) {
    const shape: Record<string, z.ZodTypeAny> = {
      canvasId: z.string().min(1).max(200),
      ...(tool.permission === "write" ? { requestId: z.string().min(1).max(200) } : {})
    };
    for (const [name, field] of Object.entries(tool.parameters ?? {})) {
      let schema: z.ZodTypeAny = field.type === "string" ? z.string().min(1).max(field.maxLength ?? 2000)
        : field.type === "strings" ? z.array(z.string().min(1).max(200)).max(256) : z.record(z.string(), z.unknown());
      if (field.description) schema = schema.describe(field.description);
      shape[name] = field.optional ? schema.optional() : schema;
    }
    server.registerTool(tool.name, { description: tool.description, inputSchema: z.object(shape).strict() }, async args => {
      try {
        const result = await options.extensionTools!.call({ name: tool.name, args, ...context });
        return result.ok === false ? toolError(String(result.message ?? "扩展操作失败"), String(result.code ?? "extension-failed")) : jsonResult(result);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "扩展操作失败", "extension-failed");
      }
    });
  }
}
