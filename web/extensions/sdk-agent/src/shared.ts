/**
 * sdk-agent 扩展共享定义（前后端均可导入；不含秘密、SDK 实例或网络实现）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.1/5.1/7.1 / design D1/D2）。
 *
 * 本扩展拥有四类 API 的固定 Agent 引擎；历史适配器 ID 保留。共享定义只描述**身份、可选适配器与授权方式**，
 * 供前端 metadata 与后端装配复用；具体协议编解码在后端 `src/backend/`。
 */
import type {
  AgentConnectionAuthMode,
  AgentConnectionRunCategory,
} from "@woohaa3/contracts";

export const SDK_AGENT_PLUGIN_ID = "sdk-agent";

/** 公开映射：`/api/sdk-agent/*` → 本插件的受控原始 HTTP registration。 */
export const SDK_AGENT_PUBLIC_BASE_PATH = "/api/sdk-agent";

/** 连接发现 capability 的 providerId（= `agent-connection-provider:<providerId>`）。 */
export const SDK_AGENT_CONNECTION_PROVIDER_ID = "sdk-agent";

/**
 * 适配器 id 与元数据。
 *
 * 四种 API 表示协议类型，均可填写部署策略允许的 Base URL；官方地址仅作默认值。
 */
export type SdkAgentAdapterId =
  | "openai-responses"
  | "anthropic-messages"
  | "compat-chat"
  | "codex-agent-sdk"
  | "claude-agent-sdk"
  | "gemini-agent-adk";

export type SdkAgentAdapterDescriptor = {
  adapterId: SdkAgentAdapterId;
  label: string;
  runCategory: AgentConnectionRunCategory;
  authMode: AgentConnectionAuthMode;
  /** 官方 endpoint（留空时的默认值）。 */
  officialBaseUrl: string;
  allowCustomBaseUrl: boolean;
  /** 是否需要随包安装的原生运行时（CLI/子进程）；ADK 进程内运行为 false。 */
  requiresLocalRuntime: boolean;
  /** 默认模型建议（用户可显式改写；不冒充账号已授权）。 */
  suggestedModels: readonly string[];
};

export const SDK_AGENT_ADAPTERS: readonly SdkAgentAdapterDescriptor[] = [
  {
    adapterId: "openai-responses",
    label: "OpenAI Responses API",
    runCategory: "agent-sdk",
    authMode: "api-key",
    officialBaseUrl: "https://api.openai.com/v1",
    allowCustomBaseUrl: true,
    requiresLocalRuntime: true,
    suggestedModels: ["gpt-5", "gpt-4.1", "gpt-4o"],
  },
  {
    adapterId: "anthropic-messages",
    label: "Anthropic Messages API",
    runCategory: "agent-sdk",
    authMode: "api-key",
    officialBaseUrl: "https://api.anthropic.com/v1",
    allowCustomBaseUrl: true,
    requiresLocalRuntime: true,
    suggestedModels: ["claude-sonnet-4-5", "claude-opus-4-1"],
  },
  {
    adapterId: "compat-chat",
    label: "Chat Completions API",
    runCategory: "agent-sdk",
    authMode: "api-key",
    officialBaseUrl: "https://api.openai.com/v1",
    allowCustomBaseUrl: true,
    requiresLocalRuntime: true,
    suggestedModels: [],
  },
  {
    adapterId: "codex-agent-sdk",
    label: "Codex Agent SDK",
    runCategory: "agent-sdk",
    authMode: "api-key",
    officialBaseUrl: "https://api.openai.com/v1",
    allowCustomBaseUrl: true,
    requiresLocalRuntime: true,
    suggestedModels: ["gpt-5-codex", "gpt-5"],
  },
  {
    adapterId: "claude-agent-sdk",
    label: "Claude Agent SDK",
    runCategory: "agent-sdk",
    authMode: "api-key",
    officialBaseUrl: "https://api.anthropic.com/v1",
    allowCustomBaseUrl: true,
    requiresLocalRuntime: true,
    suggestedModels: ["claude-sonnet-4-5"],
  },
  {
    adapterId: "gemini-agent-adk",
    label: "Gemini API",
    runCategory: "agent-sdk",
    authMode: "api-key",
    officialBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    allowCustomBaseUrl: true,
    requiresLocalRuntime: false,
    suggestedModels: [],
  },
] as const;

export function findSdkAgentAdapter(
  adapterId: string,
): SdkAgentAdapterDescriptor | undefined {
  return SDK_AGENT_ADAPTERS.find((adapter) => adapter.adapterId === adapterId);
}

/**
 * 允许的自定义 endpoint host（部署策略）。
 *
 * 默认不限制 host（允许所有中转站）。
 * 若部署显式配置了 `WOOHAA3_SDK_AGENT_ALLOWED_HOSTS`（逗号分隔，支持 `*.suffix`），则按配置过滤；配置为空或 `*` 均表示不限制。
 */
export const DEFAULT_SDK_AGENT_ALLOWED_HOSTS: readonly string[] = ["*"];

export function readAllowedHostsFromEnv(
  env: Record<string, string | undefined>,
): readonly string[] | undefined {
  const raw = (env.WOOHAA3_SDK_AGENT_ALLOWED_HOSTS ?? "").trim();
  if (raw === "" || raw === "*") return undefined;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** 是否允许明文回环（本机兼容服务）；缺省仅显式开启。 */
export function readAllowHttpFromEnv(
  env: Record<string, string | undefined>,
): boolean {
  return (env.WOOHAA3_SDK_AGENT_ALLOW_HTTP ?? "").trim() === "1";
}


/** Persisted adapter IDs stay stable; users choose API type, never an engine. */
export function sdkEngineForAdapter(adapterId: string): {
  apiType: import("@woohaa3/contracts").AgentApiType;
  engine: import("@woohaa3/contracts").AgentEngineId;
  version: string;
} | null {
  switch (adapterId) {
    case "openai-responses": case "codex-agent-sdk":
      return { apiType: "openai", engine: "codex-agent-sdk", version: "0.161.0" };
    case "anthropic-messages": case "claude-agent-sdk":
      return { apiType: "anthropic", engine: "claude-agent-sdk", version: "0.3.301" };
    case "compat-chat":
      return { apiType: "chat-completions", engine: "dsh-agent-sdk", version: "0.2.2-rc.1" };
    case "gemini-agent-adk":
      return { apiType: "gemini", engine: "gemini-agent-adk", version: "2.3.0" };
    default: return null;
  }
}
