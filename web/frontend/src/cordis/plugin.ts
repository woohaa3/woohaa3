/**
 * Plugin 定义辅助（change: adopt-frontend-cordis-plugin-runtime）。
 *
 * `Object.assign(fn, { name })` 会因函数的 `name` 是只读属性而在严格模式下抛错；
 * 这里用 `Object.defineProperty` 正确设置 Cordis 需要的 `name`/`inject`/`provide` 元数据。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { withApplyGuard } from "./service-access-guard.js";

export function definePlugin<T extends Context>(
  body: (ctx: T) => void | (() => void | Promise<void>),
  meta: { name: string; inject: readonly string[]; provide?: string | string[] }
): Plugin.Function<void> {
  const plugin = ((ctx: Context) => withApplyGuard(ctx as T, meta.name, body)) as Plugin.Function<void>;
  Object.defineProperty(plugin, "name", { value: meta.name, configurable: true });
  Object.defineProperty(plugin, "inject", { value: [...meta.inject], configurable: true });
  if (meta.provide) Object.defineProperty(plugin, "provide", { value: meta.provide, configurable: true });
  return plugin;
}
