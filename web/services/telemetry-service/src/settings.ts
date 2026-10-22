/**
 * 宿主注入的遥测设置读取面（change: 2026-10-20-add-local-client-telemetry）。
 *
 * 这里刻意不引用 `HostSettings` / 设置存储：本包只要求宿主给出"当前值"的读取函数，不关心
 * 值存在哪里。设置项都是 `reload: "hot"`，因此实现每次调用都应读到最新值——本包不做缓存，
 * 也不订阅变更，避免"改了设置要重启才生效"。
 *
 * 对应设置键（见 `web/contracts/src/settings/index.ts`）：
 * - `telemetry.local.enabled` → `localEnabled()`
 * - `telemetry.local.retentionDays` → `retentionDays()`
 * - `telemetry.local.maxRows` → `maxRows()`
 * - `telemetry.export.enabled` → `exportEnabled()`
 *
 * **没有"目的地"设置**：「发到哪」是出口插件自己的配置（部署地址、登录凭据都在它那里）。
 * core 只回答"发不发"；出口注册进来就按各自实现投递，core 不枚举、不挑选，也不需要知道
 * 具体扩展的身份（那正是 `extension-purity` 要避免的耦合）。
 */
export type TelemetrySettings = {
  /** 本机记录开关。关闭时 `emit` 变成 no-op（业务照常，只是不再留痕）。 */
  localEnabled(): boolean;
  /** 保留天数；与 `maxRows` 同时生效。 */
  retentionDays(): number;
  /** 最多保留条数；与 `retentionDays` 同时生效。 */
  maxRows(): number;
  /** 外部导出总开关。缺省关闭；关闭时根本不调用任何出口。 */
  exportEnabled(): boolean;
};
