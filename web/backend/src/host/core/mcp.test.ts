import { describe, expect, it, vi } from "vitest";
import type { HostContext } from "../context.js";

const { createMcpService } = vi.hoisted(() => ({ createMcpService: vi.fn() }));
vi.mock("@woohaa3/mcp-service", () => ({ createMcpService }));

import { mcpPlugin } from "./mcp.js";

type CapturedOptions = {
  agentClient: {
    getGraph(input: { canvasId?: string }): Promise<unknown>;
  };
};

/**
 * 启动 mcpPlugin：捕获网关 MCP 路由、注入的 grant registry 与 createMcpService 选项；
 * 由测试决定 mock 的 `handle` 在「网关请求作用域内」执行什么（从而验证 principal 绑定）。
 */
function boot(handleImpl: () => unknown) {
  createMcpService.mockImplementation((options: CapturedOptions) => ({
    handle: async () => handleImpl(),
    readiness: async () => ({ ready: true }),
    close: vi.fn(async () => undefined),
    canvasClient: null
  }));
  const routes: Array<(req: unknown, res: unknown) => unknown> = [];
  const provides = new Map<string, unknown>();
  const readGraph = vi.fn(async () => ({ ok: true, graph: { canvasId: "c", revision: 1, nodes: [], edges: [] } }));
  const ctx = {
    log: { scope: () => vi.fn() },
    get: () => undefined,
    effect: (register: () => unknown) => { register(); },
    provide: (key: string, value: unknown) => { provides.set(key, value); },
    canvas: { mcpServices: () => ({ modelMcp: null, agent: { readGraph } }) },
    gateway: {
      route: (_order: number, handler: (req: unknown, res: unknown) => unknown) => { routes.push(handler); },
      readiness: () => undefined
    }
  } as unknown as HostContext;
  mcpPlugin.apply(ctx, { env: {} });
  const options = createMcpService.mock.lastCall![0] as CapturedOptions;
  return { routes, provides, options, readGraph };
}

const request = (authorization?: string) => ({ headers: authorization ? { authorization } : {} });

describe("host MCP route binds the per-request trust principal", () => {
  it("attributes agent canvas reads to the verified grant subject, not the static fallback", async () => {
    const { routes, provides, options, readGraph } = boot(function readDuringRequest() {
      return options.agentClient.getGraph({ canvasId: "c" });
    });
    const grants = provides.get("toolGrants") as {
      issue(grant: Record<string, unknown>, subject?: string): void;
    };
    grants.issue({ token: "tok", canvasIds: [], nodeIds: [], tools: [], workId: "w" }, "user-a");

    await routes[0]!(request("Bearer tok"), {});

    expect(readGraph).toHaveBeenCalledWith(expect.objectContaining({ principalId: "user-a", canvasId: "c" }));
  });

  it("falls back to the local instance owner when the request carries no grant", async () => {
    const { routes, options, readGraph } = boot(function readDuringRequest() {
      return options.agentClient.getGraph({ canvasId: "c" });
    });

    await routes[0]!(request(), {});

    expect(readGraph).toHaveBeenCalledWith(expect.objectContaining({ principalId: "dev-admin", canvasId: "c" }));
  });
});
