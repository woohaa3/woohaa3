/**
 * **宿主 Cordis 根**（本机宿主进程）上扩展可见的服务面：每个服务一个模块，契约在这里定义。
 *
 * 依赖方向是单向的：
 *
 * ```text
 * contracts/extension/services/host  ←(定义)  web/backend（实现、注入）
 *          ↑
 * contracts/extension/host（宿主的装载/身份/装配契约，实现侧消费）
 * ```
 *
 * 所以本目录 MUST NOT import `../../host/runtime.js`（宿主装配面）或 `../../../backend/*`
 * （后端专属契约）；服务用到的**协议/身份声明**（`manifest` / `access` / `http` / `secrets` /
 * `store` / `app-page` / `service-connection`）仍在 `../../host/`，只从那里取类型。
 * 宿主侧要用的注册形状也在这里定义，由 `../../host/runtime.js` 反向引用。
 */
export * from "./log.js";
export * from "./capabilities.js";
export * from "./web-server.js";
export * from "./diagnostics.js";
export * from "./facades.js";
export * from "./generation.js";
export * from "./storage.js";
export * from "./exposer.js";
export * from "./telemetry.js";
export * from "./marketplace.js";
export * from "./media-formats.js";
export * from "./agent-roles.js";
export * from "./context.js";

export type { ExtensionExecutorModule, ExtensionExecutorEvent, ExtensionExecutorOutcome, ApplicationExtensionExecutorFacade } from "./executor.js";
