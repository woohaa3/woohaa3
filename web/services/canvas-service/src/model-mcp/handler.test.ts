/**
 * 模型 MCP HTTP handler 测试（change: integrate-origin-master-after-web-split；
 *  change: replace-model-mcp-board-with-canvas-subscription —— 移除浏览器登记端点）。
 *
 * 覆盖 spec「Preserve ingress and MCP compatibility」：
 * - 旧客户端不带 canvasId 时使用配置的默认画布；
 * - 脚本提交走权威 service，非法输入返回稳定错误码；
 * - 已移除的登记端点不再由本 handler 认领。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpHandler, MODEL_MCP_BASE_PATH } from "./handler.js";
import type { SubmitScriptInput, SubmitScriptOutcome, ReportScriptOutcome } from "./service.js";

const DEFAULT_CANVAS = "woohaa3-default-canvas";

/** handler 只依赖 `submitScript`/`reportScript`，测试用最小结构替身即可。 */
type ScriptSubmitter = {
  submitScript: (input: SubmitScriptInput) => Promise<SubmitScriptOutcome>;
  reportScript?: (input: {
    canvasId: string;
    nodeId: string;
    status: "ok" | "failed";
    message?: string;
  }) => Promise<ReportScriptOutcome>;
};

function start(service?: ScriptSubmitter) {
  const handler = createModelMcpHandler({ service });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise<{ base: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("模型 MCP HTTP handler", () => {
  it("登记端点已移除：不再由本 handler 认领", async () => {
    const { base, close } = await start();
    closers.push(close);
    const registered = await fetch(`${base}${MODEL_MCP_BASE_PATH}/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "model-1", prompt: "一只猫", title: "模型" })
    });
    expect(registered.status).toBe(404);
    const listed = await fetch(`${base}${MODEL_MCP_BASE_PATH}/requests`);
    expect(listed.status).toBe(404);
  });

  it("脚本提交委托权威 service 并回传 commandId", async () => {
    const calls: SubmitScriptInput[] = [];
    const { base, close } = await start({
      async submitScript(input) {
        calls.push(input);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-x", idempotent: false };
      }
    });
    closers.push(close);
    const response = await fetch(`${base}${MODEL_MCP_BASE_PATH}/scripts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: DEFAULT_CANVAS, nodeId: "model-1", source: "func build(): pass", requestId: "request-1", expectedModelContentHash: "hash-1" })
    });
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({ canvasId: DEFAULT_CANVAS, requestId: "request-1", expectedModelContentHash: "hash-1" });
    const body = (await response.json()) as { script: { commandId: string } };
    expect(body.script.commandId).toBe("cmd-x");
  });

  it("缺少 canvasId 被拒绝（不再使用默认画布）", async () => {
    const { base, close } = await start({
      async submitScript(input) {
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-x", idempotent: false };
      }
    });
    closers.push(close);
    const response = await fetch(`${base}${MODEL_MCP_BASE_PATH}/scripts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "model-1", source: "func build(): pass" })
    });
    expect(response.status).toBe(400);
  });

  it("service 拒绝时返回稳定错误码", async () => {
    const { base, close } = await start({
      async submitScript(input) {
        return { ok: false, code: "unknown-node", message: `节点 ${input.nodeId} 不存在` };
      }
    });
    closers.push(close);
    const response = await fetch(`${base}${MODEL_MCP_BASE_PATH}/scripts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: DEFAULT_CANVAS, nodeId: "nope", source: "func build(): pass" })
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("unknown-node");
  });

  it("未挂载 service 时脚本提交返回 503", async () => {
    const { base, close } = await start();
    closers.push(close);
    const response = await fetch(`${base}${MODEL_MCP_BASE_PATH}/scripts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canvasId: DEFAULT_CANVAS, nodeId: "model-1", source: "func build(): pass" })
    });
    expect(response.status).toBe(503);
  });

  it("非 model-mcp 路径不由本 handler 处理", async () => {
    const { base, close } = await start();
    closers.push(close);
    const response = await fetch(`${base}/api/canvases`);
    expect(response.status).toBe(404);
  });
});
