/**
 * 设置页「刷新可用模型」的路由（`POST /api/providers/runninghub/refresh`）。
 *
 * 与 `@woohaa3/provider-sdk` 的 `registerModelRefreshRoute` 同一套语义（站点管理员鉴权、
 * 成功回 `{ modelCount, message }`、失败 502、未授权 401）。这里没有直接复用 SDK，是因为
 * 本扩展不依赖 `provider-sdk`（它只为出网守卫/刷新路由服务，与本扩展无其它交集），
 * 为一条路由引入新依赖不划算。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MODELS_MANAGE_ACTION,
  type AccessAction,
  type HostExtensionContext,
  type PrincipalContext
} from "@woohaa3/contracts";

export type ModelRefreshResult =
  | { ok: true; modelCount: number; message?: string }
  | { ok: false; message: string };

type RefreshRuntime = {
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

/** 注册顺序与其它 Provider 保持一致，避免同一路径被别的中间件抢先。 */
const ROUTE_ORDER = 25;

export function registerRunningHubRefreshRoute(
  ctx: HostExtensionContext,
  options: { path: string; refresh: () => Promise<ModelRefreshResult> }
): void {
  const runtime = ctx as HostExtensionContext & RefreshRuntime;
  ctx.effect(() =>
    runtime.gateway.route(ROUTE_ORDER, async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://local").pathname;
      if (req.method !== "POST" || pathname !== options.path) return false;
      if (!(await authorize(req, runtime.access))) {
        writeJson(res, 401, { message: "需要站点管理员授权" });
        return true;
      }
      const result = await options.refresh();
      writeJson(
        res,
        result.ok ? 200 : 502,
        result.ok
          ? { modelCount: result.modelCount, ...(result.message ? { message: result.message } : {}) }
          : { message: result.message }
      );
      return true;
    })
  );
}

async function authorize(req: IncomingMessage, access: RefreshRuntime["access"]): Promise<boolean> {
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
