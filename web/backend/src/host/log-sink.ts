/**
 * 本机宿主日志落点：一行 JSON 写 stderr，再落一份按天分段、按大小轮转的本地文件。
 *
 * 组合根在调用方没有注入 `logger` 时用它做默认 sink；三个进程入口也用同一个 sink，避免各自
 * 手写一段 `[backend] ${JSON.stringify(event)}`。事件形状由调用方决定，出口只补 `time` 与
 * `level`。写盘失败退回只写 stderr，不抛错、不阻断宿主启动与请求。
 *
 * 轮转规则（参考同生态桌面壳的文件日志实现）：
 * - 文件名按**本地日期**分段：`backend-YYYY-MM-DD.log`；
 * - 单文件超过 `limits.fileBytes`（缺省 10MB）滚到 `.1`、`.2` …；
 * - 同一天最多 `limits.segments` 个文件（缺省 10，含当前段）；
 * - 目录里本 sink 自己的文件总量超过 `limits.dirBytes`（缺省 200MB）时从最旧的删；
 * - 启动与换日时清理超过 `limits.retentionDays`（缺省 7 天）的文件。
 *
 * 只管理 `backend-*.log*` 命名，日志目录是符号链接、目录建不出来或文件写不动时降级为 stderr。
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeLogRecord, type HostLog, type LogRecord } from "@woohaa3/contracts";

/** 日志目录；空串表示显式关闭文件落盘，只写 stderr。 */
export const LOG_DIR_ENV = "WOOHAA3_LOG_DIR";
/** `debug` / `info` / `warn` / `error`，缺省 `info`。 */
export const LOG_LEVEL_ENV = "WOOHAA3_LOG_LEVEL";
/** 相对进程 cwd 的缺省日志目录，与 storage.local 的 `.woohaa3/` 数据目录同区。 */
export const DEFAULT_LOG_DIR = ".woohaa3/logs";
export const DEFAULT_LOG_LEVEL: HostLogLevel = "info";

export type HostLogLevel = "debug" | "info" | "warn" | "error";

/** 文件容量上限；测试可收紧，环境变量不暴露这些参数。 */
export type HostLogLimits = {
  fileBytes: number;
  dirBytes: number;
  /** 同一天最多保留的文件数（含当前段）。 */
  segments: number;
  retentionDays: number;
};

export const DEFAULT_LOG_LIMITS: HostLogLimits = {
  fileBytes: 10 * 1024 * 1024,
  dirBytes: 200 * 1024 * 1024,
  segments: 10,
  retentionDays: 7
};

export type HostLogWriter = { write(chunk: string): unknown };

export type HostLogSinkOptions = {
  env?: Record<string, string | undefined>;
  /** 相对路径的解析基准；缺省进程 cwd。 */
  cwd?: string;
  /** 缺省 `process.stderr`。 */
  stderr?: HostLogWriter;
  now?: () => Date;
  limits?: Partial<HostLogLimits>;
  /** 记录里的 `pid`；缺省 `process.pid`。多个宿主进程写同一目录时用来区分来源。 */
  pid?: number;
  /** 记录里的 `runId`；缺省从 `WOOHAA_DESKTOP_RUN_DIR` 末段取。 */
  runId?: string;
  /** 记录里的 `runtime`；缺省 `host`。 */
  runtime?: "host" | "web";
};

export type HostLogSink = {
  /** 交给 `createBackendService({ logger })` 或基础层 `log` 插件的出口。 */
  log: HostLog;
  /** 落盘目录；`WOOHAA3_LOG_DIR` 为空串（显式关闭）时为 null。 */
  dir: string | null;
  /** 当前分段文件；还没建立目录（尚未写过一条）时为 null。 */
  currentFile(): string | null;
};

/**
 * 桌面壳注入的本次运行目录；末段就是这次运行的 `runId`。
 *
 * 只用来给记录补一个关联字段，**不改变落盘位置**（宿主日志仍按 `WOOHAA3_LOG_DIR` 走）。
 */
const RUN_DIR_ENV = "WOOHAA_DESKTOP_RUN_DIR";

