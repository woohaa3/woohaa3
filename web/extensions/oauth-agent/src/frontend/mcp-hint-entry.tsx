/**
 * ChatGPT 生成面板常驻 MCP 文字入口（React 视图）
 * （change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.6/5.3 / design D4）。
 *
 * 区分「在本面板使用」（内置真实发现：仅真实 initialize/tools/list 成功才显示已启用）与
 * 「外部 Agent 连接」（当前 origin 的 Streamable HTTP 地址）。复制仅表示地址已复制，
 * **不**表示外部客户端已连接；缺工具阻止动作时由宿主传入强化原因就近展示。
 *
 * 投影逻辑在纯模块 `agent-mcp.ts`；本组件只负责渲染与复制交互。
 */
import { useState } from "react";
import { Button } from "@woohaa3/ui/primitives";
import type { McpBuiltinDiscoveryView } from "@woohaa3/contracts";
import { resolveAgentMcpEntry } from "./agent-mcp.js";

export type AgentMcpHint = { label: string; text: string; serverUrl: string; blockedReason?: string | null };

export function AgentMcpHintEntry(props: {
  hint?: AgentMcpHint | undefined;
  discovery?: McpBuiltinDiscoveryView | null;
}) {
  const [copied, setCopied] = useState(false);
  const entry = resolveAgentMcpEntry({
    discovery: props.discovery ?? null,
    hint: props.hint
  });
  const { builtin, external } = entry;
  const copy = async () => {
    if (!external) return;
    try {
      await navigator.clipboard.writeText(external.serverUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="chatgpt-generate__mcp" data-blocked={entry.blockedReason ? "true" : undefined} data-builtin={builtin.status}>
      {entry.blockedReason ? (
        <p className="chatgpt-generate__mcp-blocked" role="status">
          {entry.blockedReason}
        </p>
      ) : null}
      <details className="chatgpt-generate__mcp-guide">
        <summary>{builtin.label}</summary>
        <p className="chatgpt-generate__mcp-text" role="status" aria-live="polite">
          {builtin.detail}
        </p>
        {external ? (
          <>
            <p className="chatgpt-generate__mcp-text">{external.text}</p>
            <Button size="sm" tone="neutral" onClick={() => void copy()}>
              {copied ? "已复制地址" : "复制 MCP 地址"}
            </Button>
            <p className="chatgpt-generate__mcp-note" role="note">
              {external.copyNote}
            </p>
          </>
        ) : null}
      </details>
    </div>
  );
}
