/** 只读发现后端机器上的工具与 App Server；不启动、不接管或停止任何进程。 */
import { accessSync, constants } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalAgentAdapterDescriptor } from "../shared.js";
import { parseOpenCodeHealth } from "./protocol/opencode-http.js";

export type LocalAgentDetection = {
  installed: boolean;
  running: boolean;
  managed: boolean;
  endpoint?: string;
  version?: string;
  note: string;
};

export function resolveLocalExecutable(
  configured: string | null,
  command: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  // Windows 上 npm/pnpm 会同时生成 `codex`（POSIX sh 脚本）与 `codex.cmd`（批处理）。
  // 无扩展名那个即使 X_OK 通过也**不可 spawn**（Node 报 ENOENT/EINVAL/EFTYPE），
  // 因此优先选真正可执行的 `.exe`/`.cmd`/`.bat`，把无扩展名留作最后的兜底。
  const names =
    process.platform === "win32"
      ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
      : [command];
  // OpenCode 官方安装脚本把可执行文件放在 `~/.opencode/bin`，只把它追加到交互式 shell 的
  // PATH；后端进程可能在该目录进入 PATH 之前启动（先起服务、后装工具）。部署显式配置仍然
  // 优先且不做兜底，避免把写错的部署路径悄悄替换成另一份安装。
  const fallbackDirs =
    command === "opencode" && env.HOME?.trim()
      ? [path.join(env.HOME.trim(), ".opencode", "bin")]
      : [];
  const candidates = configured
    ? [configured]
    : [...(env.PATH ?? "").split(path.delimiter), ...fallbackDirs]
        .flatMap((directory) =>
          directory ? names.map((name) => path.join(directory, name)) : [],
        );
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* 继续检查 PATH 中的入口。 */
    }
  }
  return null;
}

async function runningCommands(): Promise<string[][]> {
  if (process.platform === "linux") {
    const entries = await readdir("/proc").catch(() => []);
    return Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry))
        .map(async (entry) => {
          try {
            return (await readFile(`/proc/${entry}/cmdline`, "utf8"))
              .split("\0")
              .filter(Boolean);
          } catch {
            return [];
          }
        }),
    );
  }
  if (process.platform === "darwin") {
    try {
      const result = await promisify(execFile)("ps", ["-A", "-o", "args="], {
        timeout: 1500,
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.split("\n").map((line) => line.trim().split(/\s+/));
    } catch {
      return [];
    }
  }
  return [];
}

export function createLocalAgentDiscovery(options: {
  executableFor: (id: string) => string | null;
  fetchImpl?: typeof globalThis.fetch;
  listProcesses?: () => Promise<string[][]>;
}) {
  let processRead: Promise<string[][]> | null = null;
  const processesForRequest = () => {
    if (!processRead)
      processRead = (options.listProcesses ?? runningCommands)().finally(() => {
        processRead = null;
      });
    return processRead;
  };
  return async (
    adapter: LocalAgentAdapterDescriptor,
    managed: boolean,
  ): Promise<LocalAgentDetection> => {
    const installed = options.executableFor(adapter.adapterId) !== null;
    const command =
      adapter.adapterId === "codex-appserver"
        ? "codex"
        : adapter.adapterId === "opencode-server"
          ? "opencode"
          : "codebuddy";
    const processes = await processesForRequest();
    const processFound = processes.some(
      (args) =>
        (path.basename(args[0] ?? "").replace(/\.(?:exe|js|cjs|mjs)$/, "") ===
          command ||
          (/^(?:node|bun|deno)(?:\.exe)?$/.test(path.basename(args[0] ?? "")) &&
            path.basename(args[1] ?? "").replace(/\.(?:js|cjs|mjs)$/, "") ===
              command)) &&
        args.includes(command === "codex" ? "app-server" : command === "codebuddy" ? "--serve" : "serve"),
    );
    if (adapter.transport === "stdio-jsonrpc")
      return {
        installed,
        managed,
        running: managed || processFound,
        note: managed
          ? "应用使用的 App Server 正在运行。"
          : processFound
            ? "检测到已有 App Server 进程，生成时使用独立会话。"
            : installed
              ? "已找到工具，生成时自动启动 App Server。"
              : "未找到工具，请先在后端机器安装 Codex。",
      };
    const endpoint = `http://127.0.0.1:${adapter.defaultPort}`;
    try {
      const response = await (options.fetchImpl ?? globalThis.fetch)(
        `${endpoint}${adapter.adapterId === "opencode-server" ? "/api/info" : "/api/v1/health"}`,
        { method: "GET", headers: { "x-codebuddy-request": "true" }, redirect: "error", signal: AbortSignal.timeout(1200) },
      );
      const text = await response.text();
      const parsed =
        adapter.adapterId === "opencode-server"
          ? parseOpenCodeHealth(
              response.status,
              response.headers.get("content-type") ?? "",
              text,
            )
          : (() => {
              try {
                const health = JSON.parse(text) as { data?: { status?: string } };
                return response.ok && health.data?.status === "ok"
                  ? { ok: true as const, version: undefined }
                  : { ok: false as const, message: `CodeBuddy 健康检查未就绪（HTTP ${response.status}）` };
              } catch { return { ok: false as const, message: "CodeBuddy 健康响应不是 JSON" }; }
            })();
      return {
        installed,
        managed,
        running: managed || processFound || parsed.ok,
        endpoint,
        ...(parsed.ok && parsed.version ? { version: parsed.version } : {}),
        note: parsed.ok
          ? "已发现运行中的服务。使用时建立独立会话。"
          : response.status === 401 || response.status === 403
            ? "发现需要认证的服务，尚未确认协议。"
            : parsed.message,
      };
    } catch {
      return {
        installed,
        managed,
        running: managed || processFound,
        note: managed
          ? "应用使用的服务正在运行。"
          : processFound
            ? "检测到服务进程，默认端口尚未响应。"
            : installed
              ? "已找到工具，生成时自动启动服务。"
              : "未发现工具或运行中的服务。",
      };
    }
  };
}
