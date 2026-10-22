/**
 * Canvas 列表 ACL 过滤测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 5.5 修正）。
 *
 * 回归的缺陷：旧实现「先取一页全局画布，再逐条丢弃」——可读画布散落在后续页时永远不可见，
 * `total` 也只反映当前页。修正为「先按可信主体的可发现 ID 全集在分页前过滤」。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { createCanvasRequestHandler } from "./canvas-api.js";
import { InMemoryCanvasRepository } from "../storage/core/in-memory-repository.js";
import { CanvasApplicationService } from "../storage/core/application-service.js";
import { CanvasCatalogService } from "../storage/core/catalog-service.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { createPublishedReader } from "../sync/published-reader.js";
import type { CanvasAccessPort } from "../access/access-port.js";
import type { CanvasRequestAuthenticator } from "../access/resolve-access.js";
import type { PrincipalContext } from "@woohaa3/contracts";

const servers: Array<ReturnType<typeof createServer>> = [];
afterAll(() => { for (const server of servers) server.close(); });

/** 25 张画布，`updatedAt` 递减：全库第 21~25 张（下标 20~24）落在默认页之外。 */
async function seed(): Promise<InMemoryCanvasRepository> {
  const repository = new InMemoryCanvasRepository();
  for (let index = 0; index < 25; index += 1) {
    const at = new Date(Date.UTC(2026, 9, 14, 12, 0, 0) - index * 60_000).toISOString();
    await repository.createCanvas(createEmptyWoohaa3ServerCanvas(`canvas-${String(index).padStart(2, "0")}`, at));
  }
  return repository;
}

type Overrides = {
  authenticate?: CanvasRequestAuthenticator;
  discoverableCanvasIds?: (principal: PrincipalContext) => Promise<string[] | null>;
  access?: CanvasAccessPort;
};

async function start(overrides: Overrides = {}): Promise<string> {
  const repository = await seed();
  const yjs = new InMemoryYjsDocumentRepository();
  const service = new CanvasApplicationService({ repository });
  const catalog = new CanvasCatalogService({ repository, published: createPublishedReader(yjs) });
  const handler = createCanvasRequestHandler({
    service,
    catalog,
    logger: () => undefined,
    ...(overrides.authenticate ? { authenticate: overrides.authenticate } : {}),
    ...(overrides.discoverableCanvasIds ? { discoverableCanvasIds: overrides.discoverableCanvasIds } : {}),
    ...(overrides.access ? { access: overrides.access } : {})
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

const authenticateAsSubject: CanvasRequestAuthenticator = async (req) => {
  const header = req.headers["x-subject"];
  const subject = Array.isArray(header) ? header[0] : header;
  return subject ? { subject, identityProvider: "test" } : null;
};

describe("Canvas 列表：分页前按 ACL 过滤（任务 5.5）", () => {
  it("可读画布散落在默认页之外时仍全部可见，total 为可读总数", async () => {
    // 可发现集合 = 前 2 张 + 最后 4 张（最后 4 张在全局排序中位于第 22~25 位）。
    const readable = ["canvas-00", "canvas-01", "canvas-21", "canvas-22", "canvas-23", "canvas-24"];
    const base = await start({
      authenticate: authenticateAsSubject,
      discoverableCanvasIds: async () => readable
    });

    const response = await fetch(`${base}/api/canvases?offset=0&limit=20`, { headers: { "x-subject": "alice" } });
    expect(response.status).toBe(200);
    const page = await response.json() as { items: Array<{ id: string }>; total: number; offset: number; limit: number };
    expect(page.total).toBe(6);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(20);
    expect(page.items.map((item) => item.id)).toEqual(["canvas-00", "canvas-01", "canvas-21", "canvas-22", "canvas-23", "canvas-24"]);
  });

  it("翻页覆盖全部可发现画布（offset 落在可发现集合上，而非全局页）", async () => {
    const readable = ["canvas-00", "canvas-01", "canvas-21", "canvas-22", "canvas-23", "canvas-24"];
    const base = await start({
      authenticate: authenticateAsSubject,
      discoverableCanvasIds: async () => readable
    });

    const first = await (await fetch(`${base}/api/canvases?offset=0&limit=3`, { headers: { "x-subject": "alice" } })).json() as { items: Array<{ id: string }>; total: number };
    const second = await (await fetch(`${base}/api/canvases?offset=3&limit=3`, { headers: { "x-subject": "alice" } })).json() as { items: Array<{ id: string }>; total: number };
    expect(first.total).toBe(6);
    expect(second.total).toBe(6);
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(readable);
  });

  it("可发现集合为空时不列出全库（fail closed）", async () => {
    const base = await start({
      authenticate: authenticateAsSubject,
      discoverableCanvasIds: async () => []
    });
    const page = await (await fetch(`${base}/api/canvases?offset=0&limit=20`, { headers: { "x-subject": "alice" } })).json() as { items: unknown[]; total: number };
    expect(page).toMatchObject({ items: [], total: 0 });
  });

  it("可发现集合提供者故障时返回 503（不回退列出全库）", async () => {
    const base = await start({
      authenticate: authenticateAsSubject,
      discoverableCanvasIds: async () => { throw new Error("directory down"); }
    });
    const response = await fetch(`${base}/api/canvases?offset=0&limit=20`, { headers: { "x-subject": "alice" } });
    expect(response.status).toBe(503);
  });

  it("未注入可发现集合时回退逐项判定，仍不列出他人画布", async () => {
    const base = await start({
      authenticate: authenticateAsSubject,
      access: {
        async authorize({ canvasId }) {
          return canvasId === "canvas-03"
            ? { allowed: true }
            : { allowed: false, code: "forbidden", message: "无权访问" };
        }
      }
    });
    const response = await fetch(`${base}/api/canvases?offset=0&limit=20`, { headers: { "x-subject": "alice" } });
    const page = await response.json() as { items: Array<{ id: string }>; total: number; offset: number; limit: number };
    expect(page.items.map((item) => item.id)).toEqual(["canvas-03"]);
    expect(page.total).toBe(1);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(20);
  });

  it("注入authenticate 但未认证时返回 401", async () => {
    const base = await start({ authenticate: authenticateAsSubject, discoverableCanvasIds: async () => [] });
    expect((await fetch(`${base}/api/canvases`)).status).toBe(401);
  });

  it("未注入 authenticate 时保持历史行为（列出全部）", async () => {
    const base = await start();
    const page = await (await fetch(`${base}/api/canvases?offset=0&limit=5`)).json() as { items: unknown[]; total: number };
    expect(page.total).toBe(25);
    expect(page.items).toHaveLength(5);
  });
});
