/**
 * 启动守卫（change: 2026-10-21-harden-extension-fault-isolation，design D7）。
 *
 * 宿主在加载扩展**之前**把启动尝试计数加一，发出 `host/ready` **之后**清零；连续多次没能就绪，
 * 下一次就以安全模式启动（只装配宿主核心、bootstrap 槽位实现与 required 扩展）。
 *
 * 状态文件只在这两个时刻（以及受控重启请求时）写入，写法是 tmp + rename 原子替换：在两次写入
 * 之间崩溃，计数仍然正确。文件损坏或读取失败按零次处理并告警——这是安全方向，不会因为坏文件
 * 误入安全模式，代价是可能多崩溃几次才进入。
 *
 * 受控重启（退出码 75，见 `api/host-restart-api.ts`）先写 `restartRequested`，下一次启动看到它就
 * 不计数；请求里带 `exitSafeMode` 时同时清除安全模式与计数。
 */
import fs from "node:fs";
import path from "node:path";

/** 缺省状态文件位置（相对进程 cwd，与日志、本地存储的 `.woohaa3/` 同区）。 */
export const DEFAULT_BOOT_STATE_FILE = ".woohaa3/host/boot-state.json";
/** 连续未就绪次数达到该值后，下一次启动进入安全模式。 */
export const DEFAULT_SAFE_MODE_AFTER = 3;

export type SafeModeReason = "boot-failures" | "forced";

export type BootState = {
  /** 连续未就绪的启动次数（含本次正在进行的启动）。 */
  attempts: number;
  lastAttemptAt?: string;
  lastReadyAt?: string;
  /** 受控重启请求：下一次启动不计数并清除该字段。 */
  restartRequested?: { reason: string; at: string };
  /** 持久的安全模式：就绪后仍保留，直到管理员显式退出（或 `WOOHAA3_SAFE_MODE=0`）。 */
  safeMode?: { reason: SafeModeReason; since: string };
  /**
   * 就绪前最近一次扩展启动失败的安全摘要（D7）：只有 extensionId、错误码与截断、脱敏后的消息。
   * 就绪后清除；安全模式启动时投影为 `HostSafeModeView.lastFailure`。
   */
  lastFailure?: BootFailure;
};

export type BootFailure = { extensionId: string; code: string; message: string; at: string };

/** 安全消息上限（字符）。 */
export const BOOT_FAILURE_MESSAGE_MAX = 200;

export type BootDecision = {
  file: string;
  /** 上一次（未就绪）启动留下的最近失败摘要；用于安全模式提示。 */
  lastFailure: BootFailure | null;
  /** 本次启动是否为安全模式；null 表示正常启动。 */
  safeMode: { reason: SafeModeReason; since: string } | null;
  /** 写回后的尝试计数。 */
  attempts: number;
  /** 本次是否由受控重启拉起（不计数）。 */
  restarted: boolean;
};

type Log = (event: Record<string, unknown>) => void;

/** `WOOHAA3_BOOT_STATE_FILE` 覆盖；缺省 `<cwd>/.woohaa3/host/boot-state.json`。 */
export function resolveBootStatePath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.WOOHAA3_BOOT_STATE_FILE?.trim();
  return path.resolve(explicit && explicit.length > 0 ? explicit : DEFAULT_BOOT_STATE_FILE);
}

/** `WOOHAA3_SAFE_MODE_AFTER`：1–100 的整数，非法值回退缺省。 */
export function resolveSafeModeAfter(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WOOHAA3_SAFE_MODE_AFTER?.trim();
  if (!raw) return DEFAULT_SAFE_MODE_AFTER;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_SAFE_MODE_AFTER;
}

