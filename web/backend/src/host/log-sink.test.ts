/**
 * 本机宿主日志 sink 的单元测试：出口形状、级别过滤、按天分段、按大小轮转、目录上限与降级。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostLogSink, DEFAULT_LOG_DIR, resolveHostLogDir, resolveHostLogLevel, resolveHostLogRunId } from "./log-sink.js";

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-log-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

function capture(): { lines: string[]; stderr: { write(chunk: string): boolean } } {
  const lines: string[] = [];
  return {
    lines,
    stderr: {
      write(chunk: string) {
        lines.push(chunk);
        return true;
      }
    }
  };
}

const moment = new Date(2026, 9, 16, 12, 0, 0);
const now = () => moment;
const TODAY = "backend-2026-10-16.log";

function payload(line: string): Record<string, unknown> {
  return JSON.parse(line.replace("[backend] ", "")) as Record<string, unknown>;
}

describe("宿主日志 sink", () => {
  it("把事件写成一行 JSON（补 time 与 level）并落到当天文件", () => {
    const dir = tempDir();
    const { lines, stderr } = capture();
    const sink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: dir }, stderr, now });

    sink.log({ module: "settings", event: "settings-reloaded", changed: ["a"] });

    expect(lines).toHaveLength(1);
    // 归一后：标识字段留在信封上，其余字段进 attrs（非标量序列化成文本）。
    expect(payload(lines[0]!)).toMatchObject({
      schema: 1,
      runtime: "host",
      module: "settings",
      event: "settings-reloaded",
      attrs: { changed: '["a"]' },
      level: "info"
    });
    expect(new Date(String(payload(lines[0]!).time)).getTime()).toBe(moment.getTime());
    const file = path.join(dir, TODAY);
    expect(sink.currentFile()).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe(lines[0]!.replace("[backend] ", ""));
  });

  it("按级别过滤：低于阈值的宿主事件与 Cordis 数字级别都不落", () => {
    const dir = tempDir();
    const { lines, stderr } = capture();
    const sink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: dir, WOOHAA3_LOG_LEVEL: "warn" }, stderr, now });

    sink.log({ event: "no-level" }); // 宿主事件缺 level → 按 info
    sink.log({ event: "string-debug", level: "debug" });
    sink.log({ event: "cordis-debug", level: 3 }); // Cordis LoggerLevel：3 = DEBUG
    sink.log({ event: "kept-warn", level: "warn" });
    sink.log({ event: "kept-error", level: "error" });

    expect(lines.map((line) => payload(line).event)).toEqual(["kept-warn", "kept-error"]);
    expect(fs.readFileSync(path.join(dir, TODAY), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("非法级别退回 info，不因配置写错而丢日志", () => {
    expect(resolveHostLogLevel({ WOOHAA3_LOG_LEVEL: "verbose" })).toBe("info");
    expect(resolveHostLogLevel({ WOOHAA3_LOG_LEVEL: "WARN" })).toBe("warn");
    expect(resolveHostLogLevel({})).toBe("info");
  });

  it("WOOHAA3_LOG_DIR 为空串时只写 stderr，不建目录", () => {
    const dir = tempDir();
    const { lines, stderr } = capture();
    const sink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: "" }, cwd: dir, stderr, now });

    sink.log({ event: "stderr-only" });

    expect(resolveHostLogDir({ WOOHAA3_LOG_DIR: "" }, dir)).toBeNull();
    expect(sink.dir).toBeNull();
    expect(sink.currentFile()).toBeNull();
    expect(lines).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("缺省目录是 cwd 下的 .woohaa3/logs", () => {
    expect(resolveHostLogDir({}, "/tmp/example")).toBe(path.resolve("/tmp/example", DEFAULT_LOG_DIR));
  });

  it("单文件超限滚段，且同一天不超过 segments 个文件", () => {
    const dir = tempDir();
    const { stderr } = capture();
    const sink = createHostLogSink({
      env: { WOOHAA3_LOG_DIR: dir },
      stderr,
      now,
      limits: { fileBytes: 80, segments: 2 }
    });

    for (let index = 0; index < 5; index += 1) sink.log({ event: "line", index });

    expect(fs.readdirSync(dir).sort()).toEqual([TODAY, `${TODAY}.1`].sort());
    expect(fs.readFileSync(path.join(dir, `${TODAY}.1`), "utf8").length).toBeGreaterThan(0);
  });

  it("单条记录本身就超过单文件上限时不截断", () => {
    const dir = tempDir();
    const { stderr } = capture();
    const sink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: dir }, stderr, now, limits: { fileBytes: 10 } });

    sink.log({ event: "oversized", message: "x".repeat(200) });

    expect(fs.readFileSync(path.join(dir, TODAY), "utf8")).toContain("x".repeat(200));
  });

  it("启动时清理超期文件与超量目录，且不动别人的文件", () => {
    const dir = tempDir();
    const { stderr } = capture();
    const stale = path.join(dir, "backend-2020-01-01.log");
    fs.writeFileSync(stale, "s".repeat(400));
    fs.utimesSync(stale, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const foreign = path.join(dir, "other-tool.log");
    fs.writeFileSync(foreign, "keep");

    const sink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: dir }, stderr, now });
    sink.log({ event: "boot" });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(foreign, "utf8")).toBe("keep");
    expect(fs.existsSync(path.join(dir, TODAY))).toBe(true);
  });

  it("目录总量超过上限时从最旧的删", () => {
    const dir = tempDir();
    const { stderr } = capture();
    const old = path.join(dir, "backend-2026-10-15.log");
    fs.writeFileSync(old, "o".repeat(300));
    fs.utimesSync(old, new Date(2026, 9, 15, 8, 0, 0), new Date(2026, 9, 15, 8, 0, 0));

    const sink = createHostLogSink({
      env: { WOOHAA3_LOG_DIR: dir },
      stderr,
      now,
      limits: { dirBytes: 120, retentionDays: 0 }
    });
    sink.log({ event: "boot" });

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(path.join(dir, TODAY))).toBe(true);
  });

  it("目录是符号链接或建不出来时降级为只写 stderr，不抛错", () => {
    const linked = tempDir();
    const target = tempDir();
    const link = path.join(linked, "logs");
    fs.symlinkSync(target, link);
    const { lines, stderr } = capture();
    const linkSink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: link }, stderr, now });

    expect(() => linkSink.log({ event: "boot" })).not.toThrow();
    expect(lines.some((line) => line.includes("host-log-file-unavailable"))).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);

    const blocked = path.join(tempDir(), "occupied");
    fs.writeFileSync(blocked, "not a directory");
    const brokenCapture = capture();
    const brokenSink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: blocked }, stderr: brokenCapture.stderr, now });

    expect(() => brokenSink.log({ event: "boot" })).not.toThrow();
    expect(brokenCapture.lines.some((line) => line.includes("host-log-file-unavailable"))).toBe(true);
  });
});

describe("日志信封", () => {
  it("每条记录带 schema 与 runtime，并补齐 pid", () => {
    const dir = tempDir();
    const { lines, stderr } = capture();
    const sink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: dir }, stderr, now, pid: 4242 });

    sink.log({ module: "task", event: "task-queued" });

    expect(payload(lines[0]!)).toMatchObject({ schema: 1, runtime: "host", pid: 4242 });
  });

  it("runId 从 WOOHAA_DESKTOP_RUN_DIR 末段取，并写进记录", () => {
    const dir = tempDir();
    const { lines, stderr } = capture();
    const sink = createHostLogSink({
      env: { WOOHAA3_LOG_DIR: dir, WOOHAA_DESKTOP_RUN_DIR: "/tmp/runs/1700000000-abc" },
      stderr,
      now
    });

    sink.log({ event: "boot" });

    expect(payload(lines[0]!).runId).toBe("1700000000-abc");
  });

  it("没有运行目录时不写 runId 字段", () => {
    const dir = tempDir();
    const { lines, stderr } = capture();
    const sink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: dir }, stderr, now });

    sink.log({ event: "boot" });

    expect(payload(lines[0]!)).not.toHaveProperty("runId");
  });

  it("message 与 attrs 分离，凭据被打码", () => {
    const dir = tempDir();
    const { lines, stderr } = capture();
    const sink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: dir }, stderr, now });

    sink.log({ module: "mcp", event: "connect", message: "token=abc123", access_token: "secret-value" });

    const record = payload(lines[0]!);
    expect(record.message).toBe("token=[redacted]");
    expect(record.attrs).toEqual({ access_token: "[redacted]" });
  });

  it("调用点传怪形状也不抛错，且仍写出可解析的一行", () => {
    const dir = tempDir();
    const { lines, stderr } = capture();
    const sink = createHostLogSink({ env: { WOOHAA3_LOG_DIR: dir }, stderr, now });
    const cyclic: Record<string, unknown> = { event: "x" };
    cyclic.self = cyclic;

    expect(() => sink.log(cyclic)).not.toThrow();
    expect(() => payload(lines[0]!)).not.toThrow();
  });
});

describe("resolveHostLogRunId", () => {
  it("取末段，兼容 Windows 分隔符", () => {
    expect(resolveHostLogRunId({ WOOHAA_DESKTOP_RUN_DIR: "C:\\runs\\run-1" })).toBe("run-1");
  });

  it("未配置时返回 undefined", () => {
    expect(resolveHostLogRunId({})).toBeUndefined();
  });

  it("空串与只有分隔符时返回 undefined", () => {
    expect(resolveHostLogRunId({ WOOHAA_DESKTOP_RUN_DIR: "  " })).toBeUndefined();
    expect(resolveHostLogRunId({ WOOHAA_DESKTOP_RUN_DIR: "/" })).toBeUndefined();
  });
});
