/**
 * 越权 fixture（change: 2026-10-21-isolate-extension-host-process，任务 10.1）。
 *
 * 声明 `network: ["api.example.com"]`、`storageNamespaces: ["greedy-cache"]`、`publicRoutes: false`，
 * 以及本期不授予的 `canvas` / `mcpTools`。激活时逐项尝试越权，并把每项结果记进 `probes`：
 *
 * | 探针 | 期望 |
 * | --- | --- |
 * | `fetch-denied`：fetch https://evil.example.net/ | `EXTENSION_NETWORK_DENIED` |
 * | `fetch-private`：fetch http://127.0.0.1:1/ | `EXTENSION_NETWORK_DENIED` |
 * | `net-denied`：net.connect 169.254.169.254:80 | `EXTENSION_NETWORK_DENIED` |
 * | `spawn`：child_process.spawn | `permission-denied` |
 * | `route-outside`：注册 /api/settings/greedy | `permission-denied` |
 * | `storage-other`：ctx.storage.bucket("media") | `permission-denied` |
 * | `storage-own`：ctx.storage.bucket("greedy-cache") | 成功 |
 * | `canvas`：ctx.get("canvas") | `undefined` |
 * | `marketplace`：ctx.marketplace | 不存在 |
 * | `env`：process.env 里的 WOOHAA3_* 键 | 空 |
 *
 * 越权失败不让激活失败：扩展仍注册自己的路由 `GET /api/extensions/fixture-greedy/probes` 返回探针结果，
 * 端到端据此逐项断言，并确认宿主不受影响。
 */
import { defineConfigSchema, type GenerationProvider, type ExtensionPlugin } from "@woohaa3/contracts";

const ID = "fixture-greedy";
const OWN_ROUTE = `/api/extensions/${ID}/probes`;

export const FIXTURE_GREEDY_CONFIG = defineConfigSchema({});

type Probe = { name: string; ok: boolean; code?: string; detail?: string };

async function probe(name: string, run: () => unknown | Promise<unknown>): Promise<Probe> {
  try {
    const value = await run();
    return { name, ok: true, detail: value === undefined ? "undefined" : typeof value === "object" && value !== null ? "object" : String(value) };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return { name, ok: false, ...(typeof code === "string" ? { code } : {}), detail: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

type GreedyCtx = {
  get?: (name: string) => unknown;
  storage?: { bucket(namespace: string): unknown };
  marketplace?: unknown;
  gateway?: { route(order: number, handler: (req: { method?: string; url?: string }, res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }) => boolean, options?: { prefix?: string }): () => void };
};

export async function runProbes(ctx: GreedyCtx): Promise<Probe[]> {
  const net = await import("node:net");
  const childProcess = await import("node:child_process");
  return [
    await probe("fetch-denied", () => fetch("https://evil.example.net/")),
    await probe("fetch-private", () => fetch("http://127.0.0.1:1/")),
    await probe("net-denied", () => {
      const socket = net.connect({ host: "169.254.169.254", port: 80 });
      socket.destroy();
      return "connected";
    }),
    await probe("spawn", () => childProcess.spawn("true")),
    await probe("route-outside", () => ctx.gateway?.route(920, () => false, { prefix: "/api/settings/greedy" })),
    await probe("storage-other", () => ctx.storage?.bucket("media")),
    await probe("storage-own", () => ctx.storage?.bucket("greedy-cache")),
    await probe("canvas", () => ctx.get?.("canvas")),
    await probe("marketplace", () => ctx.marketplace),
    await probe("env", () => Object.keys(process.env).filter((key) => key.startsWith("WOOHAA3_")).join(",") || "none")
  ];
}

export function createFixtureGreedyPlugin(): ExtensionPlugin<typeof FIXTURE_GREEDY_CONFIG.fields> {
  return {
    name: ID,
    label: "市场测试：越权",
    configPrefix: "providers.fixture-greedy",
    inject: ["log", "generation", "gateway"],
    Config: FIXTURE_GREEDY_CONFIG,
    async apply(ctx) {
      const greedy = ctx as unknown as GreedyCtx;
      const probes = await runProbes(greedy);
      ctx.effect(() => ctx.generation.register({ extensionId: ID, providerId: ID, available: false, models: [], provider: {} } as GenerationProvider));
      ctx.effect(() =>
        greedy.gateway!.route(920, (req, res) => {
          if (req.method !== "GET" || !(req.url ?? "").startsWith(OWN_ROUTE)) return false;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ pid: process.pid, probes }));
          return true;
        })
      );
      ctx.log.scope(ID)({ event: "fixture-greedy-probed", probes });
    }
  };
}
