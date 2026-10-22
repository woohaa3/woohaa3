/**
 * Provider 凭据 dialog definition。
 *
 * 一个专用弹窗（不挂在插件管理器里）：按各 Provider 配置段里声明的密钥项动态渲染。
 * 只声明可序列化 payload 与校验；busy/Escape/焦点/输入隔离由 Dialog Service 统一拥有。
 */
import { objectPayload } from "../../services/dialogs/registry.js";
import type { DialogDefinition } from "../../services/dialogs/types.js";

export const PROVIDER_CREDENTIALS_DIALOG_ID = "provider-credentials";

export type ProviderCredentialsPayload = Record<string, never>;

export const providerCredentialsDefinition: DialogDefinition = {
  dismissible: true,
  singleton: true,
  size: "md",
  variant: "standard",
  validatePayload: objectPayload<ProviderCredentialsPayload>(PROVIDER_CREDENTIALS_DIALOG_ID, () => ({}))
};