/** `WOOHAA3_SAFE_MODE`：`1` 强制进入、`0` 强制关闭，其余按计数判定。 */
export function resolveForcedSafeMode(env: Record<string, string | undefined> = process.env): boolean | null {
  const raw = env.WOOHAA3_SAFE_MODE?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decode(raw: unknown): BootState | null {
  if (!isRecord(raw)) return null;
  const attempts = raw.attempts;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0) return null;
  const state: BootState = { attempts };
  if (typeof raw.lastAttemptAt === "string") state.lastAttemptAt = raw.lastAttemptAt;
  if (typeof raw.lastReadyAt === "string") state.lastReadyAt = raw.lastReadyAt;
  const restart = raw.restartRequested;
  if (isRecord(restart) && typeof restart.reason === "string" && typeof restart.at === "string") {
    state.restartRequested = { reason: restart.reason, at: restart.at };
  }
  const safe = raw.safeMode;
  if (isRecord(safe) && (safe.reason === "boot-failures" || safe.reason === "forced") && typeof safe.since === "string") {
    state.safeMode = { reason: safe.reason, since: safe.since };
  }
  const failure = raw.lastFailure;
  if (
    isRecord(failure) &&
    typeof failure.extensionId === "string" &&
    typeof failure.code === "string" &&
    typeof failure.message === "string" &&
    typeof failure.at === "string"
  ) {
    state.lastFailure = { extensionId: failure.extensionId, code: failure.code, message: failure.message, at: failure.at };
  }
  return state;
}

/** 读取状态；文件缺失为零次，损坏按零次处理并告警（不抛错）。 */
export function readBootState(file: string, log: Log = () => undefined): BootState {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log({ module: "boot", event: "boot-state-unreadable", file, message: error instanceof Error ? error.message : String(error) });
    }
    return { attempts: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const state = decode(parsed);
  if (!state) {
    log({ module: "boot", event: "boot-state-corrupt", file, message: "启动守卫状态文件无法解析，按零次尝试处理" });
    return { attempts: 0 };
  }
  return state;
}

