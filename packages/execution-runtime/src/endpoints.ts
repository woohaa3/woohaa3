/**
 * 端点命名与子进程启动目标。
 *
 * 与项目既有 dev supervisor 保持完全相同的命名规则：Windows 使用命名管道（Unix socket
 * 文件路径在 win32 上不可用），非 Windows 使用 `.local/` 下的 socket 文件；批处理 `.cmd`
 * 垫片交给 shell 执行。
 */
import crypto from "node:crypto";
import path from "node:path";

export const WINDOWS = "win32";
export const BATCH_SUFFIX = /\.(cmd|bat)$/i;

const isWindows = (platform: string) => platform === WINDOWS;

export function hashKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 40);
}

export function executorEndpoint(input: {
  platform?: string;
  workspaceKey: string;
  runtimeDir: string;
}): string {
  const platform = input.platform ?? process.platform;
  if (isWindows(platform)) return `\\\\.\\pipe\\woohaa-executor-${input.workspaceKey}`;
  return path.join(input.runtimeDir, "executor.sock");
}

export function stdioEndpoint(input: {
  platform?: string;
  key: string;
  stdioDir: string;
}): string {
  const platform = input.platform ?? process.platform;
  if (isWindows(platform)) return `\\\\.\\pipe\\woohaa-executor-stdio-${hashKey(input.key)}`;
  return path.join(input.stdioDir, `${hashKey(input.key)}.sock`);
}

export function resolveSpawnTarget(
  command: string,
  args: readonly string[] = [],
  platform: string = process.platform
): { command: string; args: string[]; shell: boolean } {
  if (!isWindows(platform) || !BATCH_SUFFIX.test(command)) return { command, args: [...args], shell: false };
  return {
    command: `"${command}"`,
    args: args.map((arg) => (arg === "" ? '""' : arg)),
    shell: true
  };
}

/** 默认 workspace 身份：用 checkout 目录摘要，避免多个 worktree 抢同一个命名管道。 */
export function workspaceKeyFor(directory: string): string {
  return hashKey(directory);
}
