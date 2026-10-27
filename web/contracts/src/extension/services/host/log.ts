/**
 * `ctx.log`：结构化日志出口。
 *
 * 服务契约在这里**定义**，本机宿主（`web/backend`）**实现**并在装载时注入。扩展只依赖这份
 * 类型，不 import 宿主实现；宿主侧的 log 服务必须满足这里的形状。
 */
export type HostLog = (event: Record<string, unknown>) => void;

export type HostLogService = {
  /** 带 `module` 字段的结构化日志出口。 */
  scope(module: string): HostLog;
};
