/**
 * local-agent 扩展共享定义（前后端均可导入；不含秘密、进程或网络实现）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.1/4.1/6.1/6.3 / design D1/D2）。
 *
 * 本扩展拥有需要**后端本机专用进程**的来源：
 * - Codex App Server（stdio JSON-RPC）；
 * - OpenCode Server（HTTP + SSE，location 级 MCP）；
 * - CodeBuddy Server（HTTP + ACP）。
 *
 * 共享定义只描述身份、适配器与部署配置读取；进程/协议实现在后端 `src/backend/`。
 * 线上默认 release 不安装本扩展（design D9）。
 */
import type { AgentConnectionAuthMode, AgentConnectionRunCategory } from "@woohaa3/contracts";

export const LOCAL_AGENT_PLUGIN_ID = "local-agent";

/** 公开映射：`/api/local-agent/*` → 本插件的受控原始 HTTP registration。 */
export const LOCAL_AGENT_PUBLIC_BASE_PATH = "/api/local-agent";

/** 连接发现 capability 的 providerId。 */
export const LOCAL_AGENT_CONNECTION_PROVIDER_ID = "local-agent";

export type LocalAgentAdapterId = "codex-appserver" | "opencode-server" | "codebuddy-server";

export type LocalAgentAdapterDescriptor = {
  adapterId: LocalAgentAdapterId;
  label: string;
  runCategory: AgentConnectionRunCategory;
  authMode: AgentConnectionAuthMode;
  /** 传输：stdio JSON-RPC 或 HTTP(+SSE) + ACP。 */
  transport: "stdio-jsonrpc" | "http-sse" | "http-acp";
  /** 需要登录的工具（官方登录流程；应用不复制认证文件）。 */
  requiresLocalLogin: boolean;
  /** 已核验的支持版本范围（未知版本明确拒绝）。 */
  supportedVersions: string;
  /** 默认回环端口范围（专用进程；不占用共享 daemon）。 */
  defaultPort: number;
};

export const LOCAL_AGENT_ADAPTERS: readonly LocalAgentAdapterDescriptor[] = [
  {
    adapterId: "codex-appserver",
    label: "本地 ChatGPT",
    runCategory: "local-appserver",
    authMode: "local-login",
    transport: "stdio-jsonrpc",
    requiresLocalLogin: true,
    supportedVersions: "0.162.x",
    defaultPort: 0
  },
  {
    adapterId: "opencode-server",
    label: "本地 OpenCode",
    runCategory: "local-appserver",
    authMode: "local-login",
    transport: "http-sse",
    requiresLocalLogin: false,
    supportedVersions: "v2",
    defaultPort: 4096
  },
  {
    adapterId: "codebuddy-server",
    label: "本地 CodeBuddy",
    runCategory: "local-appserver",
    authMode: "local-login",
    transport: "http-acp",
    requiresLocalLogin: true,
    supportedVersions: "beta",
    defaultPort: 4100
  }
] as const;

export function findLocalAgentAdapter(adapterId: string): LocalAgentAdapterDescriptor | undefined {
  return LOCAL_AGENT_ADAPTERS.find((adapter) => adapter.adapterId === adapterId);
}

/** 更新历史默认名称的展示，保留用户自定义名称与持久连接身份。 */
export function localAgentConnectionName(adapterId: string, name: string): string {
  const legacyNames: Record<string, string> = {
    "codex-appserver": "Codex App Server（本机）",
    "opencode-server": "OpenCode Server（本机）",
    "codebuddy-server": "CodeBuddy Server（本机）",
  };
  return name === legacyNames[adapterId] ? findLocalAgentAdapter(adapterId)!.label : name;
}

/**
 * 部署配置（`WOOHAA3_LOCAL_AGENT_*`）。
 *
 * - `CODEX_BIN` / `OPENCODE_BIN` / `CODEBUDDY_BIN`：已安装可执行文件（不自动下载）。
 * - `WORK_DIR`：专用工作/配置目录根（不等于用户项目仓库）。
 * - `WOOHAA3_LOCAL_AGENT_CODEX_HOME`：可选，指定复用的现有 Codex home
 *   （含 `config.toml` / `auth.json`）；未指定时按 `CODEX_HOME` → `$HOME/.codex`
 *   查找。只读符号链接，不复制 token。
 *
 * 是否使用本机来源由站点插件开关控制；这里不再读取额外的部署总开关。
 */
export type LocalAgentDeployment = {
  codexBin: string | null;
  opencodeBin: string | null;
  codebuddyBin: string | null;
  workDir: string | null;
  /** 复用的现有 Codex home；null 表示按 CODEX_HOME / $HOME/.codex 自动解析。 */
  codexHome: string | null;
  /** 允许的回环端口范围（含端）。 */
  portRange: { min: number; max: number };
};

export function readLocalAgentDeployment(env: Record<string, string | undefined>): LocalAgentDeployment {
  const read = (key: string) => (env[key] ?? "").trim();
  const min = Number(read("WOOHAA3_LOCAL_AGENT_PORT_MIN") || "42000");
  const max = Number(read("WOOHAA3_LOCAL_AGENT_PORT_MAX") || "42100");
  const workDir = read("WOOHAA3_LOCAL_AGENT_WORK_DIR");
  const codexHome = read("WOOHAA3_LOCAL_AGENT_CODEX_HOME");
  return {
    codexBin: read("WOOHAA3_LOCAL_AGENT_CODEX_BIN") || null,
    opencodeBin: read("WOOHAA3_LOCAL_AGENT_OPENCODE_BIN") || null,
    codebuddyBin: read("WOOHAA3_LOCAL_AGENT_CODEBUDDY_BIN") || null,
    // 专用工作/配置目录根：部署未指定时为 null，由后端入口用系统临时目录兜底
    // （仍按 owner/连接隔离）；不等于用户项目仓库。
    workDir: workDir !== "" ? workDir : null,
    // 复用的现有 Codex home；null 时由后端入口按 CODEX_HOME → $HOME/.codex 解析。
    codexHome: codexHome !== "" ? codexHome : null,
    portRange:
      Number.isInteger(min) && Number.isInteger(max) && min > 0 && max >= min && max <= 65535
        ? { min, max }
        : { min: 42000, max: 42100 }
  };
}

/** 明确「进程位于后端机器」的提示（design D1/D5）。 */
export const LOCAL_AGENT_LOCATION_NOTE = "本机服务运行在 Woohaa 后端所在机器上，不会回连你的电脑。";
