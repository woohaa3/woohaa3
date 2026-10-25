/**
 * 遥测采集的**零依赖原语**与「当前客户端」引用槽
 * （change: 2026-10-20-add-local-client-telemetry，design D7）。
 *
 * 为什么单独一个模块：`canvas-session` / `canvas-session-transport` / `install-services` 都在
 * **入口静态闭包**里，而采集实现（`telemetry-client.ts` + 契约的事件模块）不该为每个用户都在
 * 启动时加载。所以这里只保留三样极小的东西——单调时钟、稳定错误码归一、以及一个可被替换的
 * 客户端引用；真正的客户端由 App scope 启动时动态 import 安装。
 *
 * 引用槽的语义：未安装即 `undefined`（埋点整体 no-op）。这是刻意的——遥测永远不是画布启动的前置条件。
 */
import type { TelemetryClient } from "./telemetry-client.js";

// 纯类型 re-export（编译期擦除）：消费方只从这里取，就不会把采集实现拉进入口闭包。
export type { TelemetryClient } from "./telemetry-client.js";

/** 错误码形状与契约 `TELEMETRY_LIMITS.maxErrorCodeLength` 一致。 */
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/**
 * 埋点耗时统一取 `performance.now()` 差值（单调时钟，不受系统时间调整影响）。
 *
 * 缺少 `performance` 时退回 `Date.now()`（仍只用于差值）；不引入新的计时框架。
 */
export function telemetryNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

/**
 * 把任意拒绝码/错误文案映射成稳定短码。
 *
 * 事件里只允许稳定短码（不是错误消息）：中文文案、服务端 message、带空格的英文都不能进入，
 * 否则同一类失败会因文案变化被聚成许多不同 code（复盘时无法按 code 计数）。
 */
export function stableTelemetryErrorCode(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string") return fallback;
  const folded = value.trim().toLowerCase();
  if (folded === "" || !ERROR_CODE_PATTERN.test(folded)) return fallback;
  return folded;
}

/** 当前已安装的采集客户端（`installTelemetryClient` 写入；未安装即 no-op）。 */
let activeClient: TelemetryClient | undefined;

/** 可选解析：已经安装就返回，否则 `undefined`。 */
export function activeTelemetryClient(): TelemetryClient | undefined {
  return activeClient;
}

/** 安装/替换当前客户端；传 `undefined` 表示卸载。 */
export function setActiveTelemetryClient(client: TelemetryClient | undefined): void {
  activeClient = client;
}

/** 测试：替换/清除"当前已安装客户端"（照 `setAppBasePathForTesting` 的先例）。 */
export function setTelemetryClientForTesting(client: TelemetryClient | undefined): void {
  activeClient = client;
}
