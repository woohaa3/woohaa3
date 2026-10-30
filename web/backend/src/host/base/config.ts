/**
 * 基础层 · config：YAML 配置与密钥文件（热重载），以及设置页读写的 `/api/settings`。
 *
 * 扩展的配置段由扩展装载器经 `register` 合并进定义表，设置页按同一份描述生成表单。
 */
import { createSettingsApiHandler } from "../../api/settings-api.js";
import { createSettingsService, resolveSettingsFiles, type SettingsService } from "../../settings/settings-service.js";
import type { HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";

export const configPlugin: HostPlugin<{ env: Record<string, string | undefined>; settings?: SettingsService; directoryControl?: import("../../extensions/manifest.js").LoadedExtensionHost["directoryControl"] }> = {
  name: "config",
  inject: ["log", "gateway", "access"],
  async apply(ctx, { env, settings: injected, directoryControl }) {
    const log = ctx.log.scope("settings");
    const settings = injected ?? await createSettingsService({ ...resolveSettingsFiles(env), env, logger: log });
    if (!injected) ctx.effect(() => () => settings.close());
    ctx.provide("config", settings);
    const handler = createSettingsApiHandler({
      settings,
      directoryControl,
      // 核心层比 config 晚装载：按请求现查注册表，构造时不缓存。
      storageBackends: () => ctx.get("storage")?.list(),
      exposers: () => ctx.get("exposer")?.list(),
      // 安全模式视图归 application（核心层）所有，按请求现取。
      safeMode: () => ctx.get("application")?.safeMode ?? null,
      // 受管扩展归核心层 extensionManager，按请求现取。
      extensionManager: () => ctx.get("extensionManager"),
      authenticator: ctx.access.authenticator,
      accessEnforcer: ctx.access.accessEnforcer,
      logger: log
    });
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.settings, handler));
  }
};