/** 取运行标识：兼容 Windows 分隔符，末段为空时返回 undefined。 */
export function resolveHostLogRunId(env: Record<string, string | undefined>): string | undefined {
  const raw = env[RUN_DIR_ENV]?.trim();
  if (!raw) return undefined;
  const tail = raw.split(/[\\/]+/).filter((part) => part !== "").pop();
  return tail === undefined || tail === "" ? undefined : tail;
}

const LEVEL_RANK: Record<HostLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
/** Cordis `LoggerLevel`：ERROR=0、INFO=1、WARN=2、DEBUG=3。 */
const NUMERIC_LEVEL: Record<number, HostLogLevel> = { 0: "error", 1: "info", 2: "warn", 3: "debug" };

const FILE_PATTERN = /^backend-\d{4}-\d{2}-\d{2}\.log(?:\.\d+)?$/;
/** 两次目录核算之间允许写入的字节数，避免每条日志都扫目录。 */
const RESCAN_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 非法或缺失的级别退回 `info`，不让写日志本身成为启动失败点。 */
export function resolveHostLogLevel(env: Record<string, string | undefined>): HostLogLevel {
  const raw = env[LOG_LEVEL_ENV]?.trim().toLowerCase();
  return raw !== undefined && Object.hasOwn(LEVEL_RANK, raw) ? (raw as HostLogLevel) : DEFAULT_LOG_LEVEL;
}

/** `undefined` 取缺省目录；空串表示显式关闭文件落盘。 */
export function resolveHostLogDir(env: Record<string, string | undefined>, cwd: string): string | null {
  const raw = env[LOG_DIR_ENV];
  if (raw !== undefined && raw.trim() === "") return null;
  return path.resolve(cwd, raw ?? DEFAULT_LOG_DIR);
}

/** 宿主事件通常不带 `level`，按 `info` 处理；Cordis 出口给的是字符串或数字级别。 */
function eventLevel(event: Record<string, unknown>): HostLogLevel {
  const raw = event.level;
  if (typeof raw === "string") {
    const lowered = raw.toLowerCase();
    return Object.hasOwn(LEVEL_RANK, lowered) ? (lowered as HostLogLevel) : "info";
  }
  if (typeof raw === "number" && Object.hasOwn(NUMERIC_LEVEL, raw)) return NUMERIC_LEVEL[raw]!;
  return "info";
}

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

type OwnFile = { path: string; size: number; mtimeMs: number };
type FileWriter = { dir: string; write(line: string): void; current(): string | null };

