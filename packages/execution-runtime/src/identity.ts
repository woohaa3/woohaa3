/**
 * 执行器运行时身份快照（change: 2026-11-10-split-agent-runtime-lifecycle，任务 1.1）。
 *
 * `executor.json` 是 workspace 级运行时的唯一身份来源：宿主与 dev 启动器先读它并 `ping`，
 * 身份匹配才复用；不匹配（workspace、schema、端点）时只报告，不结束对方进程。
 *
 * 目录固定 `0700`、token 与快照固定 `0600`。旧版快照缺少 `schemaVersion`，读取时按不兼容处理
 * （design D7：旧运行时不被误接管）。
 */
import fs from "node:fs";
import path from "node:path";

/** 身份快照结构版本；缺少该字段的旧快照视为不兼容。 */
export const EXECUTOR_IDENTITY_SCHEMA_VERSION = 2;
/** 运行时制品版本；宿主只在 schema 匹配且支持事件 cursor 时接管。 */
export const EXECUTOR_RUNTIME_VERSION = "0.1.0";
/** 接管所需的最小协议版本（`turn.events` cursor 与 `turn.query` 的稳定语义）。 */
export const EXECUTOR_ADOPTION_PROTOCOL_VERSION = 1;

export type ExecutorIdentity = {
  schemaVersion: number;
  workspaceKey: string;
  pid: number;
  socketPath: string;
  token: string;
  startedAt: number;
  runtimeVersion: string;
};

export type ExecutorIdentityRead =
  | { ok: true; identity: ExecutorIdentity }
  | { ok: false; reason: "missing" | "malformed" | "legacy" | "insecure-directory"; message: string };

export const EXECUTOR_IDENTITY_FILE = "executor.json";

export function executorIdentityPath(runtimeDir: string): string {
  return path.join(runtimeDir, EXECUTOR_IDENTITY_FILE);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** 严格解码：拒绝半成品快照，不按缺失字段猜默认值。 */
export function decodeExecutorIdentity(value: unknown): ExecutorIdentity | null {
  if (!isObject(value)) return null;
  const schemaVersion = value.schemaVersion;
  const workspaceKey = value.workspaceKey;
  const pid = value.pid;
  const socketPath = value.socketPath;
  const token = value.token;
  const startedAt = value.startedAt;
  const runtimeVersion = value.runtimeVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) return null;
  for (const field of [workspaceKey, socketPath, token, runtimeVersion]) {
    if (typeof field !== "string" || field.trim() === "") return null;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) return null;
  return {
    schemaVersion,
    workspaceKey: workspaceKey as string,
    pid,
    socketPath: socketPath as string,
    token: token as string,
    startedAt,
    runtimeVersion: runtimeVersion as string
  };
}

/**
 * 私有运行时目录：`0700`、属主为当前用户、不是符号链接。
 *
 * 不满足时拒绝复用别人的端点或 token（spec: workspace 或身份不匹配时拒绝复用）。
 */
export function verifyRuntimeDirectory(runtimeDir: string): { ok: true } | { ok: false; message: string } {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return { ok: true };
  const stat = fs.lstatSync(runtimeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, message: "运行时目录必须是真实目录" };
  if (stat.uid !== process.getuid?.()) return { ok: false, message: "运行时目录必须属于当前用户" };
  if ((stat.mode & 0o077) !== 0) {
    fs.chmodSync(runtimeDir, 0o700);
    const repaired = fs.lstatSync(runtimeDir);
    if ((repaired.mode & 0o077) !== 0) return { ok: false, message: "运行时目录必须为私有目录（0700）" };
  }
  return { ok: true };
}

export function readExecutorIdentity(runtimeDir: string): ExecutorIdentityRead {
  const directory = verifyRuntimeDirectory(runtimeDir);
  if (!directory.ok) return { ok: false, reason: "insecure-directory", message: directory.message };
  let text: string;
  try {
    text = fs.readFileSync(executorIdentityPath(runtimeDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, reason: "missing", message: "尚无执行器运行时身份" };
    return { ok: false, reason: "malformed", message: error instanceof Error ? error.message : String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "malformed", message: "executor.json 不是合法 JSON" };
  }
  if (!isObject(parsed) || typeof parsed.schemaVersion !== "number") {
    return { ok: false, reason: "legacy", message: "executor.json 缺少 schemaVersion，按旧运行时处理" };
  }
  const identity = decodeExecutorIdentity(parsed);
  if (!identity) return { ok: false, reason: "malformed", message: "executor.json 字段不完整或类型错误" };
  return { ok: true, identity };
}

export function writeExecutorIdentity(runtimeDir: string, identity: ExecutorIdentity): void {
  const directory = verifyRuntimeDirectory(runtimeDir);
  if (!directory.ok) throw new Error(directory.message);
  const target = executorIdentityPath(runtimeDir);
  const temporary = path.join(runtimeDir, `.${EXECUTOR_IDENTITY_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(identity), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
}

/** 只在快照仍属于当前进程/端点时删除，避免接管者写下的新身份被旧进程清掉。 */
export function clearExecutorIdentity(runtimeDir: string, expected: { pid: number; workspaceKey: string }): boolean {
  const current = readExecutorIdentity(runtimeDir);
  if (!current.ok) return false;
  if (current.identity.pid !== expected.pid || current.identity.workspaceKey !== expected.workspaceKey) return false;
  try {
    fs.unlinkSync(executorIdentityPath(runtimeDir));
    return true;
  } catch {
    return false;
  }
}

/** 运行时是否满足接管前提：schema 匹配且协议支持 `turn.events` cursor。 */
export function isAdoptableIdentity(identity: ExecutorIdentity): { ok: true } | { ok: false; reason: string } {
  if (identity.schemaVersion !== EXECUTOR_IDENTITY_SCHEMA_VERSION) {
    return { ok: false, reason: `运行时 schema ${identity.schemaVersion} 与当前 ${EXECUTOR_IDENTITY_SCHEMA_VERSION} 不兼容` };
  }
  return { ok: true };
}

/** 进程存活探测（不结束对方）；EPERM 视为存活。 */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
