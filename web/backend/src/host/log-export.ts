/**
 * 宿主日志导出（对应 change: unify-host-client-logging 的 design D6）。
 *
 * `GET /api/logs/export?since=24h` 返回**重新归一 + 重新脱敏**后的 NDJSON。
 *
 * 为什么重新序列化而不是打包原文件：
 * - 磁盘上的历史行可能是旧格式（本 change 之前没有信封），原样导出会让分析侧看到两种形状；
 * - 旧行也可能是在脱敏表收敛之前写的，导出时再跑一遍是唯一能覆盖已落盘数据的时机；
 * - 首行写 manifest，导出物因此自解释，不需要附带侧车说明。
 *
 * 有界：默认最近 24 小时，硬上限 `MAX_EXPORT_BYTES`。日志目录可能到 200MB，不能一次读进内存。
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeLogRecord, type LogRecord } from "@woohaa3/contracts";

/** 单次导出的字节上限：够覆盖一次排障，又不会把响应撑爆。 */
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
/** 默认时间窗。 */
export const DEFAULT_EXPORT_SINCE_MS = 24 * 60 * 60 * 1000;
/** 文件名模式：只认本 sink 自己的分段文件。 */
const FILE_PATTERN = /^backend-(\d{4})-(\d{2})-(\d{2})\.log(?:\.(\d+))?$/;

export type LogExportManifest = {
  schema: 1;
  kind: "manifest";
  exportedAt: string;
  runtime: "host";
  records: number;
  bytes: number;
  /** 实际覆盖的最早/最晚记录时间；没有记录时为 null。 */
  from: string | null;
  to: string | null;
  truncated: boolean;
  files: string[];
};

export type LogExportOptions = {
  dir: string;
  /** 时间窗下界（毫秒时间戳）。 */
  since: number;
  /** 当前时间，用于 manifest 与时间窗判断。 */
  now: number;
  maxBytes?: number;
};

/** 从 `since` 解析：支持 `24h` / `7d` / `30m`；非法或缺省时用默认 24h。 */
export function parseExportSince(raw: string | null, now: number): number {
  if (raw === null || raw === "") return now - DEFAULT_EXPORT_SINCE_MS;
  const match = /^(\d{1,4})([mhd])$/.exec(raw.trim());
  if (match === null) return now - DEFAULT_EXPORT_SINCE_MS;
  const amount = Number(match[1]);
  const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  return now - amount * unitMs;
}

/** 按文件名里的日期筛出可能落在时间窗内的文件；滚动段 (`.1`) 一并带上。 */
function candidateFiles(dir: string, since: number): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sinceDate = new Date(since);
  const sinceDay = Date.UTC(sinceDate.getFullYear(), sinceDate.getMonth(), sinceDate.getDate());
  return names
    .filter((name) => FILE_PATTERN.test(name))
    .filter((name) => {
      const match = FILE_PATTERN.exec(name)!;
      const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      // 滚动段属于某一天，日期判断按文件名那一天算即可。
      return day >= sinceDay;
    })
    .sort();
}

/**
 * 把一行已落盘文本还原成 `LogRecord`。
 *
 * 旧格式行（没有 `schema`）没有 `module` 之外的标识字段，归一后仍然可读；解析失败的行
 * **不丢弃**，而是包成一条 `unparsable-log-line`，避免导出物与磁盘内容对不上。
 */
function reviveLine(line: string, now: number): LogRecord | null {
  const text = line.replace(/^\[backend\]\s*/, "").trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return normalizeLogRecord({ module: "host", runtime: "host", raw: { level: "warn", event: "unparsable-log-line", message: text }, now });
  }
  if (parsed === null || typeof parsed !== "object") {
    return normalizeLogRecord({ module: "host", runtime: "host", raw: { level: "warn", event: "unparsable-log-line", message: text }, now });
  }
  const raw = parsed as Record<string, unknown>;
  // 已经归一过的行仍然重新走一遍：脱敏表可能比写盘时更全。
  return normalizeLogRecord({
    module: typeof raw.module === "string" ? raw.module : "host",
    runtime: "host",
    raw,
    now,
    ...(typeof raw.pid === "number" ? { pid: raw.pid } : {}),
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {})
  });
}

/**
 * 生成导出正文。返回 NDJSON 字符串与 manifest。
 *
 * 逐文件、逐行读取，累计到上限即停并标记 `truncated`——不把整个目录读进内存。
 */
export function collectLogExport(options: LogExportOptions): { body: string; manifest: LogExportManifest } {
  const maxBytes = options.maxBytes ?? MAX_EXPORT_BYTES;
  const files = candidateFiles(options.dir, options.since);
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  let from: number | null = null;
  let to: number | null = null;
  const usedFiles: string[] = [];

  for (const name of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(options.dir, name), "utf8");
    } catch {
      continue;
    }
    let used = false;
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      const at = Date.parse(String(JSON.parse(safeJson(line)).time ?? ""));
      const record = reviveLine(line, Number.isNaN(at) ? options.now : at);
      if (record === null) continue;
      const atMs = Date.parse(record.time);
      // 时间窗过滤用记录自身时间：跨天分段文件里可能有窗外记录。
      if (!Number.isNaN(atMs) && atMs < options.since) continue;
      const serialized = JSON.stringify(record);
      if (bytes + serialized.length > maxBytes) {
        truncated = true;
        break;
      }
      lines.push(serialized);
      bytes += serialized.length + 1;
      used = true;
      if (!Number.isNaN(atMs)) {
        from = from === null ? atMs : Math.min(from, atMs);
        to = to === null ? atMs : Math.max(to, atMs);
      }
    }
    if (used) usedFiles.push(name);
    if (truncated) break;
  }

  const manifest: LogExportManifest = {
    schema: 1,
    kind: "manifest",
    exportedAt: new Date(options.now).toISOString(),
    runtime: "host",
    records: lines.length,
    bytes,
    from: from === null ? null : new Date(from).toISOString(),
    to: to === null ? null : new Date(to).toISOString(),
    truncated,
    files: usedFiles
  };
  return { body: [JSON.stringify(manifest), ...lines].join("\n") + "\n", manifest };
}

/** 只用来读 `time` 做时间窗判断；解析失败时返回空对象。 */
function safeJson(line: string): string {
  try {
    JSON.parse(line);
    return line;
  } catch {
    return "{}";
  }
}
