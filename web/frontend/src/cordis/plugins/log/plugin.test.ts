/**
 * 前端日志插件测试（change: unify-host-client-logging，任务 3.2）。
 *
 * 锁定三件事：只写 console（不落盘/不缓冲）、按级别过滤、凭据被打码。
 */
import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { createFrontendLogPlugin, formatLogRecord, FRONTEND_LOG_DEFAULT_LEVEL } from "./plugin.js";
import { normalizeLogRecord } from "@woohaa3/contracts";

const NOW = Date.UTC(2026, 10, 4, 3, 0, 0);

function capture() {
  const lines: string[] = [];
  const record = (level: string) => (...args: unknown[]) => {
    lines.push(`${level}: ${args.map(String).join(" ")}`);
  };
  return {
    lines,
    output: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error")
    }
  };
}

async function mount(options: Parameters<typeof createFrontendLogPlugin>[0] = {}) {
  const { lines, output } = capture();
  const ctx = new Context();
  await ctx.plugin(createFrontendLogPlugin({ output, now: () => NOW, ...options }));
  return { ctx, lines };
}

describe("前端日志出口", () => {
  it("默认级别是 warn", () => {
    expect(FRONTEND_LOG_DEFAULT_LEVEL).toBe("warn");
  });

  it("提供 ctx.log.scope", async () => {
    const { ctx } = await mount();
    expect(typeof ctx.log.scope("canvas")).toBe("function");
  });

  it("按级别过滤：默认 warn 丢弃 info", async () => {
    const { ctx, lines } = await mount();
    ctx.log.scope("canvas")({ level: "info", event: "canvas-opened" });
    expect(lines).toHaveLength(0);
  });

  it("warn 与 error 会落到 console", async () => {
    const { ctx, lines } = await mount();
    ctx.log.scope("canvas")({ level: "warn", event: "save-failed" });
    ctx.log.scope("canvas")({ level: "error", event: "sync-lost", message: "boom" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("warn:");
    expect(lines[1]).toContain("error:");
  });

  it("级别可覆盖到 debug", async () => {
    const { ctx, lines } = await mount({ level: "debug" });
    ctx.log.scope("canvas")({ level: "debug", event: "tick" });
    expect(lines).toHaveLength(1);
  });

  it("输出带 module 与 event 前缀", async () => {
    const { ctx, lines } = await mount();
    ctx.log.scope("mcp")({ level: "error", event: "connect-failed" });
    expect(lines[0]).toContain("[mcp]");
    expect(lines[0]).toContain("connect-failed");
  });

  it("凭据被打码后才进 console", async () => {
    const { ctx, lines } = await mount();
    ctx.log.scope("mcp")({ level: "error", event: "connect", message: "token=abc123" });
    expect(lines[0]).toContain("[redacted]");
    expect(lines[0]).not.toContain("abc123");
  });

  it("console 抛错不影响调用方", async () => {
    const ctx = new Context();
    const exploding = () => { throw new Error("console closed"); };
    await ctx.plugin(createFrontendLogPlugin({
      output: { debug: exploding, info: exploding, warn: exploding, error: exploding },
      now: () => NOW
    }));
    expect(() => ctx.log.scope("x")({ level: "error", event: "boom" })).not.toThrow();
  });
});

describe("formatLogRecord", () => {
  it("拼出 module/event/attrs/message", () => {
    const record = normalizeLogRecord({
      module: "task",
      runtime: "web",
      raw: { event: "queued", count: 3, message: "ready" },
      now: NOW
    });
    expect(formatLogRecord(record)).toBe("[task] queued count=3 ready");
  });

  it("没有 attrs 与 message 时只有前缀", () => {
    const record = normalizeLogRecord({ module: "task", runtime: "web", raw: { event: "idle" }, now: NOW });
    expect(formatLogRecord(record)).toBe("[task] idle");
  });
});
