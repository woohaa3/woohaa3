/**
 * RunningHub 余额读取路由（`GET /api/providers/runninghub/balance`）。
 *
 * 与模型刷新路由同一套站点管理员鉴权；本地单实例仍由实例主体通过。宿主不缓存结果，
 * 由列表行按需读取。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MODELS_MANAGE_ACTION,
  type AccessAction,
  type HostExtensionContext,
  type PrincipalContext
} from "@woohaa3/contracts";
import { RUNNINGHUB_BALANCE_PATH, type RunningHubBalanceResult } from "../balance.js";

type BalanceRuntime = {
  gateway: {
    route(
      order: number,
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
    ): () => void;
  };
  access: {
    authenticator?: (req: IncomingMessage, transport?: "http" | "ws" | "mcp") => Promise<PrincipalContext | null>;
    accessEnforcer?: { assertAction(principal: PrincipalContext | null, action: AccessAction): Promise<void> };
  };
};

/** 与模型刷新路由保持同一注册顺序。 */
const ROUTE_ORDER = 25;

export function registerRunningHubBalanceRoute(
  ctx: HostExtensionContext,
  options: { read: () => Promise<RunningHubBalanceResult> }
): void {
  const runtime = ctx as HostExtensionContext & BalanceRuntime;
  ctx.effect(() =>
    runtime.gateway.route(ROUTE_ORDER, async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://local").pathname;
      if (req.method !== "GET" || pathname !== RUNNINGHUB_BALANCE_PATH) return false;
      if (!(await authorize(req, runtime.access))) {
        writeJson(res, 401, { message: "需要站点管理员授权" });
        return true;
      }
      const result = await options.read();
      const status = result.ok
        ? 200
        : result.code === "runninghub-credentials-missing" || result.code === "runninghub-credentials-invalid"
          ? 400
          : 502;
      writeJson(res, status, result);
      return true;
    })
  );
}

async function authorize(req: IncomingMessage, access: BalanceRuntime["access"]): Promise<boolean> {
  try {
    const principal = access.authenticator ? await access.authenticator(req, "http") : null;
    if (!principal || !access.accessEnforcer) return false;
    await access.accessEnforcer.assertAction(principal, MODELS_MANAGE_ACTION);
    return true;
  } catch {
    return false;
  }
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
