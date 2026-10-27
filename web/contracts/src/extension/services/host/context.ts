/**
 * 扩展可注入的**宿主服务面**：扩展通过 `ctx` 能用到哪些服务。
 *
 * 与 `../../plugin.js` 的分工：那里是「插件是什么形状」，这里是「插件能拿到什么」。每个服务的
 * 契约在 `./<service>.js` **定义**，本机宿主（`web/backend`）实现并在装载时注入；服务模块
 * MUST NOT 反向 import 宿主的装配面（`../../host/runtime.js`）或后端专属目录。
 *
 * 服务名就是 `Context` 上的键（Cordis 的约定）：宿主 `ctx.provide(name, service)` 注册，
 * 扩展直接 `ctx.generation` / `ctx.storage` / `ctx.webServer` 使用，不需要 import 服务类型。
 * `HostExtensionContext` 只是把这些键汇总成装载器实际注入的那份类型。
 *
 * 为什么用交叉类型而不是 Cordis 的 `declare module` 增强：增强是**全局**的——只要这个模块进入
 * 编译程序，程序里的每个 `Context` 都会声称拥有这些服务。DeepSeek Harness 能做到按包增强，
 * 是因为每个服务是独立 npm 包、消费者装谁得谁；而 `@woohaa3/contracts` 是浏览器与宿主共用的
 * 单包，前端 import 根入口就会把 `ctx.generation` / `ctx.storage` 一起带进类型面，而运行时前端
 * 根本没有这些服务（实测会让前端编译通过并调用到 undefined）。
 *
 * 所以服务面在这里只做**显式类型**：装载器把它作为 `apply` 的第一参交给插件，扩展不需要
 * 全局增强也能拿到完整类型。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { HostCapabilityService } from "./capabilities.js";
import type { ApplicationBackendDiagnostics } from "./diagnostics.js";
import type { ApplicationExtensionServices } from "./facades.js";
import type { HostGenerationService } from "./generation.js";
import type { HostLogService } from "./log.js";
import type { HostMarketplaceService } from "./marketplace.js";
import type { HostStorageService } from "./storage.js";
import type { HostTelemetryService } from "./telemetry.js";
import type { HostWebServerService } from "./web-server.js";

export type HostExtensionContext = Context & {
  readonly log: HostLogService;
  readonly generation: HostGenerationService;
  readonly storage: HostStorageService;
  /**
   * 扩展市场来源注册面（change: 2026-10-21-add-extension-marketplace-point，D1/D3）。
   * 只有内置根扩展可以注册来源；受管根 / 可写根扩展调用 `register` 会被宿主拒绝。
   */
  readonly marketplace: HostMarketplaceService;
  /**
   * 受控 HTTP 路由（可选：最小装配/测试里可能没有 gateway）。
   *
   * 与 `generation` / `storage` 同级：它是**公共基础设施**，不是某类插件的专属特权。
   * 声明它是可选的原因：纯 provider 插件不需要它，宿主在无 gateway 的组合里也不提供。
   */
  readonly webServer?: HostWebServerService;
  /**
   * 宿主注入的领域服务 facade（documents / canvas / media / task 等）。
   *
   * 可选：最小装配里没有。插件按存在与否决定能力，不要假定一定注入。
   */
  readonly services?: ApplicationExtensionServices;
  /** 遥测核心：`emit` / `query` / `registerExport` 在同一服务上（core 层必备）。 */
  readonly telemetry: HostTelemetryService;
  /**
   * 只读部署上下文（`basePath` 等）。
   *
   * 插件据此把应用逻辑路径解析为公开 URL，不在插件内自持可变部署配置。
   */
  readonly deployment?: { readonly basePath: string };
  /** 能力注册表（可选）：插件把能力对象交给宿主，由核心层按需解析。 */
  readonly capabilities?: HostCapabilityService;
  /** 宿主诊断缓冲（可选）：只读投影，用于排障面板。 */
  readonly diagnostics?: ApplicationBackendDiagnostics;
};
