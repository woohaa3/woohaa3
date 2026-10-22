/**
 * OAuth Agent 来源扩展共享定义（前后端均可导入；不含秘密、SDK 或任一端的运行时实现）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 9.3 / design D11）。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const OAUTH_AGENT_PLUGIN_ID = "oauth-agent";

/** 公开映射：`/api/oauth-agent/*` → 本插件的原始 HTTP registration（design D4）。 */
export const OAUTH_AGENT_PUBLIC_BASE_PATH = "/api/oauth-agent";

export const OAUTH_AGENT_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: OAUTH_AGENT_PLUGIN_ID,
  name: "OAuth Agent 来源",
  description: "个人 OAuth 授权与连接；3D 生成面板由宿主内置（design D10）。",
  version: "1.0.0",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "chatgpt-plugin-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [
    { id: "chatgpt.status", kind: "handler", description: "授权状态快照", auth: "public" },
    { id: "chatgpt.generate", kind: "handler", description: "生成与进度流", auth: "public" },
    { id: "chatgpt.http", kind: "handler", description: "OAuth 回调/SSE 受控原始 HTTP 面", auth: "public" }
  ]
};

/**
 * OAuth 来源的 provider 声明
 * （change: 2026-10-16-...，任务 9.6 / design D11）。
 *
 * 扩展按本列表组织：`providerId` 是**持久化线路标识**（连接 `adapterId`、转换 `providerId`、
 * 画布 `modelKey` 前缀、会话记录 `adapter_id`），必须稳定；新增 OAuth 厂商只需向本列表添加一项，
 * 不改宿主 `authoring.generate`/连接契约。`routePrefix` 是公开路由前缀。
 */
export type OAuthAgentProvider = {
  providerId: string;
  /** 3D 生成面板「来源」标签。 */
  label: string;
  routePrefix: string;
};

/** 当前 provider：ChatGPT（后续 OAuth 厂商在此追加）。 */
export const OAUTH_AGENT_PROVIDERS: readonly OAuthAgentProvider[] = [
  { providerId: "chatgpt", label: "ChatGPT（OAuth）", routePrefix: "oauth-agent" }
];
