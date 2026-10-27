/**
 * Extension 前端入口描述与 plugin 定义辅助
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 2.2 / design D1/D6）。
 *
 * 业务 extension 只从本模块获得：入口描述类型、完整 Cordis plugin 定义辅助，以及宿主注入
 * 的运行时能力（Context/Plugin 类型、平台 Service 与公共 UI）。本模块是**叶子 API**：
 * 运行时依赖不得回到 extension 扫描器、Canvas manifest、bootstrap 或具体业务插件，避免循环
 * 装配。Cordis 只做 type-only 引用（运行时实例由宿主注入）。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { ExtensionAppPageMetadata, ExtensionAppPageRuntime } from "@woohaa3/contracts";
import { withApplyGuard } from "../cordis/service-access-guard.js";

/** 入口装配策略（静态可信元数据，不可由 browser-local 偏好改写）。 */
export type ExtensionFrontendActivation = "always" | "server-active" | "browser-local";

/**
 * 前端入口配置范围（change: 2026-10-10-extract-optional-feature-extensions，design D2）：
 * - `site`：站点应用插件（服务端权威配置）；
 * - `browser-local`：纯前端可选能力，只由当前 origin 的浏览器本地选择控制。
 */
export type ExtensionFrontendConfigScope = "site" | "browser-local";

/**
 * extension 前端入口描述。`plugin` 是**无副作用工厂**：只有宿主请求装配时才构造完整 Cordis
 * plugin；`extensionId` 由源码导入绑定（语言级，不解析字符串），供构建期扫描判定身份。
 */
export type ExtensionFrontendDescriptor = {
  extensionId: string;
  /** 配置范围；缺省 `site`（站点应用插件）。`browser-local` 用于纯前端可选能力。 */
  configScope?: ExtensionFrontendConfigScope;
  /** 装配策略；缺省 `server-active`（由服务端权威状态驱动）。 */
  activation?: ExtensionFrontendActivation;
  /**
   * 常驻入口的启动失败边界（`required: true` 时装配失败视为 scope 启动失败）。
   * 仅 `activation: "always"`（进入 kernel 清单）时有实际意义；browser-local 入口 MUST NOT
   * 声明 required（按 optional 处理）。
   */
  required?: boolean;
  label?: string;
  description?: string;
  /**
   * 本扩展的 app/page 贡献。两种形态按来源区分：
   * - 直接来自 `metadata.appPages` 的**纯路由数据**（`ExtensionAppPageMetadata`，无实现）；
   * - 扩展在 descriptor 里显式覆盖的**运行时入口**（`ExtensionAppPageRuntime`，带 `createPlugin`）。
   * 宿主按 pageId 关联两边：Router 用纯路由解析路径，page scope 用 `createPlugin` 装配页面。
   * 缺省表示本扩展不贡献独立页面。
   */
  appPages?: readonly (ExtensionAppPageRuntime | ExtensionAppPageMetadata)[];
  /** 无副作用构造 plugin；宿主负责在目标 scope 装配并拥有 fiber 生命周期。 */
  plugin: () => Plugin;
  /**
   * 设置专用入口（可选；change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.1）。
   *
   * 只构造「设置面板」所需的贡献（`settings.plugin-config`），MUST NOT 启动生成入口、画布事件、
   * 业务轮询或任务执行。宿主仅在用户打开设置、且该扩展**未激活**时按需调用，并在关闭设置时
   * 释放该 fiber；缺少本入口的旧 artifact 只复用已存在的贡献，不回退执行完整 `plugin()`。
   *
   * 与 metadata 的 `settingsPanel: boolean`（声明「本扩展有设置面板」）是两件事：后者是纯数据
   * 声明，前者是可执行的设置专用工厂。
   */
  settingsPlugin?: () => Plugin;
};

/** 扫描器从 `web/extensions/*\/src/frontend/index.ts` 读取的模块形状。 */
export type ExtensionFrontendModule = {
  descriptor: ExtensionFrontendDescriptor;
};

/** 声明一个 extension 前端入口描述（纯数据 + 工厂，无副作用）。 */
export function defineExtensionFrontend(descriptor: ExtensionFrontendDescriptor): ExtensionFrontendDescriptor {
  if (!descriptor.extensionId) throw new Error("extension 前端入口必须声明非空 extensionId");
  if (typeof descriptor.plugin !== "function") throw new Error("extension 前端入口必须提供 plugin()");
  if (descriptor.activation === "browser-local" && descriptor.required === true) {
    throw new Error(`browser-local extension 入口不得声明 required：${descriptor.extensionId}`);
  }
  return descriptor;
}

/**
 * 完整 Cordis plugin 定义辅助（等价于宿主 kernel 的 `definePlugin`）。
 *
 * `Object.assign(fn, { name })` 会因函数 `name` 只读而在严格模式抛错；这里用
 * `Object.defineProperty` 设置 Cordis 需要的 `name`/`inject`/`provide` 元数据。
 */
export function defineExtensionPlugin<T extends Context>(
  body: (ctx: T) => void | (() => void | Promise<void>),
  meta: { name: string; inject: readonly string[]; provide?: string | string[] }
): Plugin.Function<void> {
  const plugin = ((ctx: Context) => withApplyGuard(ctx as T, meta.name, body)) as Plugin.Function<void>;
  Object.defineProperty(plugin, "name", { value: meta.name, configurable: true });
  Object.defineProperty(plugin, "inject", { value: [...meta.inject], configurable: true });
  if (meta.provide) Object.defineProperty(plugin, "provide", { value: meta.provide, configurable: true });
  return plugin;
}
