/** 本机宿主发现与安装外部 MCP 客户端；配置已写入不代表客户端已连接。 */
export const MCP_INSTALLATION_PATH = "/api/mcp-installation";

/** 与宿主注册表一致；新增客户端时同步 `web/backend/src/mcp-installation/registry.ts`。 */
export type McpInstallClientId =
  | "codex"
  | "opencode"
  | "claude-code"
  | "gemini-cli"
  | "qwen-code"
  | "amp"
  | "factory-droid"
  | "qoder"
  | "codebuddy"
  | "kimi"
  | "deepseek-harness"
  | "cursor"
  | "cline"
  | "windsurf"
  | "copilot"
  | "zed"
  | "continue"
  | "zcode"
  | "workbuddy";

export type McpInstallClientGroup = "cli" | "editor";

/** 同一客户端可声明多个安装目标（例如按 profile 存放配置的客户端）。 */
export type McpInstallTarget = {
  /** 注册表内稳定 key；单目标客户端为 "default"。 */
  key: string;
  label: string;
  /** 宿主自己派生的绝对路径，浏览器不可提交。 */
  path: string;
  configured: boolean;
  error?: string;
};

export type McpInstallClient = {
  id: McpInstallClientId;
  label: string;
  group: McpInstallClientGroup;
  /** 第一个目标的路径，保留给旧 UI 与调用方。 */
  configPath: string;
  /** 第一个目标的状态，保留给旧 UI 与调用方。 */
  configured: boolean;
  error?: string;
  targets: McpInstallTarget[];
};

export type McpInstallationStatus = { clients: McpInstallClient[] };
export type McpInstallationResult = { client: McpInstallClient; changed: boolean };
