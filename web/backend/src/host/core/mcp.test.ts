import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRuntimeGeneratedImages } from "@woohaa3/application-service";
vi.mock("@woohaa3/application-service", () => ({ readRuntimeGeneratedImages: vi.fn() }));
import { withCanvasGroupScope } from "@woohaa3/canvas-service";
import type { HostContext } from "../context.js";

const { createMcpService } = vi.hoisted(() => ({ createMcpService: vi.fn() }));
vi.mock("@woohaa3/mcp-service", () => ({ createMcpService }));

import { mcpPlugin } from "./mcp.js";

type CapturedOptions = {
  agentClient: {
    getGraph(input: { canvasId?: string }): Promise<unknown>;
    importGeneratedImage(input: { canvasId?: string; requestId: string; index?: number }): Promise<{ ok: boolean }>;
  };
};

/**
 * 启动 mcpPlugin：捕获网关 MCP 路由、注入的 grant registry 与 createMcpService 选项；
 * 由测试决定 mock 的 `handle` 在「网关请求作用域内」执行什么（从而验证 principal 绑定）。
 */
function boot(
  handleImpl: () => unknown,
  overrides: { get?: (key: string) => unknown; canvas?: unknown } = {}
) {
  createMcpService.mockImplementation((_options: CapturedOptions) => ({
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
    get: overrides.get ?? (() => undefined),
    effect: (register: () => unknown) => { register(); },
    provide: (key: string, value: unknown) => { provides.set(key, value); },
    canvas: overrides.canvas ?? { mcpServices: () => ({ modelMcp: null, agent: { readGraph } }) },
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

describe("Codex generated image import uses the trusted 2D group scope", () => {
  it("appends the image node to workflow-group-2d memberNodeIds in one batch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "mcp-codex-import-"));
    try {
      const codexHome = path.join(root, "codex");
      const dir = path.join(codexHome, "generated_images", "session");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "a.png");
      writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      vi.mocked(readRuntimeGeneratedImages).mockResolvedValue({ paths: [file], codexHome });

      const canvas = {
        id: "c",
        revision: 7,
        document: { nodes: [{ id: "g1", type: "workflow-group-2d" }] },
        nodeData: {
          g1: {
            title: "组",
            workflowGroup2d: {
              kind: "workflow-group-2d",
              version: "shared-world-v1",
              groupId: "g1",
              scopeVersion: "scope-v0",
              memberNodeIds: []
            }
          }
        }
      };
      const commands: Array<{ type: string; nodeId?: string; node?: { id: string }; value?: { workflowGroup2d?: { memberNodeIds?: string[] } } }> = [];
      const apply = vi.fn(async (input: { commands: typeof commands }) => {
        commands.push(...input.commands);
        return { ok: true as const, revision: 8 };
      });
      const { options } = boot(() => undefined, {
        get: key => key === "media"
          ? { port: () => ({ importBytes: async () => ({ storageKey: "sha256-abc", contentType: "image/png", size: 8, checksum: "abc" }) }) }
          : undefined,
        canvas: {
          mcpServices: () => ({ modelMcp: null, agent: { readGraph: vi.fn(), apply } }),
          sync: { registry: { resolve: async () => ({ exportCanvas: () => ({ ok: true, canvas }) }) } }
        }
      });

      const result = await withCanvasGroupScope({
        canvasId: "c",
        rootGroupId: "g1",
        scopeEpoch: 0,
        owner: "dev-admin",
        valid: () => true,
        authorize: async () => true
      }, () => options.agentClient.importGeneratedImage({ requestId: "req-import", index: 0 }));

      expect(result.ok).toBe(true);
      expect(readRuntimeGeneratedImages).toHaveBeenCalledWith(expect.any(Object), "dev-admin", "req-import");
      const added = commands.find(command => command.type === "node.add");
      const patched = commands.find(command => command.type === "nodeData.patch");
      expect(added?.node?.id).toBeTruthy();
      expect(patched?.nodeId).toBe("g1");
      expect(patched?.value?.workflowGroup2d?.memberNodeIds).toEqual([added?.node?.id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
