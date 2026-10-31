/** 只读发现后端机器上的工具与 App Server；不启动、不接管或停止任何进程。 */
import { accessSync, closeSync, constants, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
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

/** 脚本头是否声明 `#!...node`。只读前 256 字节，不执行任何东西。 */
function isNodeLaunchScript(file: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const buffer = Buffer.alloc(256);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytes).toString("utf8").split("\n", 1)[0] ?? "";
    return first.startsWith("#!") && /(?:^|[\s/\\])(?:node|nodejs)(?:\.exe)?(?:$|\s)/.test(first);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch { /* 只读探测失败不影响后续候选。 */ }
  }
}

/**
 * npm/pnpm/nvm/fnm 全局安装把 `#!/usr/bin/env node` 脚本放到 PATH，真正可执行的架构二进制在
 * 可选依赖 `@openai/codex-<platform>-<arch>/vendor/<triple>/bin/codex`。打包 App 只继承
 * launchd 的最小 PATH（`/usr/bin:/bin:...`），里面没有 `node`，脚本入口必然以
 * `env: node: No such file or directory` 失败。沿 shim 所在包向上找同包的原生二进制。
 */
function vendoredCodexBinary(launcher: string): string | null {
  let directory: string;
  try {
    directory = path.dirname(realpathSync(launcher));
  } catch {
    return null;
  }
  const moduleRoots = (base: string): string[] => {
    // npm/pnpm 全局布局是 `<prefix>/bin/<name>` + `<prefix>/lib/node_modules`；
    // 版本管理器（fnm/nvm）把 `bin/<name>` 链到包内入口，realpath 后已在包目录里。
    const roots = path.basename(base) === "node_modules"
      ? [base]
      : [path.join(base, "node_modules"), path.join(base, "lib", "node_modules")];
    return roots;
  };
  for (let depth = 0; depth < 10; depth += 1) {
    for (const modules of moduleRoots(directory)) {
      let packages: string[] = [];
      try { packages = readdirSync(path.join(modules, "@openai")); } catch { /* 该层没有 npm 包，继续向上。 */ }
      for (const name of packages) {
        if (!/^codex-[a-z0-9-]+$/.test(name)) continue;
        const vendor = path.join(modules, "@openai", name, "vendor");
        let targets: string[] = [];
        try { targets = readdirSync(vendor); } catch { /* 未安装该平台的可选依赖。 */ }
        for (const target of targets) {
          const candidate = path.join(vendor, target, "bin", process.platform === "win32" ? "codex.exe" : "codex");
          try {
            if (!statSync(candidate).isFile()) continue;
          } catch { continue; }
          if (!isNodeLaunchScript(candidate)) return candidate;
        }
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/** 打包 App 只继承 launchd 的 PATH，用户级安装目录需要显式补进搜索范围。 */
function searchDirectories(env: Record<string, string | undefined>): string[] {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  const directories = [...(env.PATH ?? "").split(path.delimiter)];
  if (home) directories.push(
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, "Library", "Application Support", "fnm", "aliases", "default", "bin"),
    path.join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
    path.join(home, ".nvm", "current", "bin"),
  );
  if (process.platform === "darwin") directories.push("/opt/homebrew/bin", "/usr/local/bin");
  return directories.filter((directory) => Boolean(directory) && path.isAbsolute(directory));
}

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
  const fallbackDirs = command === "codebuddy"
    ? process.platform === "win32"
      ? env.LOCALAPPDATA?.trim() ? [path.join(env.LOCALAPPDATA.trim(), "codebuddy", "bin")] : []
      : env.HOME?.trim() ? [path.join(env.HOME.trim(), ".local", "bin")] : []
    : [];
  const candidates = configured
    ? [configured]
    : [...searchDirectories(env), ...fallbackDirs]
        .flatMap((directory) => directory ? names.map((name) => path.join(directory, name)) : []);
  for (const candidate of candidates) {
    let found = candidate;
    try {
      accessSync(found, constants.X_OK);
      // 找到 Node 脚本入口不等于能启动：包内的 node 不在 launchd PATH 里。回落到**同一个
      // npm 包**内的原生二进制；找不到时保留入口本身，由后续启动失败给出真实原因。
      if (command === "codex" && isNodeLaunchScript(found)) found = vendoredCodexBinary(found) ?? found;
      return found;
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
  executableFor: (id: string) => string | null | Promise<string | null>;
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
    const installed = (await options.executableFor(adapter.adapterId)) !== null;
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
          ? "本地 ChatGPT 正在运行。"
          : processFound
            ? "检测到本地 ChatGPT 正在运行，生成时使用独立会话。"
            : installed
              ? "已找到工具，生成时自动启动本地 ChatGPT。"
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
