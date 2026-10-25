/**
 * 同源 ingress 路由测试（change: split-web-runtime-services，任务 6.3 / 6.4）。
 *
 * 用真实 HTTP 服务器验证：路径路由、Range/认证头转发、WebSocket upgrade、
 * 内部协议不对公网暴露、旧任务写入口下线。
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module without type declarations (shared with serve-web.mjs).
import { createIngress, routeFor } from "../../scripts/lib/ingress.mjs";

describe("ingress 路由表（任务 6.3）", () => {
  it("按路径映射到对应单元", () => {
    expect(routeFor("/api/canvases")).toBe("canvas");
    expect(routeFor("/api/canvases/x/commands")).toBe("canvas");
    expect(routeFor("/api/canvases/x/sync")).toBe("canvas");
    // 外部来源目录与旧 ID prepare/status（change: 2026-10-12-add-extension-online-canvas-migration）。
    expect(routeFor("/api/canvas-sources")).toBe("canvas");
    expect(routeFor("/api/canvas-sources/external-source/canvases")).toBe("canvas");
    expect(routeFor("/api/canvases/legacy-1/prepare")).toBe("canvas");
    expect(routeFor("/api/canvases/legacy-1/preparation")).toBe("canvas");
    expect(routeFor("/api/canvas-storage/health/ready")).toBe("canvas");
    expect(routeFor("/api/model-mcp/requests")).toBe("canvas");
    expect(routeFor("/api/model-mcp/scripts")).toBe("canvas");
    // 提示词片段目录由 Canvas Service 承载（change: add-prompt-snippet-library）。
    expect(routeFor("/api/prompt-snippets")).toBe("canvas");
    expect(routeFor("/api/prompt-snippets/tags")).toBe("canvas");
    // MCP 传输由独立 mcp-service 承载（change: split-model-mcp-into-mcp-service）。
    expect(routeFor("/mcp/model-canvas")).toBe("mcp");
    expect(routeFor("/mcp/model-canvas/")).toBe("mcp");
    expect(routeFor("/api/media")).toBe("media");
    expect(routeFor("/api/media-projects")).toBe("media");
    expect(routeFor("/api/media-projects-other")).toBe("none");
    expect(routeFor("/api/media/sha256-abc")).toBe("media");
    expect(routeFor("/api/pptask/catalog")).toBe("task");
    expect(routeFor("/api/pptask/history")).toBe("task");
    expect(routeFor("/api/pptask/history/events")).toBe("task");
    // 站点插件控制面与 Application 健康（change: 2026-10-05-extract-application-plugin-host）。
    expect(routeFor("/api/extensions")).toBe("application");
    expect(routeFor("/api/extensions/changes")).toBe("application");
    expect(routeFor("/api/extensions/sample/config")).toBe("application");
    expect(routeFor("/api/application/health/live")).toBe("application");
    // 本地设置（含 Provider 密钥）。
    expect(routeFor("/api/settings")).toBe("application");
    // Provider 模型刷新按**模式**路由（`/api/providers/<providerId>/refresh`）：新增 Provider 不改路由表。
    expect(routeFor("/api/providers/litellm/refresh")).toBe("application");
    expect(routeFor("/api/providers/fal/refresh")).toBe("application");
    expect(routeFor("/api/providers/whatever-provider/refresh")).toBe("application");
    expect(routeFor("/api/providers/litellm/refresh/extra")).toBe("none");
    expect(routeFor("/api/providers/litellm/models")).toBe("none");
    // 宿主 Agent 会话/回合与内置 MCP 发现（change: 2026-10-12-add-agent-conversation-panel）。
    expect(routeFor("/api/agent-conversations")).toBe("application");
    expect(routeFor("/api/agent-conversations/catalog")).toBe("application");
    // 全局任务监控由宿主提供，不依赖 task-monitor 扩展。
    expect(routeFor("/api/task-inspection/snapshot")).toBe("application");
    expect(routeFor("/api/task-inspection/detail")).toBe("application");
    // 本机遥测由宿主 core 承载（change: 2026-10-20-add-local-client-telemetry）：
    // 不登记这处，新 `/api/...` 会被判 none 直接 404，永远到不了宿主。
    expect(routeFor("/api/telemetry/events")).toBe("application");
    expect(routeFor("/api/telemetry/summary")).toBe("application");
    expect(routeFor("/api/telemetry/anomalies")).toBe("application");
    expect(routeFor("/api/telemetry-anomalies")).toBe("none");
    expect(routeFor("/api/agent-conversations/mcp")).toBe("application");
    expect(routeFor("/api/agent-conversations/conversations/c1/turns")).toBe("application");
  });

  it("内部协议不被路由到服务（旧任务写入口按未知路由处理）", () => {
    expect(routeFor("/internal/v1/media/sign")).toBe("internal");
    expect(routeFor("/internal/v1/tasks/k")).toBe("internal");
    // 站点插件内部 work 接口同样属于 internal 前缀，不经公网。
    expect(routeFor("/internal/v1/extensions/sample/work")).toBe("internal");
    // 旧任务写入口没有专用分支：与任意未知路径一样是 none。
    expect(routeFor("/api/pptask/tasks")).toBe("none");
    expect(routeFor("/api/unknown")).toBe("none");
  });
});

type Target = { server: http.Server; port: number; requests: Array<{ url: string; range?: string; token?: string; actor?: string }> };

function startTarget(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Target> {
  return new Promise((resolve) => {
    const requests: Target["requests"] = [];
    const server = http.createServer((req, res) => {
      requests.push({
        url: req.url ?? "",
        range: req.headers.range as string,
        token: req.headers["x-woohaa3-service-token"] as string,
        actor: req.headers["x-woohaa3-admin-actor"] as string
      });
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, requests });
    });
  });
}

describe("ingress HTTP 代理（任务 6.3）", () => {
  let canvas: Target;
  let task: Target;
  let media: Target;
  let mcp: Target;
  let application: Target;
  let ingressServer: http.Server;
  let base: string;
  let ingress: ReturnType<typeof createIngress>;

  beforeAll(async () => {
    canvas = await startTarget((req, res) => {
      res.writeHead(req.url?.includes("sync") ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "canvas", url: req.url }));
    });
    task = await startTarget((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "task" }));
    });
    media = await startTarget((_req, res) => {
      res.writeHead(206, { "content-type": "image/png", "content-range": "bytes 0-1/2" });
      res.end("ab");
    });
    mcp = await startTarget((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "mcp" }));
    });
    application = await startTarget((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "application", forwardedHost: req.headers["x-forwarded-host"] }));
    });
    ingress = createIngress({
      targets: {
        canvas: `http://127.0.0.1:${canvas.port}`,
        task: `http://127.0.0.1:${task.port}`,
        media: `http://127.0.0.1:${media.port}`,
        mcp: `http://127.0.0.1:${mcp.port}`,
        application: `http://127.0.0.1:${application.port}`
      }
    });
    ingressServer = http.createServer((req, res) => {
      void ingress.handle(req, res).then((handled: boolean) => {
        if (!handled) {
          res.writeHead(404);
          res.end("not-found");
        }
      });
    });
    await new Promise<void>((resolve) => ingressServer.listen(0, "127.0.0.1", resolve));
    const address = ingressServer.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await Promise.all([close(canvas), close(task), close(media), close(mcp), close(application), close({ server: ingressServer })]);
  });

  it("把 /api/media 与 Range 转发到 Media Service 并保留响应头", async () => {
    const response = await fetch(`${base}/api/media/sha256-abc`, { headers: { range: "bytes=0-1" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-1/2");
    expect(media.requests.at(-1)?.range).toBe("bytes=0-1");
  });

  it("工程上传转发到 Media 专用核验入口", async () => {
    const response = await fetch(`${base}/api/media-projects`, {
      method: "POST", headers: { "content-type": "application/vnd.fixture-project" }, body: "project-bytes"
    });
    expect(response.status).toBe(206);
    expect(media.requests.at(-1)?.url).toBe("/api/media-projects");
  });

  it("转发浏览器入口 Host，覆盖客户端伪造的 forwarded Host", async () => {
    const response = await fetch(`${base}/api/extensions`, { headers: { "x-forwarded-host": "evil.example" } });
    expect((await response.json()).forwardedHost).toBe(new URL(base).host);
  });

  it("把 /mcp/* 转发到 MCP Service", async () => {
    const response = await fetch(`${base}/mcp/model-canvas`, { method: "POST" });
    expect(((await response.json()) as { service: string }).service).toBe("mcp");
    expect(mcp.requests.at(-1)?.url).toBe("/mcp/model-canvas");
  });

  it("把 /api/pptask/catalog 转发到 Task Service", async () => {
    const response = await fetch(`${base}/api/pptask/catalog`);
    expect(((await response.json()) as { service: string }).service).toBe("task");
  });

  it("把站点插件控制面 /api/extensions 转发到 Application Service 并剥离客户端伪造的内部头", async () => {
    const response = await fetch(`${base}/api/extensions/sample/config`, {
      method: "PUT",
      headers: { "x-woohaa3-service-token": "tok", "x-woohaa3-admin-actor": "admin@example" }
    });
    expect(((await response.json()) as { service: string }).service).toBe("application");
    expect(application.requests.at(-1)?.url).toBe("/api/extensions/sample/config");
    // 公网入口剥离客户端自报的服务令牌与管理 actor：loopback 不授权（design D7）。
    expect(application.requests.at(-1)?.token).toBeUndefined();
    expect(application.requests.at(-1)?.actor).toBeUndefined();
  });

  it("把 /api/application/health 转发到 Application Service", async () => {
    const response = await fetch(`${base}/api/application/health/live`);
    expect(((await response.json()) as { service: string }).service).toBe("application");
  });

  it("内部插件 work 接口 /internal/v1/extensions 不经公网 ingress", async () => {
    const response = await fetch(`${base}/internal/v1/extensions/sample/work`, { method: "POST" });
    expect(response.status).toBe(404);
    expect(application.requests.some((entry) => entry.url.includes("/internal/"))).toBe(false);
  });

  it("把 /api/canvases 转发到 Canvas Service 并剥离客户端内部令牌", async () => {
    const response = await fetch(`${base}/api/canvases/abc`, {
      headers: { "x-woohaa3-service-token": "tok" }
    });
    expect(((await response.json()) as { service: string }).service).toBe("canvas");
    expect(canvas.requests.at(-1)?.token).toBeUndefined();
  });

  it("内部协议 /internal/v1 不经公网 ingress", async () => {
    const response = await fetch(`${base}/internal/v1/media/sign`, { method: "POST" });
    expect(response.status).toBe(404);
    expect(media.requests.some((entry) => entry.url.includes("/internal/"))).toBe(false);
  });

  it("旧任务写入口按未知路由处理，不返回迁移提示", async () => {
    const response = await fetch(`${base}/api/pptask/tasks`, { method: "POST" });
    // ingress 不特殊处理：交给上层静态/404 处理，且不转发到任何服务。
    expect([404, 405]).toContain(response.status);
    expect(task.requests.some((entry) => entry.url.includes("/tasks"))).toBe(false);
  });

  it("目标缺失时返回可诊断 503", async () => {
    const bare = createIngress({ targets: {} });
    const server = http.createServer((req, res) => {
      void bare.handle(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/media`);
    expect(response.status).toBe(503);
    await close({ server });
  });

  it("流式响应（SSE/NDJSON）与 cache 头原样转发", async () => {
    const streamTarget = await startTarget((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
      res.write(`${JSON.stringify({ record: { taskKey: "t1" }, cursor: 1 })}\n`);
      res.write(`${JSON.stringify({ record: { taskKey: "t1" }, cursor: 2 })}\n`);
      res.end();
    });
    const bare = createIngress({ targets: { task: `http://127.0.0.1:${streamTarget.port}` } });
    const front = http.createServer((req, res) => {
      void bare.handle(req, res);
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    const address = front.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/api/pptask/history/events?after=0`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("ndjson");
    const body = await response.text();
    expect(body.split("\n").filter(Boolean)).toHaveLength(2);

    await close(streamTarget);
    front.close();
  });

  it("把画布同步的 WebSocket upgrade 转发到 Canvas Service（不解析 Yjs）", async () => {
    // 目标：一个接受 upgrade 并回 101 的最小 WS 服务；只验证握手转发与字节管道。
    const upgradeTarget = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    upgradeTarget.on("upgrade", (_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
          + "Sec-WebSocket-Accept: dummy\r\n\r\n"
      );
    });
    await new Promise<void>((resolve) => upgradeTarget.listen(0, "127.0.0.1", resolve));
    const targetAddress = upgradeTarget.address();
    const targetPort = typeof targetAddress === "object" && targetAddress ? targetAddress.port : 0;

    const bare = createIngress({ targets: { canvas: `http://127.0.0.1:${targetPort}` } });
    const front = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    front.on("upgrade", (req, socket, head) => {
      if (!bare.upgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    const address = front.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const result = await rawUpgrade(port, "/api/canvases/x/sync");
    expect(result).toContain("101 Switching Protocols");

    upgradeTarget.close();
    front.close();
  }, 15_000);
});

function close(target: { server: http.Server }): Promise<void> {
  return new Promise((resolve) => target.server.close(() => resolve()));
}


/** 发起一次原始 WebSocket 握手，返回收到的首段字节（binary 字符串）。 */
async function rawUpgrade(port: number, path: string): Promise<string> {
  const { connect } = await import("node:net");
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
          + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(""), 1_500);
    socket.on("data", (chunk) => {
      clearTimeout(timer);
      finish(chunk.toString("binary"));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}
