/**
 * 设置页「可用模型」的刷新路由。
 *
 * Provider 插件本来各自写同一段代码：在 `apply` 里注册一条 POST 路由、用站点管理员鉴权
 * （`MODELS_MANAGE_ACTION`）、把 `refresh()` 的结果按 `{ modelCount }` / `{ message }` 回写。
 * 5 个 provider 的 `authorizeRefresh` 曾经**逐字节相同**，收敛到这里。
 *
 * 路由路径由插件自己声明（也用于 `HostExtensionPlugin.modelRefresh` 的设置面展示），
 * 宿主只负责按声明渲染，不硬编码任何 Provider。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MODELS_MANAGE_ACTION,
  type AccessAction,
  type HostExtensionContext,
  type PrincipalContext
} from "@woohaa3/contracts";

/** 刷新结果：成功带模型数量（可选提示），失败带面向管理员的原因。 */
export type ModelRefreshResult =
  | { ok: true; modelCount: number; message?: string }
  | { ok: false; message: string };

/** 注册顺序：与既有各 Provider 保持一致，避免同一路径被别的中间件抢先。 */
export const DEFAULT_MODEL_REFRESH_ROUTE_ORDER = 25;

type ModelRefreshRuntime = {
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

export type RegisterModelRefreshRouteOptions = {
  /** 插件自己注册的刷新路径（同时也是 `modelRefresh.path`）。 */
  path: string;
  refresh: () => Promise<ModelRefreshResult>;
  /** 网关路由顺序；缺省 {@link DEFAULT_MODEL_REFRESH_ROUTE_ORDER}。 */
  order?: number;
};

/**
 * 注册模型目录刷新路由（`POST <path>`，需要站点管理员授权）。
 *
 * 只处理该路径的 POST；其它请求返回 `false` 交下游。鉴权失败统一 401，刷新失败统一 502。
 */
export function registerModelRefreshRoute(
  ctx: HostExtensionContext,
  options: RegisterModelRefreshRouteOptions
): void {
  // gateway / access 不在 HostExtensionContext 的公开形状里（它们属于宿主内核层），
  // Provider 插件一直靠局部断言取用；这份断言从 5 个扩展的 `apply` 里收敛到这里。
  const runtime = ctx as HostExtensionContext & ModelRefreshRuntime;
  ctx.effect(() =>
    runtime.gateway.route(options.order ?? DEFAULT_MODEL_REFRESH_ROUTE_ORDER, async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://local").pathname;
      if (req.method !== "POST" || pathname !== options.path) return false;
      if (!(await authorizeRefresh(req, runtime.access))) {
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

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function authorizeRefresh(req: IncomingMessage, access: ModelRefreshRuntime["access"]): Promise<boolean> {
  try {
    const principal = access.authenticator ? await access.authenticator(req, "http") : null;
    if (!principal || !access.accessEnforcer) return false;
    await access.accessEnforcer.assertAction(principal, MODELS_MANAGE_ACTION);
    return true;
  } catch {
    return false;
  }
}
