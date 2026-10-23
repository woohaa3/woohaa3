/**
 * Codex 本机配置/账号复用
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 4.1 / design D5）。
 *
 * 本机 Codex 的真实登录/自定义 provider 配置位于后端机器的现有 `CODEX_HOME`（通常
 * `~/.codex`）。本扩展不复制 token，也不把全局 `mcp_servers` 带进受控工具面：
 * - 为每条连接的专用配置目录创建**只读符号链接**（`config.toml`、`auth.json`）；
 * - Codex 的会话、历史仍写入专用配置目录，不污染用户 CLI 的 session；
 * - 传输层读取链接后的 `config.toml`，把继承的 MCP server 显式 `enabled = false`。
 *
 * 若部署显式设置 `WOOHAA3_LOCAL_AGENT_CODEX_HOME`，以该目录为来源；否则按
 * `CODEX_HOME` → `$HOME/.codex` 查找。来源不存在时保持当前空配置行为。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";

/** 复用的 Codex home 文件；只读符号链接，不复制内容。 */
const CODEX_HOME_FILES = ["config.toml", "auth.json"] as const;

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 只判断路径项是否存在（包括指向不存在目标的符号链接）。 */
function pathEntryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析后端机器当前的 Codex home。
 *
 * 显式的 `CODEX_HOME` 优先；否则使用 `$HOME/.codex`。只返回实际存在的目录，
 * 避免把空路径当成可复用来源。
 */
export function resolveCodexHome(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = (env.CODEX_HOME ?? "").trim();
  const candidates = [
    ...(configured !== "" ? [configured] : []),
    ...(env.HOME?.trim() ? [path.join(env.HOME.trim(), ".codex")] : []),
  ];
  for (const candidate of candidates) {
    if (isDirectory(candidate)) return path.resolve(candidate);
  }
  return null;
}

/**
 * 为一条连接的专用配置目录准备 Codex home。
 *
 * 目标目录为 `<configDir>/.codex`（Codex 按 `HOME=/<configDir>` 读取）。已存在的
 * 文件不覆盖，便于用户给某条连接单独准备配置。符号链接失败时保留当前空配置，
 * 不复制 secret。
 */
export function prepareCodexConfigDir(
  configDir: string,
  sourceHome: string,
): { linked: string[]; sourceFound: boolean } {
  if (!isDirectory(sourceHome)) return { linked: [], sourceFound: false };
  const target = path.join(configDir, ".codex");
  if (path.resolve(target) === path.resolve(sourceHome)) {
    return { linked: [], sourceFound: true };
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });

  const linked: string[] = [];
  for (const file of CODEX_HOME_FILES) {
    const source = path.join(sourceHome, file);
    if (!isFile(source)) continue;
    const destination = path.join(target, file);
    if (pathEntryExists(destination)) continue;
    try {
      symlinkSync(source, destination);
      linked.push(file);
    } catch {
      // 平台不允许符号链接时保持空配置；由用户显式准备专用配置。
    }
  }
  return { linked, sourceFound: true };
}

function readCodexToml(configDir: string): string | null {
  const configFile = path.join(configDir, ".codex", "config.toml");
  if (!existsSync(configFile)) return null;
  try {
    return readFileSync(configFile, "utf8");
  } catch {
    return null;
  }
}

/** 读取某条连接专用 Codex home 中继承的 MCP server 名称（不读取其值）。 */
export function inheritedMcpServerNames(configDir: string): string[] {
  const toml = readCodexToml(configDir);
  return toml ? parseMcpServerNames(toml) : [];
}

/** 读取继承的 Codex 插件名，供本轮线程显式关闭。 */
export function inheritedPluginNames(configDir: string): string[] {
  const toml = readCodexToml(configDir);
  return toml ? parsePluginNames(toml) : [];
}

/**
 * 从 TOML 文本提取 `[mcp_servers.<name>]` / `[mcp_servers."<name>"]` 的 server 名。
 *
 * 只读取 section 头，不解析 token 或其他配置值。Codex 的全局 MCP 目前使用这种
 * 表结构；子表（如 `[mcp_servers.foo.env]`）不是 server 名，不纳入。
 */
export function parseMcpServerNames(toml: string): string[] {
  const names = new Set<string>();
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    // 未加引号的 TOML key 不把 `.` 当名字的一部分；带点的 server 名用引号形式。
    // section 头允许尾随注释。
    const match = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\](?:\s*#.*)?$/.exec(line);
    if (!match) continue;
    const name = match[1] ?? match[2];
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * 从 TOML 文本提取 `[plugins.<name>]` / `[plugins."<name>"]` 的插件名。
 *
 * 只读 section 头。全局 Codex 插件（browser / documents / search 等）会把
 * `search_service.web_run` 这类工具带进线程，必须在本轮显式关掉。
 */
export function parsePluginNames(toml: string): string[] {
  const names = new Set<string>();
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^\[plugins\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\](?:\s*#.*)?$/.exec(line);
    if (!match) continue;
    const name = match[1] ?? match[2];
    if (name) names.add(name);
  }
  return [...names];
}
