/**
 * 基础层 · log（前端）：结构化日志出口，只写浏览器控制台。
 *
 * **这个插件不落盘、不上报、不缓冲**（change: unify-host-client-logging，design D4）。
 * 前端的日志出口就是 console：浏览器没有回读 console 的 API，所以任何"事后导出前端日志"
 * 的方案都必须自己拦截并留存，那是另一件事，本期不做。这里的价值只有三条：
 *
 * 1. **统一调用形状**：扩展与内置插件都用 `ctx.log.scope(module)(event)`，不再各自 `console.log`；
 * 2. **级别过滤**：默认 `warn`，避免 `info` 级噪音淹掉真正要看的信息；
 * 3. **脱敏**：与控制台/宿主共用 contracts 里那一张模式表，凭据不会被打到控制台。
 *
 * 与宿主 `host/base/log.ts` 的差别是刻意的：那边落盘，这边只有 console。共用的是
 * `normalizeLogRecord` 与 `redactLogText`，不是 sink。
 */
import { Logger } from "@deepseek-ai/cordis";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import {
  logLevelAtLeast,
  normalizeLogRecord,
  type LogLevel,
  type LogRecord
} from "@woohaa3/contracts";

/** 前端默认级别；排障时可由设置覆盖。 */
export const FRONTEND_LOG_DEFAULT_LEVEL: LogLevel = "warn";

export type FrontendLogService = {
  /** 带 `module` 字段的结构化日志出口。 */
  scope(module: string): (event: Record<string, unknown>) => void;
  /** 当前生效级别。 */
  level(): LogLevel;
};

/** 控制台方法名与级别的映射；`debug`/`info`/`warn`/`error` 一一对应。 */
const CONSOLE_METHOD: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error"
};

/** 把记录渲染成一行可读文本：`[module] event k=v …`。 */
export function formatLogRecord(record: LogRecord): string {
  const head = `[${record.module}] ${record.event}`;
  const attrs = record.attrs === undefined
    ? ""
    : Object.entries(record.attrs).map(([key, value]) => `${key}=${String(value)}`).join(" ");
  const message = record.message === undefined ? "" : ` ${record.message}`;
  return [head, attrs].filter((part) => part !== "").join(" ") + message;
}

export type FrontendLogPluginOptions = {
  level?: LogLevel;
  /** 测试注入；缺省 `console`。 */
  output?: Pick<Console, "debug" | "info" | "warn" | "error">;
  now?: () => number;
};

export function createFrontendLogPlugin(options: FrontendLogPluginOptions = {}): Plugin {
  const level = options.level ?? FRONTEND_LOG_DEFAULT_LEVEL;
  const output = options.output ?? console;
  const now = options.now ?? (() => Date.now());

  const write = (record: LogRecord): void => {
    // 采集/输出失败绝不能影响业务：控制台被关闭或扩展改写了方法时静默放弃这条。
    try {
      output[CONSOLE_METHOD[record.level]](formatLogRecord(record));
    } catch {
      // 见上。
    }
  };

  return {
    name: "log",
    apply(ctx: Context) {
      const service: FrontendLogService = {
        level: () => level,
        scope: (module) => (event) => {
          const record = normalizeLogRecord({
            module,
            runtime: "web",
            raw: event,
            now: now()
          });
          if (!logLevelAtLeast(record.level, level)) return;
          write(record);
        }
      };
      ctx.provide("log", service);
      // Cordis 自身的日志（插件装载失败等）走同一出口，与宿主侧的取向一致。
      ctx.logger.exporter({
        colors: false,
        export: (message) => {
          const record = normalizeLogRecord({
            module: "cordis",
            runtime: "web",
            raw: { level: message.type, logger: message.name, message: Logger.format({ colors: false, export: () => undefined }, message) },
            now: now()
          });
          if (!logLevelAtLeast(record.level, level)) return;
          write(record);
        }
      });
    }
  };
}
