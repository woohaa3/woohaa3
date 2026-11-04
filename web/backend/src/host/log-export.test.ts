/**
 * 宿主日志导出测试（change: unify-host-client-logging，任务 4.2）。
 *
 * 锁定：时间窗解析、重新归一（含旧格式行）、重新脱敏、字节上限截断、manifest 形状。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectLogExport, DEFAULT_EXPORT_SINCE_MS, parseExportSince } from "./log-export.js";

const created: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-export-"));
  created.push(dir);
  return dir;
}
afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
function lines(body: string): Record<string, unknown>[] {
  return body.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("parseExportSince", () => {
  it("支持小时", () => expect(parseExportSince("6h", NOW)).toBe(NOW - 6 * 3_600_000));
  it("支持天", () => expect(parseExportSince("2d", NOW)).toBe(NOW - 2 * 86_400_000));
  it("支持分钟", () => expect(parseExportSince("30m", NOW)).toBe(NOW - 30 * 60_000));

  it("缺省用 24 小时", () => {
    expect(parseExportSince(null, NOW)).toBe(NOW - DEFAULT_EXPORT_SINCE_MS);
  });

  it("非法值退回缺省", () => {
    expect(parseExportSince("yesterday", NOW)).toBe(NOW - DEFAULT_EXPORT_SINCE_MS);
    expect(parseExportSince("5y", NOW)).toBe(NOW - DEFAULT_EXPORT_SINCE_MS);
  });
});

describe("collectLogExport", () => {
  it("首行是 manifest，其余是记录", () => {
    const dir = tempDir();
    const at = new Date(NOW - 1000).toISOString();
    fs.writeFileSync(path.join(dir, "backend-2026-11-04.log"), JSON.stringify({ schema: 1, time: at, level: "info", runtime: "host", module: "task", event: "queued" }) + "\n");

    const { body, manifest } = collectLogExport({ dir, since: NOW - 3_600_000, now: NOW });

    expect(manifest.kind).toBe("manifest");
    expect(manifest.records).toBe(1);
    const parsed = lines(body);
    expect(parsed[0]).toMatchObject({ kind: "manifest", schema: 1, runtime: "host", records: 1 });
    expect(parsed[1]).toMatchObject({ module: "task", event: "queued" });
  });

  it("导出时重新脱敏（覆盖写盘时未脱敏的旧行）", () => {
    const dir = tempDir();
    const at = new Date(NOW - 1000).toISOString();
    fs.writeFileSync(path.join(dir, "backend-2026-11-04.log"), JSON.stringify({ time: at, level: "warn", module: "mcp", event: "connect", message: "token=abc123" }) + "\n");

    const { body } = collectLogExport({ dir, since: NOW - 3_600_000, now: NOW });

    expect(body).toContain("[redacted]");
    expect(body).not.toContain("abc123");
  });

  it("旧格式行（无 schema）也能归一", () => {
    const dir = tempDir();
    const at = new Date(NOW - 1000).toISOString();
    fs.writeFileSync(path.join(dir, "backend-2026-11-04.log"), JSON.stringify({ time: at, level: "info", module: "canvas", event: "legacy", custom: 1 }) + "\n");

    const { body } = collectLogExport({ dir, since: NOW - 3_600_000, now: NOW });

    expect(lines(body)[1]).toMatchObject({ schema: 1, module: "canvas", event: "legacy", attrs: { custom: 1 } });
  });

  it("无法解析的行不丢弃，包成 unparsable-log-line", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "backend-2026-11-04.log"), "not json at all\n");

    const { body } = collectLogExport({ dir, since: NOW - 3_600_000, now: NOW });

    expect(lines(body)[1]).toMatchObject({ event: "unparsable-log-line" });
  });

  it("时间窗外的记录被过滤", () => {
    const dir = tempDir();
    const old = new Date(NOW - 48 * 3_600_000).toISOString();
    fs.writeFileSync(path.join(dir, "backend-2026-11-02.log"), JSON.stringify({ time: old, level: "info", module: "x", event: "old" }) + "\n");

    const { manifest } = collectLogExport({ dir, since: NOW - 3_600_000, now: NOW });

    expect(manifest.records).toBe(0);
  });

  it("超过字节上限时截断并标记", () => {
    const dir = tempDir();
    const at = new Date(NOW - 1000).toISOString();
    const row = JSON.stringify({ time: at, level: "info", module: "x", event: "noisy", message: "y".repeat(200) });
    fs.writeFileSync(path.join(dir, "backend-2026-11-04.log"), Array.from({ length: 50 }, () => row).join("\n") + "\n");

    const { manifest } = collectLogExport({ dir, since: NOW - 3_600_000, now: NOW, maxBytes: 1000 });

    expect(manifest.truncated).toBe(true);
    expect(manifest.bytes).toBeLessThanOrEqual(1000);
  });

  it("目录不存在时返回空 manifest 而不抛错", () => {
    const { manifest } = collectLogExport({ dir: path.join(tempDir(), "missing"), since: NOW - 3_600_000, now: NOW });
    expect(manifest.records).toBe(0);
    expect(manifest.files).toEqual([]);
  });

  it("忽略非本 sink 命名的文件", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "other.log"), "noise\n");
    const { manifest } = collectLogExport({ dir, since: NOW - 3_600_000, now: NOW });
    expect(manifest.records).toBe(0);
  });
});
