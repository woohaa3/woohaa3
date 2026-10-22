/**
 * Extension 公共前端事件契约
 * （change: 2026-10-10-extract-optional-feature-extensions，design D4）。
 *
 * 前端事件目录（`cordis/events/catalog.ts`）是唯一权威声明：它定义每个事件的 payload 类型，并经
 * `declare module "@deepseek-ai/cordis"` 增强 `Events`，使 `ctx.emit/on` 获得类型约束。
 *
 * 本模块把目录的**类型**与其 `Events` 增强经 type-only 方式带入 extension 类型程序，使扩展可以
 * 类型安全地 `ctx.on/emit` 目录事件；运行时依赖闭包不含目录运行时数据（`import type`/`export
 * type` 被擦除，不把宿主事件目录打进扩展浏览器产物）。
 */
// 空 type-only import：把目录纳入 extension 类型程序以应用 `Events` 增强；运行时被完全擦除。
import type {} from "../cordis/events/catalog.js";

export type {
  FrontendEventName,
  FrontendEventPayloads,
  FrontendEventSignatures
} from "../cordis/events/catalog.js";
