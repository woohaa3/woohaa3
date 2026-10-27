/**
 * 应用插件前端入口的**纯类型契约**
 * （change: 2026-10-05-extract-application-plugin-host，任务 1.2 / design D2；
 *  change: 2026-10-10-unify-extension-frontend-entry，任务 2.1 / design D1/D6）。
 *
 * 只声明浏览器侧可信入口的数据形状：没有模块地址、URL、脚本或源码字段。可执行入口由
 * frontend 构建期扫描 `web/extensions/*` 的约定前端入口静态获得；管理数据只能按 extensionId
 * 引用，不能加载任意代码。
 *
 * 入口本身是一个**完整 Cordis plugin**：宿主在目标 scope 用 `ctx.plugin(entry.createPlugin())`
 * 装配，并在 scope 退出/撤销时 `dispose` fiber。`createPlugin` 是无副作用工厂，只在宿主请求
 * 装配时构造 plugin；构造与 `extensionId`/展示元数据的求值都不注册业务资源。
 *
 * 具体 registry、reconciliation 与扫描实现属 frontend 运行时，不在本模块。Cordis 只做
 * **type-only** 引用：本包不打包、不运行 Cordis。
 */
import type { Plugin } from "@deepseek-ai/cordis";
import type { ExtensionFrontendMetadata, ExtensionBrowserDescriptor } from "./frontend-browser.js";

/**
 * 前端入口的配置范围（change: 2026-10-10-extract-optional-feature-extensions，design D2）：
 * - `site`：站点应用插件（服务端权威配置，`always`/`server-active`）；
 * - `browser-local`：纯前端可选能力，只由当前 origin 的浏览器本地选择控制。
 *
 * `browser-local` MUST 为 optional 且可由用户配置；它没有占位 backend、站点配置行或管理员依赖，
 * 也 MUST NOT 被服务端状态推导/改写。
 */
export type ApplicationExtensionFrontendConfigScope = "site" | "browser-local";

/**
 * 入口装配策略（静态可信元数据，不可由 browser-local 偏好改写）：
 * - `always`：进入对应 page scope 的常驻 kernel 清单；
 * - `server-active`：由服务端权威 active 状态驱动，经 reconciler 装配/释放；
 * - `browser-local`：纯前端可选能力，由当前 Canvas page scope 启动时的浏览器本地选择装配。
 */
export type ApplicationExtensionFrontendActivation = "always" | "server-active" | "browser-local";

/**
 * 一个可信前端入口。`createPlugin` 是构建时静态给定的有界入口：
 * 运行时只按 extensionId 调用已登记的入口，绝不从字符串解析模块。
 */
export type ApplicationExtensionFrontendEntry = {
  extensionId: string;
  configScope: ApplicationExtensionFrontendConfigScope;
  /**
   * 装配策略；缺省由扫描/装配方按约定补齐。
   *
   * `always` 入口进入所属 page scope 的常驻 kernel 清单（当前没有此类入口）；
   * `server-active` 入口只由服务端权威 active 状态驱动装配。
   */
  activation: ApplicationExtensionFrontendActivation;
  /**
   * extension app/page 贡献（change: 2026-10-13-...，任务 0.5/8.1）：
   * 宿主 Router 只认识 canvas 与**通用** extension page，不硬编码具体业务 pageId。
   * 每个页面附带独立的 page-scope plugin 工厂与旧路径白名单转换。
   */
  appPages?: readonly import("./app-page.js").ExtensionAppPageEntry[];
  /**
   * page-scope 启动失败边界：
   * - `required: true`：装配/依赖失败视为该 scope 启动失败（沿用既有 required 规则）；
   * - `false`/缺省：失败只暴露诊断并撤销自身贡献，保持无关核心功能可用。
   *
   * 仅对常驻（进入 kernel 清单）的入口有实际意义；`server-active` 入口由 reconciler
   * 装配，失败不会使 scope 启动失败。
   */
  required?: boolean;
  /** 无副作用构造完整 Cordis plugin；宿主在目标 scope 装配并拥有其 fiber 生命周期。 */
  createPlugin: () => Plugin;
  /** 用户可读名称（管理面展示；可选）。 */
  label?: string;
  /** 简短说明（管理面展示；可选）。 */
  description?: string;
};

export type ApplicationExtensionFrontendEntrySummary = {
  extensionId: string;
  configScope: ApplicationExtensionFrontendConfigScope;
  activation: ApplicationExtensionFrontendActivation;
};

/**
 * 浏览器侧异步入口契约（change: 2026-10-12-build-and-load-extensions-independently，任务 4.6 /
 * design D4/D7）。
 *
 * 与旧的同步 `createPlugin` 并存于本模块以兼容管理投影，但**生产装配**改为经此异步契约：
 * `metadata` 是纯数据（无副作用，来自发布目录）；`loadDescriptor()` 触发资源和实现加载，
 * 返回无副作用的 descriptor/plugin 工厂。加载与安装分离：本接口不创建 plugin/Fiber。
 *
 * `metadata` 仍然是**目录身份**，不是加载结果：`loadDescriptor` 在实现求值后另行校验
 * descriptor identity 与 metadata 一致。
 */
export type ApplicationExtensionFrontendAsyncEntry = {
  metadata: ExtensionFrontendMetadata;
  /** 加载 artifact/实现并返回无业务副作用的 descriptor；不创建 plugin/Fiber。 */
  loadDescriptor(): Promise<ExtensionBrowserDescriptor>;
};
