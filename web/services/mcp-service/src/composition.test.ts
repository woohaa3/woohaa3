/**
 * 生产启动配置校验测试
 * （change: add-agent-canvas-authoring-mcp，任务 2.4）。
 */
import { describe, expect, it } from "vitest";
import { MCP_AGENT_LOOPBACK_MODE_ENV, MCP_DEVELOPMENT_PRINCIPAL_ENV, resolveMcpAgentProfile } from "./composition.js";

describe("MCP 生产配置校验（任务 2.4）", () => {
  it("显式 loopback 模式允许开发 principal 兜底", () => {
    expect(resolveMcpAgentProfile({ [MCP_AGENT_LOOPBACK_MODE_ENV]: "1" }, "dev-user")).toEqual({ ok: true, loopbackDevelopment: true });
  });

  it("生产模式（未声明 loopback）配置 development principal 必须拒绝", () => {
    const profile = resolveMcpAgentProfile({}, "dev-user");
    expect(profile.ok).toBe(false);
    if (!profile.ok) expect(profile.reason).toContain(MCP_DEVELOPMENT_PRINCIPAL_ENV);
  });

  it("生产模式且无 development principal 合法（无兜底）", () => {
    expect(resolveMcpAgentProfile({}, undefined)).toEqual({ ok: true, loopbackDevelopment: false });
  });

  it("显式 loopback 但未配置 principal 也不报错（无兜底可启用）", () => {
    expect(resolveMcpAgentProfile({ [MCP_AGENT_LOOPBACK_MODE_ENV]: "true" }, undefined)).toEqual({ ok: true, loopbackDevelopment: true });
  });
});