function createFileWriter(dir: string, limits: HostLogLimits, stderr: HostLogWriter, now: () => Date): FileWriter {
  // 至少保留当前段与一个滚动段：`segments` 表示同一天的文件总数（含当前段）。
  const segmentCount = Math.max(2, Math.trunc(limits.segments));
  let prepared = false;
  let failed = false;
  let current: string | null = null;
  let sinceScan = 0;

  const warn = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    const line = `${JSON.stringify({ time: now().toISOString(), level: "warn", event: "host-log-file-unavailable", dir, message })}\n`;
    try {
      stderr.write(`[backend] ${line}`);
    } catch {
      // stderr 也写不动时保持沉默：日志失败不升级成宿主故障。
    }
  };
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    warn(error);
  };

  /** 只认自己的命名，别的工具写在同目录的文件不动。 */
  const ownFiles = (): OwnFile[] => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const files: OwnFile[] = [];
    for (const name of names) {
      if (!FILE_PATTERN.test(name)) continue;
      try {
        const stat = fs.statSync(path.join(dir, name));
        if (stat.isFile()) files.push({ path: path.join(dir, name), size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 文件可能刚被清理或在 Windows 上被临时锁住：跳过，不影响本次写入。
      }
    }
    return files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  };

  const prune = (at: number): void => {
    const cutoff = limits.retentionDays > 0 ? at - limits.retentionDays * DAY_MS : undefined;
    let files = ownFiles();
    if (cutoff !== undefined) {
      for (const file of files) {
        if (file.mtimeMs >= cutoff) continue;
        try {
          fs.unlinkSync(file.path);
        } catch {
          // 清理失败只影响空间回收，不影响写入。
        }
      }
      files = ownFiles();
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (total <= limits.dirBytes) break;
      try {
        fs.unlinkSync(file.path);
        total -= file.size;
      } catch {
        // 同上：文件消失或被锁时跳过。
      }
    }
  };

  const prepare = (): boolean => {
    if (failed) return false;
    if (prepared) return true;
    try {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error("日志目录是符号链接");
      fs.mkdirSync(dir, { recursive: true });
      prepared = true;
      prune(now().getTime());
    } catch (error) {
      fail(error);
    }
    return prepared;
  };

  const roll = (file: string): void => {
    const oldest = segmentCount - 1;
    for (let index = oldest; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      if (!fs.existsSync(from)) continue;
      try {
        if (index === oldest) fs.unlinkSync(from);
        else fs.renameSync(from, `${file}.${index + 1}`);
      } catch {
        // 单段滚动失败不阻断写入；目录总量上限仍会兜住增长。
      }
    }
    try {
      fs.renameSync(file, `${file}.1`);
    } catch {
      // 目标被占用时继续写原文件。
    }
  };

  const sizeOf = (file: string): number => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };

  return {
    dir,
    current: () => current,
    write(line) {
      if (!prepare()) return;
      try {
        const file = path.join(dir, `backend-${localDate(now())}.log`);
        if (file !== current) {
          current = file;
          sinceScan = 0;
          prune(now().getTime());
        }
        const bytes = Buffer.byteLength(line, "utf8");
        const size = sizeOf(file);
        // 单条记录本身就超过上限时不截断：宁可留一个大文件，也不丢一整条事件。
        if (size > 0 && size + bytes > limits.fileBytes) roll(file);
        fs.appendFileSync(file, line);
        sinceScan += bytes;
        if (sinceScan >= RESCAN_BYTES) {
          sinceScan = 0;
          prune(now().getTime());
        }
      } catch (error) {
        fail(error);
      }
    }
  };
}

export function createHostLogSink(options: HostLogSinkOptions = {}): HostLogSink {
  const env = options.env ?? {};
  const cwd = options.cwd ?? process.cwd();
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date());
  const nowEnv = options.env ?? process.env;
  const threshold = LEVEL_RANK[resolveHostLogLevel(env)];
  const dir = resolveHostLogDir(env, cwd);
  // A desktop run shares its budget with native/WebView logs and incident samples.
  const defaults = (options.env ?? process.env).WOOHAA_DESKTOP_RUN_DIR
    ? { ...DEFAULT_LOG_LIMITS, segments: 2, dirBytes: 40 * 1024 * 1024 }
    : DEFAULT_LOG_LIMITS;
  const writer = dir === null ? null : createFileWriter(dir, { ...defaults, ...options.limits }, stderr, now);

  const pid = options.pid ?? process.pid;
  const runId = options.runId ?? resolveHostLogRunId(nowEnv);
  const runtime = options.runtime ?? "host";

  /**
   * 出口做两件事：**归一成信封**，再写两个落点。
   *
   * 归一放在这里而不是 `log` 插件里，是因为只有 sink 拿到 pid / runId / 落盘位置；
   * 插件只负责补 `module`。调用点（扩展、各 service）仍然传普通对象，签名不变。
   */
  const log: HostLog = (event) => {
    const level = eventLevel(event);
    if (LEVEL_RANK[level] < threshold) return;
    let line: string;
    try {
      const record: LogRecord = normalizeLogRecord({
        module: typeof event.module === "string" ? event.module : "unknown",
        runtime,
        raw: event,
        now: now().getTime(),
        pid,
        ...(runId === undefined ? {} : { runId })
      });
      line = `${JSON.stringify(record)}\n`;
    } catch {
      // 归一自身失败（理论上不该发生）时退回最小记录，绝不把异常抛回业务。
      line = `${JSON.stringify({ schema: 1, time: now().toISOString(), level, runtime, module: "unknown", event: "log" })}\n`;
    }
    try {
      stderr.write(`[backend] ${line}`);
    } catch {
      // stderr 关闭（如管道断开）时不把失败抛回调用方。
    }
    writer?.write(line);
  };

  return { log, dir, currentFile: () => writer?.current() ?? null };
}
