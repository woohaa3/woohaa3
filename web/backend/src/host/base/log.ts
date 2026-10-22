/** 基础层 · log：结构化日志出口，Cordis 自己的日志（如插件装载失败）也进同一个出口。 */
import { Logger } from "@deepseek-ai/cordis";
import type { HostLog, HostLogService } from "@woohaa3/contracts";
import type { HostPlugin } from "../context.js";

export const logPlugin: HostPlugin<{ sink: HostLog }> = {
  name: "log",
  apply(ctx, { sink }) {
    // 诊断缓冲是 log 的下游投影：一条事件只写一次，落盘与内存缓冲共享同一个入口。
    // 用 `get` 而不是 `inject`：没有诊断插件（独立入口/测试）时日志照常工作。
    const diagnostics = ctx.get("diagnostics");
    const write: HostLog = (event) => {
      diagnostics?.record(event);
      sink(event);
    };
    const service: HostLogService = { scope: (module) => (event) => write({ module, ...event }) };
    ctx.provide("log", service);
    ctx.logger.exporter({
      colors: false,
      export: (message) => {
        write({ module: "cordis", level: message.type, logger: message.name, message: Logger.format({ colors: false, export: () => undefined }, message) });
      }
    });
  }
};
