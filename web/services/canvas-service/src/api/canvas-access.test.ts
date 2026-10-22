/**
 * Canvas native HTTP 资源策略接线测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 4.4/6.1/6.2）。
 *
 * 覆盖：注入 `authenticate`/`access` 后，native 画布 HTTP 路由（get/delete）在读取或写入前
 * 按可信 principal 判定；未认证 401、无权限 403、有权限通过。**未注入**时保持历史边界
 * （由 http-contract.test.ts 覆盖）。
 */
import http from "node:http";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import type { CanvasAccessPort } from "../access/access-port.js";
import type { CanvasRequestAuthenticator } from "../access/resolve-access.js";
import { createCanvasService } from "../composition.js";
import { InMemoryCanvasRepository } from "../storage/core/in-memory-repository.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";

const SUBJECT_HEADER = "x-test-subject";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** 只信 `x-test-subject` 的假认证器；缺失即未认证。 */
const authenticateFromHeader: CanvasRequestAuthenticator = async (req: IncomingMessage) => {
  const raw = req.headers[SUBJECT_HEADER];
  const subject = Array.isArray(raw) ? raw[0] : raw;
  if (typeof subject !== "string" || subject.trim() === "") return null;
  return { subject: subject.trim(), identityProvider: "test-identity" };
};

/** 只允许 `creator-1`；其余主体 403。 */
function creatorOnlyAccess(): CanvasAccessPort {
  return {
    async authorize({ principal, permission }) {
      if (principal.subject !== "creator-1") {
        return { allowed: false, code: "forbidden", message: "无权访问该画布" };
      }
      void permission;
      return { allowed: true };
    }
  };
}

async function start(input: { access?: CanvasAccessPort; authenticate?: CanvasRequestAuthenticator }): Promise<{ base: string }> {
  const repository = new InMemoryCanvasRepository();
  await repository.createCanvas(createEmptyWoohaa3ServerCanvas("canvas-1", "2026-10-16T00:00:00.000Z"));
  const service = await createCanvasService({
    repository,
    yjsRepository: new InMemoryYjsDocumentRepository(),
    enableYjsSync: false,
    // 结构化仓库/媒体都已注入：只补一份存储配置，避免测试依赖进程环境变量。
    storageConfig: { backend: "sqlite", sqlitePath: ":memory:", limits: {} },
    mediaClient: {
      async verify() {
        return { exists: true, matches: true };
      }
    },
    accessRuntime: Object.freeze({ enabled: true as const }),
    ...(input.authenticate ? { authenticate: input.authenticate } : {}),
    ...(input.access ? { access: input.access } : {})
  });
  const server = http.createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("未取得监听端口");
  closers.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  });
  return { base: `http://127.0.0.1:${address.port}` };
}

describe("native 画布 HTTP 资源策略（任务 4.4/6.1/6.2）", () => {
  it("GET 同一画布：无权限主体 403，有权限主体 200", async () => {
    const { base } = await start({ authenticate: authenticateFromHeader, access: creatorOnlyAccess() });

    const forbidden = await fetch(`${base}/api/canvases/canvas-1`, { headers: { [SUBJECT_HEADER]: "intruder" } });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ code: "FORBIDDEN" });

    const allowed = await fetch(`${base}/api/canvases/canvas-1`, { headers: { [SUBJECT_HEADER]: "creator-1" } });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({ canvas: { id: "canvas-1" } });
  });

  it("未认证主体访问 native 画布 → 401", async () => {
    const { base } = await start({ authenticate: authenticateFromHeader, access: creatorOnlyAccess() });
    const response = await fetch(`${base}/api/canvases/canvas-1`);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("DELETE native 画布按 delete 权限判定：无权限 403，有权限 204", async () => {
    const { base } = await start({ authenticate: authenticateFromHeader, access: creatorOnlyAccess() });

    const forbidden = await fetch(`${base}/api/canvases/canvas-1?expectedRevision=1`, {
      method: "DELETE",
      headers: { [SUBJECT_HEADER]: "intruder" }
    });
    expect(forbidden.status).toBe(403);

    const allowed = await fetch(`${base}/api/canvases/canvas-1?expectedRevision=1`, {
      method: "DELETE",
      headers: { [SUBJECT_HEADER]: "creator-1" }
    });
    expect(allowed.status).toBe(204);
  });

  it("未注入认证时保持历史边界（loopback 直接可读）", async () => {
    const { base } = await start({});
    const response = await fetch(`${base}/api/canvases/canvas-1`);
    expect(response.status).toBe(200);
  });
});
