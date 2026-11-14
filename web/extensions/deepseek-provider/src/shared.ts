/**
 * DeepSeek 官方 Provider 的共享身份与端点常量。
 *
 * 官方地址固定在这里，不做成配置项：凭据只能发往 `api.deepseek.com`。同一 host 下还有
 * Anthropic 兼容面（`/anthropic`）与 Responses 面，本插件只用 OpenAI 兼容的
 * `/chat/completions`，与 `@sdppp/pptask` 的 `chat-completions` 协议一致。
 * 模型名单来自 `GET /models`，代码里**没有**内置模型 id 清单。前后端均可导入，不含执行
 * 实现、网络或秘密。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const DEEPSEEK_PLUGIN_ID = "deepseek-provider";

export const DEEPSEEK_PROVIDER_ID = "deepseek";

/** 官方 OpenAI 兼容 origin。请求路径由插件自己拼 `/v1/...`。 */
export const DEEPSEEK_ORIGIN = "https://api.deepseek.com";

/** 模型列表（OpenAI 兼容形状，需 Bearer）。 */
export const DEEPSEEK_MODELS_PATH = "/models";

/** 对话补全。 */
export const DEEPSEEK_CHAT_PATH = "/chat/completions";

/**
 * 对外声明的 OpenAI 兼容入口（`/v1` 前缀）。
 *
 * 宿主的服务来源投影要求每个协议声明一条 `baseUrl`，Agent 侧按
 * `<baseUrl>/chat/completions` 拼请求；这里必须与执行路径同源，否则来源「已配置」
 * 却打不到同一个端点。Provider 本身仍只用 `DEEPSEEK_ORIGIN` 拼路径。
 */
export const DEEPSEEK_CHAT_ENDPOINT = `${DEEPSEEK_ORIGIN}/v1`;

/**
 * 思考模式档位（官方 `reasoning_effort` 的取值，见「思考模式」文档）。
 *
 * 官方还接受 `minimal` / `medium` / `xhigh` / `ultra` 这些别名并映射到 low/high/max，
 * 但目录接口的 `effort.supported_levels` 只列规范档位，因此这里也只放规范值。
 */
export const DEEPSEEK_REASONING_EFFORTS = ["low", "high", "max"] as const;

export const DEEPSEEK_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: DEEPSEEK_PLUGIN_ID,
  name: "DeepSeek Provider",
  description: "DeepSeek 官方 API。填写 API Key 后，从官方模型列表发现可用的文本模型（含思考模式与图像理解）。",
  version: "1.0.1",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "deepseek-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [],
  defaultEnabled: true
};
