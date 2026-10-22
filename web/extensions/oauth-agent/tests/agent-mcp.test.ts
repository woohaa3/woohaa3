/**
 * 生成面板常驻 MCP 入口投影测试
 * （change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.6/5.3/6.1）。
 *
 * 覆盖：内置 ready 只来自真实发现；不可达/未配置/协议错误原样透出原因，不伪造就绪；
 * 只读/可写计数来自真实清单；复制地址不表示外部客户端已连接。
 */
import { describe, expect, it } from "vitest";
import type { McpBuiltinDiscoveryView } from "@woohaa3/contracts";
import { countMcpTools, describeBuiltinDiscovery, resolveAgentMcpEntry } from "../src/frontend/agent-mcp.js";

const READY: McpBuiltinDiscoveryView = {
  ready: true,
  status: "ready",
  serverName: "woohaa3-model-canvas",
  tools: [
    { name: "get_model_node", access: "read" },
    { name: "list_model_requests", access: "read" },
    { name: "submit_model_script", access: "write" }
  ],
  checkedAt: "2026-10-13T00:00:00.000Z"
};

describe("countMcpTools", () => {
  it("按真实清单统计只读/可写", () => {
    expect(countMcpTools(READY.tools)).toEqual({ read: 2, write: 1 });
    expect(countMcpTools([])).toEqual({ read: 0, write: 0 });
  });
});

describe("describeBuiltinDiscovery", () => {
  it("未查询时为 unknown，不显示已启用", () => {
    const view = describeBuiltinDiscovery(null);
    expect(view.ready).toBe(false);
    expect(view.status).toBe("unknown");
    expect(view.label).not.toContain("已启用");
  });

  it("真实发现成功才显示已启用并给出真实计数", () => {
    const view = describeBuiltinDiscovery(READY);
    expect(view.ready).toBe(true);
    expect(view.label).toBe("MCP 工具已启用");
    expect(view.readTools).toBe(2);
    expect(view.writeTools).toBe(1);
    // 可写仍需逐回合 grant，不能表述为「当前用户已可写」。
    expect(view.detail).toContain("范围授权");
  });

  it("不可达原样透出原因，不伪造就绪", () => {
    const view = describeBuiltinDiscovery({ ready: false, status: "unreachable", tools: [], reason: "连接被拒绝", checkedAt: "t" });
    expect(view.ready).toBe(false);
    expect(view.label).toBe("MCP 工具不可用");
    expect(view.detail).toBe("连接被拒绝");
  });

  it("未配置与协议错误各有明确文案", () => {
    expect(describeBuiltinDiscovery({ ready: false, status: "not-configured", tools: [], checkedAt: "t" }).label).toBe("MCP 工具未配置");
    expect(describeBuiltinDiscovery({ ready: false, status: "protocol-error", tools: [], checkedAt: "t" }).detail).toContain("initialize");
  });
});

describe("resolveAgentMcpEntry", () => {
  it("内置状态来自发现；外部指引来自宿主 hint，复制不等于已连接", () => {
    const entry = resolveAgentMcpEntry({
      discovery: READY,
      hint: { label: "MCP 连接指引", text: "安装这个 MCP 服务：http://x/mcp/model-canvas", serverUrl: "http://x/mcp/model-canvas", blockedReason: null }
    });
    expect(entry.builtin.ready).toBe(true);
    expect(entry.external?.serverUrl).toBe("http://x/mcp/model-canvas");
    expect(entry.external?.copyNote).toContain("等待外部客户端验证");
    expect(entry.blockedReason).toBeNull();
  });

  it("无 hint 时不从内置发现推断外部地址", () => {
    const entry = resolveAgentMcpEntry({ discovery: READY });
    expect(entry.external).toBeNull();
  });

  it("缺工具阻止生成时透出就近强化原因", () => {
    const entry = resolveAgentMcpEntry({
      discovery: { ready: false, status: "no-tools", tools: [], checkedAt: "t" },
      hint: { label: "MCP 连接指引", text: "t", serverUrl: "u", blockedReason: "缺少 submit_model_script 工具，无法执行该动作。" }
    });
    expect(entry.blockedReason).toContain("submit_model_script");
    expect(entry.builtin.ready).toBe(false);
  });
});
