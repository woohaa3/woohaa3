/**
 * 内置 MCP 发现与外部连接指引的公开契约
 * （change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.2/3.6 / design D4）。
 *
 * 从 `conversation.ts` 拆出（业务源码规模门禁）：本模块只含 MCP 方向的可共享纯类型——
 * 内置真实发现视图（只读/可写分类）与 `GET /mcp` 的宿主投影。浏览器安全的纯类型：
 * 不含 SQLite、SDK、HTTP handler 或秘密。
 *
 * 关键约束（design D4）：
 * - `ready` 只来自后端 executed initialize/tools/list 且注册了工具，不表示任何 owner 已获写授权；
 * - 外部连接指引只是当前 origin 的 Streamable HTTP 地址；复制地址不等于外部客户端已连接。
 */

/**
 * 内置 MCP 工具视图（只读/可写分类来自真实 grant 门禁集合）
 * （change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.2 / design D4）。
 *
 * `ready` 只表示服务可达且注册了工具；不表示任何 owner 已获写授权。外部客户端是否连接由外部
 * 自身心跳决定，MUST NOT 由内置发现推断。
 */
export const MCP_TOOL_ACCESS = ["read", "write"] as const;
export type McpToolAccess = (typeof MCP_TOOL_ACCESS)[number];

export type McpToolView = {
  name: string;
  access: McpToolAccess;
  title?: string;
  description?: string;
};

export const MCP_DISCOVERY_STATUSES = ["ready", "unreachable", "no-tools", "protocol-error", "not-configured"] as const;
export type McpDiscoveryStatus = (typeof MCP_DISCOVERY_STATUSES)[number];

export type McpBuiltinDiscoveryView = {
  ready: boolean;
  status: McpDiscoveryStatus;
  /** 服务可达且注册了工具时才给出真实服务名。 */
  serverName?: string;
  /** 真实工具清单（缺失/不可用时为空）。 */
  tools: McpToolView[];
  /** 不可用原因（ready=true 时缺省）。 */
  reason?: string;
  checkedAt: string;
};

/** `GET /mcp` 的宿主投影：内置真实发现 + 外部连接指引（复制不等于外部已连接）。 */
export type AgentMcpStatusResponse = {
  builtin: McpBuiltinDiscoveryView;
  external: {
    /** 当前 origin 的 Streamable HTTP endpoint（绝对 URL）。 */
    serverUrl: string;
    transport: "streamable-http";
  };
};
