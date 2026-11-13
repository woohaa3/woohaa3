import { AsyncLocalStorage } from "node:async_hooks";
import { registerModelBatchTools } from "./batch-tools.js";
import { registerExtensionTools } from "./extension-tools.js";
/**
 * Model Canvas MCP 的 Streamable HTTP 入口公共入口
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R11 —— 拆分为
 *  类型、结果渲染、指南/注册器与各工具族子模块，本文件保留 handler 与 server facade）。
 *
 * MCP 与权威 `modelScript` 写入同属 Canvas Service：工具直接调用 ModelMcpService，
 * 不再经 stdio 子进程转发到另一层 HTTP API。端点保持无会话，便于反向代理与多客户端接入。
 */
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { registerAgentAuthoringTools } from "../agent-authoring/tools.js";
import { registerModelTools } from "./model-tools.js";
import { normalizePath, toolError } from "./tool-results.js";
import {
  MODEL_MCP_HTTP_PATH,
  type ModelMcpHttpHandler,
  type ModelMcpHttpOptions,
  type ModelMcpDiscoveryResult,
  type McpToolDescriptor,
  type ToolRegistration
} from "./http-types.js";

export {
  MODEL_MCP_HTTP_PATH,
  type ModelMcpHttpHandler,
  type ModelMcpHttpOptions,
  type ModelMcpToolService,
  type ModelMcpDiscoveryResult,
  type McpToolDescriptor,
  type McpToolAccess
} from "./http-types.js";
export { buildModelApiGuideText } from "./guide.js";

export function createModelMcpHttpHandler(options: ModelMcpHttpOptions): ModelMcpHttpHandler {
  const path = normalizePath(options.path ?? MODEL_MCP_HTTP_PATH);
  const log = options.logger ?? (() => undefined);
  const requestLoopback = new AsyncLocalStorage<boolean>();
  const mcp = createMcpHandler(
    (ctx) => createModelMcpServer(options, extractBearer(ctx.requestInfo), requestLoopback.getStore() === true),
    {
      legacy: "stateless",
      onerror: (error) => log({ event: "model-mcp-protocol-error", status: 400, code: error.name })
    }
  );
  const nodeHandler = toNodeHandler(mcp, {
    onerror: (error) => log({ event: "model-mcp-http-error", status: 500, code: error.name })
  });

  /**
   * 真实 discovery（任务 3.1）：经同一 MCP handler 的原生 `fetch` 执行 `initialize` + `tools/list`。
   *
   * 不另建 MCP client、不复制工具清单、不缓存就绪：请求走与外部客户端同一协议路径；只读/可写
   * 分类与 grant 门禁集合（`GRANTED_TOOLS`）一致。
   */
  const discover = async (): Promise<ModelMcpDiscoveryResult> => {
    const checkedAt = new Date().toISOString();
    const post = async (payload: unknown): Promise<{ body: Record<string, unknown>; status: number }> => {
      const response = await mcp.fetch(new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26"
        },
        body: JSON.stringify(payload)
      }));
      const text = await response.text();
      const json = response.headers.get("content-type")?.includes("text/event-stream")
        ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1) ?? "{}"
        : text;
      return { body: JSON.parse(json) as Record<string, unknown>, status: response.status };
    };
    try {
      const initialized = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "woohaa3-host-discovery", version: "1.0.0" } } });
      if (initialized.status >= 400) {
        return { ready: false, code: "protocol-error", reason: `MCP initialize 失败（HTTP ${initialized.status}）`, tools: [], checkedAt };
      }
      const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const result = listed.body.result as { tools?: Array<{ name: string; title?: string; description?: string }> } | undefined;
      const tools = (result?.tools ?? [])
        .map((tool): McpToolDescriptor => ({
          name: tool.name,
          access: GRANTED_TOOLS.has(tool.name) ? "write" : "read",
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {})
        }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      if (tools.length === 0) {
        return { ready: false, code: "no-tools", reason: "MCP 服务可达但未注册任何工具", tools: [], checkedAt };
      }
      return { ready: true, serverName: "woohaa3-model-canvas", tools, checkedAt };
    } catch (error) {
      return {
        ready: false,
        code: "unreachable",
        reason: error instanceof Error ? error.message : "MCP 工具发现失败",
        tools: [],
        checkedAt
      };
    }
  };

  return {
    async handle(req, res) {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        return false;
      }
      if (normalizePath(pathname) !== path) return false;
      const remote = req.socket.remoteAddress;
      const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "") && !req.headers["x-forwarded-for"];
      await requestLoopback.run(loopback, () => nodeHandler(req, res));
      return true;
    },
    discover,
    close: () => mcp.close()
  };
}

