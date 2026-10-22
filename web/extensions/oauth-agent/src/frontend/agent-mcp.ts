/**
 * ChatGPT 生成面板常驻 MCP 入口的纯派生
 * （change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.6/5.3 / design D4）。
 *
 * 面板把「内置 MCP 使用」与「外部 Agent 连接」分开投影（design D4）：
 * - 内置：只使用宿主 `mcpStatus()` 返回的**真实** `initialize`/`tools/list` 发现；`ready` 仅表示
 *   服务可达且注册了工具，**不**表示当前 owner 已获写授权；
 * - 外部：只是当前 origin 的 Streamable HTTP 地址；复制仅反馈「已复制」，无外部心跳时显示
 *   「等待外部客户端验证」，MUST NOT 由内置发现推断外部已连接。
 *
 * 纯函数、无副作用：不发起请求、不复制地址、不写画布，便于在不挂载渲染环境的情况下覆盖
 * 各发现状态与「复制 ≠ 已连接」的语义（任务 6.1）。
 */
import type { McpBuiltinDiscoveryView, McpDiscoveryStatus } from "@woohaa3/contracts";

/** 内置 MCP 使用的展示状态（真实信号投影；unknown 表示尚未查询）。 */
export type AgentMcpBuiltinView = {
  ready: boolean;
  status: McpDiscoveryStatus | "unknown";
  label: string;
  detail: string;
  /** 只读工具数量（真实清单派生）。 */
  readTools: number;
  /** 可写工具数量（真实清单派生；仍需逐回合 grant 才可执行）。 */
  writeTools: number;
};

export type AgentMcpExternalView = {
  label: string;
  text: string;
  serverUrl: string;
  /** 复制仅表示地址已复制，不表示外部客户端已连接（固定文案）。 */
  copyNote: string;
};

export type AgentMcpEntryView = {
  builtin: AgentMcpBuiltinView;
  external: AgentMcpExternalView | null;
  /** 缺工具阻止生成时的就近强化原因（宿主传入）。 */
  blockedReason: string | null;
};

const UNKNOWN_BUILTIN: AgentMcpBuiltinView = {
  ready: false,
  status: "unknown",
  label: "MCP 工具状态未知",
  detail: "尚未完成真实连接探测；复制地址不表示已连接。",
  readTools: 0,
  writeTools: 0
};

const EXTERNAL_COPY_NOTE = "复制地址仅表示已复制；未收到外部客户端心跳前显示「等待外部客户端验证」。";

/** 内置发现的只读/可写工具计数（真实清单派生）。 */
export function countMcpTools(tools: ReadonlyArray<{ access: "read" | "write" }>): { read: number; write: number } {
  let read = 0;
  let write = 0;
  for (const tool of tools) {
    if (tool.access === "write") write += 1;
    else read += 1;
  }
  return { read, write };
}

/**
 * 由真实发现派生内置 MCP 展示状态。
 *
 * `ready` 只来自后端 executed initialize/tools/list 且注册了工具；其余状态原样透出可读原因，
 * 不伪造就绪。`null`（未查询）返回 unknown，不显示「已启用」。
 */
export function describeBuiltinDiscovery(view: McpBuiltinDiscoveryView | null): AgentMcpBuiltinView {
  if (!view) return UNKNOWN_BUILTIN;
  const counts = countMcpTools(view.tools);
  const scopeText = counts.read + counts.write > 0 ? `（只读 ${counts.read} / 可写 ${counts.write}）` : "";
  if (view.ready) {
    return {
      ready: true,
      status: "ready",
      label: "MCP 工具已启用",
      detail: `内置 MCP 服务可达并列出注册工具${scopeText}；是否可写仍按每次执行的范围授权判定。`,
      readTools: counts.read,
      writeTools: counts.write
    };
  }
  const reason = view.reason ?? BUILTIN_REASON[view.status] ?? "内置 MCP 服务当前不可用。";
  return {
    ready: false,
    status: view.status,
    label: view.status === "not-configured" ? "MCP 工具未配置" : "MCP 工具不可用",
    detail: reason,
    readTools: counts.read,
    writeTools: counts.write
  };
}

const BUILTIN_REASON: Record<McpDiscoveryStatus, string> = {
  ready: "",
  unreachable: "内置 MCP 服务不可达，请确认服务已启动。",
  "no-tools": "内置 MCP 服务未注册任何工具。",
  "protocol-error": "内置 MCP 服务协议错误，无法完成 initialize/tools/list。",
  "not-configured": "内置 MCP 发现未配置。"
};

/**
 * 组合常驻入口视图：内置真实状态 + 外部连接指引 + 缺工具就近强化原因。
 *
 * 外部指引缺省由宿主 `mcpHint` 提供；未提供时不从内置发现推断出外部地址（两者方向不同）。
 */
export function resolveAgentMcpEntry(input: {
  discovery: McpBuiltinDiscoveryView | null;
  hint?: { label: string; text: string; serverUrl: string; blockedReason?: string | null } | undefined;
}): AgentMcpEntryView {
  return {
    builtin: describeBuiltinDiscovery(input.discovery),
    external: input.hint
      ? {
          label: input.hint.label,
          text: input.hint.text,
          serverUrl: input.hint.serverUrl,
          copyNote: EXTERNAL_COPY_NOTE
        }
      : null,
    blockedReason: input.hint?.blockedReason ?? null
  };
}
