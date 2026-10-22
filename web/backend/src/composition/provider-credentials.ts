/**
 * Provider 凭据管理 API 装配（恢复自迁移前的 `composition/admin-apis.ts` 中 Provider 那一半）。
 *
 * 迁移后 Provider 凭据不再存进程内存：它是 Provider 插件自己配置段（`providers.<id>.apiKey`）里的
 * `secret` 项，由设置服务写进 0600 密钥文件并热生效。本模块因此只把旧的外部契约
 * （`/api/providers` 的公开状态、`providers.credentials.write` 保护的写入/清除）**桥接**到
 * 设置服务的定义表与生成注册表：授权仍在 `createProvidersApiHandler` 内部完成。
 *
 * 快照在**请求时**求值：本插件在核心层先于扩展层装载，插件清单与生成注册表都要等扩展启动后才有值。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FORBIDDEN_CREDENTIAL_FIELDS,
  PROVIDER_SETTING_PREFIX,
  providerIdFromConfigPrefix,
  type ProviderCredentialsSnapshot
} from "@woohaa3/contracts";
import type { AccessEnforcer, ApplicationRequestAuthenticator } from "@woohaa3/application-service";
import { createProvidersApiHandler } from "../api/providers-api.js";
import type { GenerationService } from "../host/context.js";
import type { SettingsPatch, SettingsService } from "../settings/settings-service.js";

export type ProviderManagementApiDeps = {
  settings: Pick<SettingsService, "describe" | "plugins" | "update">;
  generation: Pick<GenerationService, "list" | "resolve">;
  authenticator?: ApplicationRequestAuthenticator;
  accessEnforcer?: AccessEnforcer;
  logger?: (event: Record<string, unknown>) => void;
};

export function createProviderManagementApi(
  deps: ProviderManagementApiDeps
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  // Provider 身份来自设置面登记的插件清单（`configPrefix = providers.<id>`），请求时求值。
  const providerIds = (): string[] =>
    deps.settings
      .plugins()
      .map((plugin) => providerIdFromConfigPrefix(plugin.configPrefix))
      .filter((providerId): providerId is string => providerId !== null);

  // 凭据字段 = 该 Provider 配置段里的敏感项，且不是服务端固定拒绝的地址字段。
  // 地址字段（baseUrl / endpoint 等）由插件写死，不接受用户输入，也不进凭据快照。
  const fieldsFor = (providerId: string) => {
    const head = `${PROVIDER_SETTING_PREFIX}${providerId}.`;
    return deps.settings
      .describe()
      .filter((entry) => entry.key.startsWith(head) && entry.secret === true)
      .map((entry) => ({ key: entry.key.slice(head.length), label: entry.label, configured: entry.configured }))
      .filter((field) => !(FORBIDDEN_CREDENTIAL_FIELDS as readonly string[]).includes(field.key));
  };

  const snapshot = async (): Promise<ProviderCredentialsSnapshot> => ({
    providers: providerIds().map((providerId) => {
      const plugin = deps.settings.plugins().find((entry) => providerIdFromConfigPrefix(entry.configPrefix) === providerId);
      const registration = deps.generation.resolve(providerId);
      const fields = fieldsFor(providerId);
      return {
        providerId,
        label: plugin?.label ?? providerId,
        ...(plugin?.description ? { description: plugin.description } : {}),
        fields: fields.map(({ key, label }) => ({ key, label })),
        // 公开读方向不回显明文：只报「已配置/未配置」。Provider 已可用（例如无凭据也能跑）也算已配置。
        configured: registration?.available === true || fields.some((field) => field.configured)
      };
    })
  });

  const unknown = (providerId: string) =>
    !providerIds().includes(providerId)
      ? { ok: false as const, code: "extension-not-found" as const, message: `未知的 Provider：${providerId}` }
      : null;

  return createProvidersApiHandler({
    authenticator: deps.authenticator,
    accessEnforcer: deps.accessEnforcer,
    snapshot,
    write: async ({ providerId, fields }) => {
      const missing = unknown(providerId);
      if (missing) return missing;
      const patch: SettingsPatch = {};
      for (const [field, value] of Object.entries(fields)) patch[`${PROVIDER_SETTING_PREFIX}${providerId}.${field}`] = value;
      const result = await deps.settings.update(patch);
      if (!result.ok) {
        return {
          ok: false,
          code: "config-invalid",
          message: result.issues.map((issue) => `${issue.key || "(根)"}：${issue.message}`).join("；")
        };
      }
      return { ok: true, snapshot: await snapshot() };
    },
    clear: async ({ providerId }) => {
      const missing = unknown(providerId);
      if (missing) return missing;
      // 公开读方向不回显明文：清除 = 把该 Provider 的凭据项写成 null（设置服务按删除处理）。
      const patch: SettingsPatch = {};
      for (const field of fieldsFor(providerId)) patch[`${PROVIDER_SETTING_PREFIX}${providerId}.${field.key}`] = null;
      const result = await deps.settings.update(patch);
      if (!result.ok) {
        return {
          ok: false,
          code: "config-invalid",
          message: result.issues.map((issue) => `${issue.key || "(根)"}：${issue.message}`).join("；")
        };
      }
      return { ok: true, snapshot: await snapshot() };
    },
    logger: (event) => deps.logger?.({ module: "providers", ...event })
  });
}