/** 从原始 HTTP 请求提取 bearer 令牌（无则 null）。 */
function extractBearer(request: Request | undefined): string | null {
  const header = request?.headers.get("authorization") ?? null;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

function createModelMcpServer(options: ModelMcpHttpOptions, bearerToken: string | null, loopback: boolean): McpServer {
  const server = new McpServer({ name: "woohaa3-model-canvas", version: "1.0.0" });
  const grantDenied = (tool: string, args: { canvasId?: unknown; nodeId?: unknown; nodeIds?: unknown; items?: unknown; cameraId?: unknown }): string | null => {
    if (!bearerToken) return null;
    if (!options.toolGrant) return "工具授权校验未装配";
    const result = options.toolGrant.authorize({
      token: bearerToken,
      tool,
      ...(typeof args.canvasId === "string" ? { canvasId: args.canvasId } : {}),
      ...(typeof args.nodeId === "string" ? { nodeId: args.nodeId } : {}),
      ...(Array.isArray(args.nodeIds) ? { nodeIds: args.nodeIds.filter((id): id is string => typeof id === "string") } : {}),
      ...(Array.isArray(args.items) ? { nodeIds: args.items.flatMap(item => item && typeof item.nodeId === "string" ? [item.nodeId] : []) } : {}),
      ...(typeof args.cameraId === "string" ? { cameraId: args.cameraId } : {})
    });
    return result.ok ? null : `工具授权校验失败：${result.reason}`;
  };

  // Every bearer call passes one budget/scope gate, including reads and script/run
  // tools. Individual model registrars must not consume that budget a second time.
  const register = server.registerTool.bind(server);
  const allowed = bearerToken ? options.toolGrant?.allowedTools?.(bearerToken) : undefined;
  server.registerTool = ((name: string, config: unknown, callback: (...args: unknown[]) => unknown) => {
    if (allowed && !allowed.includes(name)) return undefined;
    return register(name, config as never, (async (...args: unknown[]) => {
      const denied = grantDenied(name, (args[0] ?? {}) as Parameters<typeof grantDenied>[1]);
      if (denied) return toolError(denied, "unauthorized");
      return callback(...args);
    }) as never);
  }) as typeof server.registerTool;

  const reg: ToolRegistration = {
    server,
    grantedTools: GRANTED_TOOLS,
    grantDenied: () => null
  };

  registerModelTools(reg, options);
  registerModelBatchTools(reg, options);

  const grant = bearerToken && options.toolGrant?.resolve ? options.toolGrant.resolve(bearerToken) : null;
  if (options.agentAuthoring) {
    const subject = grant?.subject?.trim();
    registerAgentAuthoringTools(server, {
      ...options.agentAuthoring,
      grant,
      // 每请求可信主体（已验证 grant 的主体）；缺省保留部署配置的静态 principalId，绝不来自模型参数。
      ...(subject ? { principalId: subject } : {})
    });
  }
  registerExtensionTools(server, options, { bearerToken, loopback });
  options.registerTools?.(server, { bearerToken, grant });
  return server;
}

/** 需经 grant 校验的写工具集合（读工具不需要预算）。 */
const GRANTED_TOOLS = new Set([
  "submit_model_script",
  "submit_model_scripts",
  "validate_model_scripts",
  "set_node_prompt",
  "create_world_model",
  "replace_world_model_content",
  "append_world_model_script",
  "patch_world_model_script",
  "move_world_model",
  "create_world_camera",
  "set_world_camera",
  "complete_world_camera",
  "resize_scene_area",
  "import_generated_image"
]);

/**
 * 真实注册目录：按当前装配把全部工具注册到一个只记录名字的 server 上
 * （change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 角色工具声明必须与实际注册面求交；这里复用与请求同一条注册路径（含条件式 world/skill 工具），
 * 不维护第二份手写清单。注册本身不产生 I/O，结果可由宿主缓存。
 */
export function listModelMcpToolNames(options: ModelMcpHttpOptions = {}): readonly string[] {
  const names = new Set<string>();
  const server = new McpServer({ name: "woohaa3-model-canvas", version: "1.0.0" });
  server.registerTool = ((name: string) => {
    names.add(name);
    return undefined;
  }) as unknown as typeof server.registerTool;
  const reg: ToolRegistration = { server, grantedTools: GRANTED_TOOLS, grantDenied: () => null };
  registerModelTools(reg, options);
  registerModelBatchTools(reg, options);
  if (options.agentAuthoring) registerAgentAuthoringTools(server, options.agentAuthoring);
  registerExtensionTools(server, options, { bearerToken: null, loopback: false });
  options.registerTools?.(server, { bearerToken: null, grant: null });
  return [...names].sort();
}
