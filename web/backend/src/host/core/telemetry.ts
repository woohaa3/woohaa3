/**
 * 核心层 · telemetry：`ctx.telemetry` 扩展点与 `/api/telemetry/*` 接入面
 * （change: 2026-10-20-add-local-client-telemetry，design D2 / D4 / D7）。
 *
 * 分工只有一条线：**core 拥有事实，出口只搬运**。事件的归一、本地记录、保留、查询与异常规则
 * 都在服务包里；这里只做装配——按设置开关建服务、把 intake 路由登记进 gateway、卸载时关闭。
 *
 * 为什么不把本地记录做成 provider：出口缺失时事件会无声消失，而"事后复盘"恰恰不能有这种空窗。
 * 出口（`TelemetryExport`）才是扩展点语义，由站点扩展注册进同一个服务实例。
 *
 * 存储路径与其它本机库同源：`dirname(任务库路径) / telemetry.sqlite`，不新增环境变量
 * （照 `generationPolicyPath` 的推导方式）。
 */
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TELEMETRY_INSPECT_ACTION, type HostTelemetryService } from "@woohaa3/contracts";
import { createTelemetryService, handleTelemetryRequest } from "@woohaa3/telemetry-service";
import { statusForAccessError } from "@woohaa3/application-service";
import { readStorePath } from "../../composition/config.js";
import type { HostContext, HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";

/** `telemetry.sqlite` 与任务库/生成模型库同目录（`dirname(storePath)`）。 */
export function telemetryStorePath(env: Record<string, string | undefined>): string {
  return path.join(path.dirname(readStorePath(env)), "telemetry.sqlite");
}

/**
 * 核心层插件：提供 `ctx.telemetry`，并把同源 intake 与复盘查询路由登记到 gateway。
 *
 * 不登记就绪检查（不进 `READINESS_ORDER`）：本地存储打不开时业务仍必须可用，遥测能力改为在
 * `status.localStore = "unavailable"` 里说明原因（design D11）。
 */
export const telemetryPlugin: HostPlugin<{ env: Record<string, string | undefined> }> = {
  name: "telemetry",
  // `access` 必须在 inject 里：Cordis 访问未声明的服务会直接抛
  // `cannot get property "access" without inject`（这一条是 E2E 抓到的——单测里 fake ctx
  // 是普通对象，不会做这个检查）。鉴权在装配层，见下面的 `authorizeTelemetryRequest`。
  inject: ["log", "gateway", "access", "config"],
  apply(ctx, { env }) {
    const service: HostTelemetryService = createTelemetryService({
      path: telemetryStorePath(env),
      // 设置是唯一事实来源；`reload: "hot"` 的各项每次现读，关闭/保留期调整对使用方无感。
      // 缺省值兜底与 contracts 的 `SETTING_DEFINITIONS` 一致（没有设置服务时也能工作）。
      settings: {
        localEnabled: () => ctx.config.get("telemetry.local.enabled") !== false,
        retentionDays: () => ctx.config.get("telemetry.local.retentionDays") ?? 7,
        maxRows: () => ctx.config.get("telemetry.local.maxRows") ?? 200_000,
        // core 只回答"发不发"；目的地与凭据由出口插件自己的配置段负责。
        exportEnabled: () => ctx.config.get("telemetry.export.enabled") === true
      },
      logger: ctx.log.scope("telemetry")
    });
    // 关闭时由服务自己 best-effort flush 一次队列，再释放 SQLite 与 sweep 定时器。
    ctx.effect(() => () => service.close());
    ctx.provide("telemetry", service);
    // 鉴权在**装配层**完成，不在服务包里：服务包只拿得到 `HostTelemetryService`，拿不到 access
    // runtime，在那里再造一份判定会变成第二份事实来源（见 `telemetry-service/src/api/telemetry-api.ts`
    // 头部注释）。三步照 `task-inspection-api.ts`：本地单实例跳过 → 取 principal（null 即 401）→
    // 要求 `telemetry.inspect`（403）。**清空本地记录的 `DELETE` 也走同一判定**。
    ctx.effect(() =>
      ctx.gateway.route(ROUTE_ORDER.telemetry, async (req, res) => {
        // 只对遥测路径负责：其它请求必须立刻交下游，否则会替整条 /api 链做鉴权。
        if (!isTelemetryPath(req.url)) return false;
        const blocked = await authorizeTelemetryRequest(ctx, req, res);
        if (blocked) return true;
        return handleTelemetryRequest(service, req, res);
      })
    );
  }
};

const TELEMETRY_PATH_PREFIX = "/api/telemetry";

function isTelemetryPath(url: string | undefined): boolean {
  const pathname = new URL(url ?? "/", "http://localhost").pathname;
  return pathname === TELEMETRY_PATH_PREFIX || pathname.startsWith(`${TELEMETRY_PATH_PREFIX}/`);
}

/**
 * 三步鉴权；返回 `true` 表示已经写了响应、请求到此为止。
 *
 * `accessRuntime.enabled === false`（本机单实例/开发形态）跳过：那里没有身份表也没有"管理员"
 * 概念，拦它只会让本机复盘页永远 401，而同一台机器上的画布操作都是放行的。
 */
async function authorizeTelemetryRequest(
  ctx: HostContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  if (ctx.access.runtime.enabled === false) return false;
  const principal = await ctx.access.authenticator(req, "http");
  if (!principal) {
    sendJson(res, 401, { error: "unauthorized" });
    return true;
  }
  try {
    await ctx.access.accessEnforcer.assertAction(principal, TELEMETRY_INSPECT_ACTION);
    return false;
  } catch (error) {
    const status = statusForAccessError(error) ?? 403;
    sendJson(res, status, { error: "forbidden" });
    return true;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
