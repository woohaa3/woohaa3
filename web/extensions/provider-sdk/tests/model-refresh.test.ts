import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_REFRESH_ROUTE_ORDER, registerModelRefreshRoute } from "../src/model-refresh.js";
import type { HostExtensionContext } from "@woohaa3/contracts";

type RouteHandler = (req: { method?: string; url?: string }, res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }) => Promise<boolean>;

function fakeContext(options: { authorized?: boolean } = {}) {
  const routes: Array<{ order: number; handler: RouteHandler }> = [];
  const effects: Array<() => void> = [];
  const ctx = {
    effect: (execute: () => () => void) => {
      effects.push(execute());
    },
    gateway: {
      route: (order: number, handler: RouteHandler) => {
        routes.push({ order, handler });
        return () => undefined;
      }
    },
    access: {
      authenticator: async () => ({ subject: "admin" }),
      accessEnforcer: {
        assertAction: async () => {
          if (options.authorized === false) throw new Error("forbidden");
        }
      }
    }
  } as unknown as HostExtensionContext;
  return { ctx, routes };
}

function fakeResponse() {
  const captured = { status: 0, body: "" };
  return {
    captured,
    res: {
      writeHead: (status: number) => {
        captured.status = status;
      },
      end: (body: string) => {
        captured.body = body;
      }
    }
  };
}

describe("模型刷新路由", () => {
  it("只处理声明路径的 POST，成功回 modelCount", async () => {
    const { ctx, routes } = fakeContext();
    registerModelRefreshRoute(ctx, { path: "/api/providers/demo/refresh", refresh: async () => ({ ok: true, modelCount: 3 }) });
    expect(routes).toHaveLength(1);
    expect(routes[0]?.order).toBe(DEFAULT_MODEL_REFRESH_ROUTE_ORDER);

    const { captured, res } = fakeResponse();
    expect(await routes[0]!.handler({ method: "POST", url: "/api/providers/demo/refresh" }, res)).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({ modelCount: 3 });

    // 其它路径 / 方法交给下游。
    expect(await routes[0]!.handler({ method: "POST", url: "/api/providers/demo/other" }, res)).toBe(false);
    expect(await routes[0]!.handler({ method: "GET", url: "/api/providers/demo/refresh" }, res)).toBe(false);
  });

  it("鉴权失败 401、刷新失败 502，都不回显内部错误细节", async () => {
    const denied = fakeContext({ authorized: false });
    registerModelRefreshRoute(denied.ctx, { path: "/api/providers/demo/refresh", refresh: async () => ({ ok: true, modelCount: 1 }) });
    const deniedRes = fakeResponse();
    expect(await denied.routes[0]!.handler({ method: "POST", url: "/api/providers/demo/refresh" }, deniedRes.res)).toBe(true);
    expect(deniedRes.captured.status).toBe(401);

    const failing = fakeContext();
    registerModelRefreshRoute(failing.ctx, {
      path: "/api/providers/demo/refresh",
      refresh: async () => ({ ok: false, message: "上游不可用" })
    });
    const failRes = fakeResponse();
    expect(await failing.routes[0]!.handler({ method: "POST", url: "/api/providers/demo/refresh" }, failRes.res)).toBe(true);
    expect(failRes.captured.status).toBe(502);
    expect(JSON.parse(failRes.captured.body)).toEqual({ message: "上游不可用" });
  });

  it("成功但带提示时一并回传 message", async () => {
    const { ctx, routes } = fakeContext();
    registerModelRefreshRoute(ctx, {
      path: "/api/providers/demo/refresh",
      refresh: async () => ({ ok: true, modelCount: 2, message: "部分模型下线" })
    });
    const { captured, res } = fakeResponse();
    await routes[0]!.handler({ method: "POST", url: "/api/providers/demo/refresh" }, res);
    expect(JSON.parse(captured.body)).toEqual({ modelCount: 2, message: "部分模型下线" });
  });
});
