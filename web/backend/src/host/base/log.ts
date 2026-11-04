/**
 * 基础层 · log：结构化日志出口，Cordis 自己的日志（如插件装载失败）也进同一个出口。
 *
 * 记录路径：`ctx.log.scope(module)` → 归一（在 sink 里做）→ stderr + 落盘文件。
 * 导出面 `GET /api/logs/export` 也登记在这里：它只对日志负责，不引入新领域。
 */
import { Logger } from "@deepseek-ai/cordis";
import type { HostLog, HostLogService } from "@woohaa3/contracts";
import type { HostPlugin, HostContext } from "../context.js";
import { ROUTE_ORDER } from "../order.js";
import { collectLogExport, parseExportSince } from "../log-export.js";

/** 导出端点路径。 */
const LOG_EXPORT_PATH = "/api/logs/export";

export const logPlugin: HostPlugin<{ sink: HostLog; logDir?: string | null }> = {
  name: "log",
  // `gateway` 是导出路由的前提：没有它 ctx.gateway 不可访问，插件会直接装载失败。
  inject: ["gateway"],
  apply(ctx, { sink, logDir }) {
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
    registerExportRoute(ctx, logDir ?? null);
  }
};

/**
 * 导出路由。
 *
 * 没有落盘目录（`WOOHAA3_LOG_DIR` 为空串，或调用方注入了自己的 logger）时**不登记**：
 * 那意味着宿主本来就不写文件，导出只会回一个空 manifest，容易让人误判"没有日志"。
 */
function registerExportRoute(ctx: HostContext, logDir: string | null): void {
  if (logDir === null) return;
  ctx.effect(() =>
    ctx.gateway.route(ROUTE_ORDER.logExport, async (req, res) => {
      if (!isExportPath(req.url) || req.method !== "GET") return false;
      const url = new URL(req.url ?? LOG_EXPORT_PATH, "http://localhost");
      const now = Date.now();
      let result: ReturnType<typeof collectLogExport>;
      try {
        result = collectLogExport({
          dir: logDir,
          since: parseExportSince(url.searchParams.get("since"), now),
          now
        });
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: error instanceof Error ? error.message : "export-failed" }));
        return true;
      }
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        // 文件名带时间戳，便于用户回传给开发时区分多次导出。
        "content-disposition": `attachment; filename="woohaa-logs-${new Date(result.manifest.exportedAt).toISOString().replace(/[:.]/g, "-")}.ndjson"`
      });
      res.end(result.body);
      return true;
    })
  );
}

function isExportPath(url: string | undefined): boolean {
  const pathname = new URL(url ?? "/", "http://localhost").pathname;
  return pathname === LOG_EXPORT_PATH;
}
