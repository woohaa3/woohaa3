/**
 * MCP 工具编排测试（change: split-model-mcp-into-mcp-service）。
 *
 * 覆盖新增的节点编排 / 提示词 / 镜头工具：它们只表达命令意图，画布写入由下游
 * `applyCommands` 完成；`commandId` 由意图稳定派生，重复调用幂等。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH, type ModelMcpToolService } from "./mcp-http.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function start(service?: ModelMcpToolService) {
  const handler = createModelMcpHttpHandler({ service });
  const server = http.createServer((req, res) => {
    void handler.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  closers.push(async () => {
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${port}` };
}

async function parseMcpResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean)
        .at(-1) ?? "{}"
    : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

describe("MCP 编排工具（change: split-model-mcp-into-mcp-service）", () => {
  it("列出提示词工具且不再暴露模型镜头工具", async () => {
    const { base } = await start();
    const resp = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    });
    const body = (await parseMcpResponse(resp)) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toContain("set_node_prompt");
    expect(names).not.toEqual(expect.arrayContaining([
      "set_model_camera", "get_model_cameras", "create_model_camera", "update_model_camera",
      "delete_model_camera", "rename_model_camera", "reset_model_camera", "mutate_model_cameras"
    ]));
    expect(names).not.toContain("orchestrate_canvas");
  });
});
