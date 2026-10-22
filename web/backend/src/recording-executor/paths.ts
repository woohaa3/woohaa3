/**
 * 本机录制执行器的私有 socket 目录与授权
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.4 / design D2）。
 *
 * 目录与 socket 的定位规则只有一处实现：
 * - 目录位于用户私有运行时目录，权限 0700；Unix socket 权限 0600；
 * - 路径与 `checkoutId`、宿主实例绑定，避免并行 worktree 互连；
 * - Unix 用文件系统 AF_UNIX socket；Windows 用命名管道（`\\.\pipe\...`），实际管道名
 *   写入同目录 `pipe.name`；不使用 TCP，也不把管道路径当目录。
 *
 * 本模块不建立连接，只回答「在哪里、是否可用」；连接与鉴权在 `executor-server.ts`。
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

/** 目录/文件名长度上限（Linux sun_path 为 108 字节，这里预留余量）。 */
const MAX_SOCKET_PATH_BYTES = 100;

/** 录制执行器支持的平台：Unix 走 AF_UNIX，Windows 走命名管道。 */
export function recordingExecutorPlatformSupported(): boolean {
  return process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";
}

/** Windows 命名管道前缀；与 `desktop/supervisor/src/connection.rs` 保持一致。 */
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * 稳定 checkout 身份：用于把 socket 目录绑定到本 worktree。
 *
 * 只取绝对路径的 SHA-256 前 16 位，不把路径写进 socket 名，避免泄漏私有路径到日志。
 */
export function checkoutIdFor(directory: string): string {
  return createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 16);
}

export type RecordingExecutorPaths = {
  /** 0700 私有目录。 */
  directory: string;
  /** 0600 私有 Unix socket；Windows 为命名管道名。 */
  socketPath: string;
  /** supervisor 从可信启动配置读取的 registration nonce。 */
  noncePath: string;
  /** executor 写入的租约心跳文件，供无 supervisor 时自我终止。 */
  leasePath: string;
  checkoutId: string;
};

export type RecordingExecutorPathOptions = {
  /** 项目/worktree 目录；缺省为进程 cwd。 */
  checkoutDirectory?: string;
  /** 覆盖运行时根目录（测试用）；仍会追加 `woohaa3-recording`。 */
  runtimeRoot?: string;
};

/**
 * 计算宿主实例的 socket 路径。
 *
 * 使用 `WOOHAA3_RECORDING_RUNTIME_ROOT` 或系统临时目录下的 `woohaa3-recording/<checkoutId>`：
 * 用户私有、可被启动期清扫；不使用项目目录，避免只读安装目录。
 */
export function recordingExecutorPaths(options: RecordingExecutorPathOptions = {}): RecordingExecutorPaths {
  const checkoutId = checkoutIdFor(options.checkoutDirectory ?? process.cwd());
  const root = options.runtimeRoot
    ?? process.env.WOOHAA3_RECORDING_RUNTIME_ROOT
    ?? join(tmpdir(), "woohaa3-recording");
  const directory = join(root, checkoutId);
  // Windows 管道名带本次宿主实例的随机后缀，并写入同目录的 pipe.name。
  // supervisor 从文件读取实际管道名，避免 TEMP 的 8.3 短路径与长路径算出不同哈希。
  const socketPath = process.platform === "win32"
    ? `${WINDOWS_PIPE_PREFIX}woohaa3-recording-${checkoutId}-${randomBytes(4).toString("hex")}`
    : join(directory, "executor.sock");
  if (process.platform !== "win32" && Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `录制执行器 socket 路径过长（${Buffer.byteLength(socketPath)} 字节 > ${MAX_SOCKET_PATH_BYTES}）：请设置较短的 WOOHAA3_RECORDING_RUNTIME_ROOT`
    );
  }
  return {
    directory,
    socketPath,
    noncePath: join(directory, "registration.nonce"),
    leasePath: join(directory, "lease.json"),
    checkoutId
  };
}

/**
 * 建立 0700 私有目录；目录已存在时把权限纠正回 0700。
 *
 * 不跟随符号链接到别处：使用者为同一用户，越权写入会由 0600/0700 与 peer 校验拦住。
 */
export function ensureRecordingExecutorDirectory(paths: RecordingExecutorPaths): void {
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const stats = statSync(paths.directory);
  if (!stats.isDirectory()) {
    throw new Error(`录制执行器路径不是目录：${paths.directory}`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    chmodSync(paths.directory, 0o700);
  }
}

/** 启动期清扫：删除本宿主实例的过期 socket 与原子临时文件。 */
export function cleanRecordingExecutorDirectory(paths: RecordingExecutorPaths): void {
  for (const name of ["executor.sock", "pipe.name", "registration.nonce", "lease.json"]) {
    // Windows 命名管道不是文件，删除会失败；服务端关闭时由系统回收。
    if (process.platform === "win32" && name === "executor.sock") continue;
    try {
      rmSync(join(paths.directory, name), { force: true });
    } catch {
      // 清扫失败不应阻断启动；下次启动会再试。
    }
  }
}

/** 当前用户是否拥有该路径（用于拒绝别的用户留下的 socket 目录）。 */
export function ownedByCurrentUser(path: string): boolean {
  try {
    // Windows 不暴露 POSIX uid；运行时目录位于当前用户的私有临时目录，改用目录校验。
    if (process.platform === "win32") return statSync(path).isDirectory();
    return statSync(path).uid === userInfo().uid;
  } catch {
    return false;
  }
}