/** 原子写入（tmp + rename）。 */
export function writeBootState(file: string, state: BootState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 加载扩展之前调用：计数加一（受控重启拉起时不计数），并决定本次是否为安全模式。
 *
 * 判定顺序：`WOOHAA3_SAFE_MODE` 强制开关 > 已持久的安全模式 > 之前连续未就绪次数达到阈值。
 * 写入失败只告警（启动守卫不能成为启动失败的新来源）。
 */
export function beginBoot(options: {
  env?: Record<string, string | undefined>;
  file?: string;
  now?: () => Date;
  log?: Log;
} = {}): BootDecision {
  const env = options.env ?? process.env;
  const file = options.file ?? resolveBootStatePath(env);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const log = options.log ?? (() => undefined);
  const previous = readBootState(file, log);
  const restarted = previous.restartRequested !== undefined;
  const next: BootState = { ...previous, attempts: restarted ? previous.attempts : previous.attempts + 1, lastAttemptAt: now };
  delete next.restartRequested;

  const forced = resolveForcedSafeMode(env);
  if (forced === true) {
    next.safeMode = { reason: "forced", since: previous.safeMode?.reason === "forced" ? previous.safeMode.since : now };
  } else if (forced === false) {
    delete next.safeMode;
  } else if (!next.safeMode && !restarted && previous.attempts >= resolveSafeModeAfter(env)) {
    next.safeMode = { reason: "boot-failures", since: now };
  }

  try {
    writeBootState(file, next);
  } catch (error) {
    log({ module: "boot", event: "boot-state-write-failed", file, message: error instanceof Error ? error.message : String(error) });
  }
  if (next.safeMode) {
    log({ module: "boot", event: "safe-mode-entered", reason: next.safeMode.reason, since: next.safeMode.since, attempts: next.attempts });
  }
  return { file, safeMode: next.safeMode ?? null, attempts: next.attempts, restarted, lastFailure: previous.lastFailure ?? null };
}

/**
 * 发出 `host/ready` 之后调用：计数清零。安全模式保留，直到显式退出；导致安全模式的失败摘要随它保留，
 * 正常就绪则清除摘要（它只描述「就绪前」的失败）。
 */
export function markReady(file: string, now: () => Date = () => new Date(), log: Log = () => undefined): void {
  const state = readBootState(file, log);
  const next: BootState = { ...state, attempts: 0, lastReadyAt: now().toISOString() };
  if (!next.safeMode) delete next.lastFailure;
  try {
    writeBootState(file, next);
  } catch (error) {
    log({ module: "boot", event: "boot-state-write-failed", file, message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 受控重启请求：写入 `restartRequested`，下一次启动不计数。`exitSafeMode` 同时清除安全模式与计数。
 * 幂等：重复调用只刷新原因与时间。写入失败抛错，由调用方决定是否仍然重启。
 */
export function markRestartRequested(
  file: string,
  input: { reason: string; exitSafeMode?: boolean },
  now: () => Date = () => new Date()
): void {
  const state = readBootState(file);
  const next: BootState = { ...state, restartRequested: { reason: input.reason, at: now().toISOString() } };
  if (input.exitSafeMode) {
    delete next.safeMode;
    delete next.lastFailure;
    next.attempts = 0;
  }
  writeBootState(file, next);
}

/** 安全消息：去掉绝对路径与疑似凭据，压成单行并截断到 `BOOT_FAILURE_MESSAGE_MAX` 字符。 */
export function sanitizeBootFailureMessage(message: string): string {
  const cleaned = message
    .replace(/[\r\n\t]+/g, " ")
    // 绝对路径（POSIX / Windows / file URL）→ 占位；部署目录结构不进状态文件与界面。
    .replace(/file:\/\/\S+/gi, "<path>")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"'`:;,)]+[\\/])+[^\s"'`:;,)]*/g, "<path>")
    // 键值形式的凭据与 Bearer 令牌。
    .replace(/\b(api[-_]?key|token|secret|password|authorization)\b\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\bbearer\s+\S+/gi, "Bearer <redacted>")
    // 长随机串（疑似密钥 / 哈希）。
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "<redacted>")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.length > BOOT_FAILURE_MESSAGE_MAX ? `${cleaned.slice(0, BOOT_FAILURE_MESSAGE_MAX - 1)}…` : cleaned;
}

/** 安全模式提示用的一行摘要。 */
export function formatBootFailure(failure: BootFailure): string {
  return `${failure.extensionId}：[${failure.code}] ${failure.message}`;
}

/**
 * 记录就绪前的扩展启动失败（覆盖为最近一次）。写入失败只告警：启动守卫不能成为启动失败的新来源。
 */
export function recordBootFailure(
  file: string,
  input: { extensionId: string; code: string; message: string },
  now: () => Date = () => new Date(),
  log: Log = () => undefined
): void {
  const state = readBootState(file, log);
  const failure: BootFailure = {
    extensionId: input.extensionId.slice(0, 120),
    code: input.code.slice(0, 64),
    message: sanitizeBootFailureMessage(input.message),
    at: now().toISOString()
  };
  try {
    writeBootState(file, { ...state, lastFailure: failure });
  } catch (error) {
    log({ module: "boot", event: "boot-state-write-failed", file, message: error instanceof Error ? error.message : String(error) });
  }
}

/** 识别为「扩展启动失败」的宿主日志事件（loader 与站点控制面）。 */
const FAILURE_EVENTS = new Set([
  "extension-start-failed",
  "extension-restart-failed",
  "site-extension-activation-failed"
]);

/**
 * 从宿主结构化日志里取出扩展启动失败（D7）。只读 `extension` / `extensionId`、`code`、`message` 三类字段，
 * 其余字段（配置值、目录等）一律不进状态文件。非失败事件返回 null。
 */
export function bootFailureFromLog(event: Record<string, unknown>): { extensionId: string; code: string; message: string } | null {
  if (typeof event.event !== "string" || !FAILURE_EVENTS.has(event.event)) return null;
  const extensionId = typeof event.extension === "string" ? event.extension : typeof event.extensionId === "string" ? event.extensionId : null;
  if (!extensionId) return null;
  const code = typeof event.code === "string" ? event.code : "activation-failed";
  const message = typeof event.message === "string" ? event.message : "";
  return { extensionId, code, message };
}
