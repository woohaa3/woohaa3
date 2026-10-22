/**
 * MCP 工具编排测试（change: split-model-mcp-into-mcp-service）。
 *
 * 覆盖新增的节点编排 / 提示词 / 镜头工具：它们只表达命令意图，画布写入由下游
 * `applyCommands` 完成；`commandId` 由意图稳定派生，重复调用幂等。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpHttpHandler, MODEL_MCP_HTTP_PATH, type ModelMcpToolService } from "./mcp-http.js";
import type { CanvasCommand, McpApplyCommandsResult } from "@woohaa3/contracts";

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

async function callTool(base: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}${MODEL_MCP_HTTP_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
  });
  return parseMcpResponse(response);
}

/** 解析 Streamable HTTP 响应（应用 JSON 或 SSE `data:` 帧）。 */
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
  it("列出提示词/镜头工具", async () => {
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
    expect(names).toEqual(expect.arrayContaining([
      "set_node_prompt",
      "set_model_camera",
      "get_model_cameras",
      "create_model_camera",
      "update_model_camera",
      "delete_model_camera",
      "rename_model_camera",
      "reset_model_camera"
    ]));
    // change: 2026-10-07-remove-residual-compatibility —— orchestrate_canvas 下线。
    expect(names).not.toContain("orchestrate_canvas");
  });

  it("set_model_camera 只写 canonical modelCameras，并规范化排序", async () => {
    const captured: Array<{ commands: CanvasCommand[] }> = [];
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "x", message: "x" }),
      submitScript: async () => ({ ok: false, code: "x", message: "x" }),
      applyCommands: async (input) => {
        captured.push(input);
        return { ok: true, canvasId: input.canvasId, commandId: input.commandId, duplicate: false, noop: false } as McpApplyCommandsResult;
      }
    });
    await callTool(base, "set_model_camera", {
      canvasId: "c",
      nodeId: "model-1",
      cameras: [
        { id: "c2", name: "右", order: 1, azimuth: 1.5, elevation: 0, distance: 5, aspect: "16:9" },
        { id: "c1", name: "左", order: 0, azimuth: 0, elevation: 0, distance: 3, aspect: "16:9" }
      ]
    });
    const patch = captured[0]?.commands[0] as { value?: { modelCameras?: unknown } } | undefined;
    const cameras = patch?.value?.modelCameras as Array<{ id: string; order: number }>;
    expect(cameras.map((camera) => camera.id)).toEqual(["c1", "c2"]);
  });

  it("非法镜头集合在写入前被拒绝", async () => {
    let called = false;
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "x", message: "x" }),
      submitScript: async () => ({ ok: false, code: "x", message: "x" }),
      applyCommands: async (input) => {
        called = true;
        return { ok: true, canvasId: input.canvasId, commandId: input.commandId, duplicate: false, noop: false };
      }
    });
    const result = await callTool(base, "set_model_camera", {
      canvasId: "c",
      nodeId: "model-1",
      cameras: [{ id: "c1", name: "x", order: 0, azimuth: 0, distance: -1 }]
    });
    expect(result.isError ?? (result as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(called).toBe(false);
  });

  it("set_model_camera 保留 aspect/focusOffset/elevation（不再截断字段）", async () => {
    const captured: Array<{ commands: CanvasCommand[] }> = [];
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "x", message: "x" }),
      submitScript: async () => ({ ok: false, code: "x", message: "x" }),
      applyCommands: async (input) => {
        captured.push(input);
        return { ok: true, canvasId: input.canvasId, commandId: input.commandId, duplicate: false, noop: false } as McpApplyCommandsResult;
      }
    });
    await callTool(base, "set_model_camera", {
      canvasId: "c",
      nodeId: "model-1",
      cameras: [{ id: "c1", name: "x", order: 0, azimuth: 0, distance: 3, elevation: 0.25, aspect: "1:1", focusOffset: { x: 1, y: 2, z: 3 } }]
    });
    const patch = captured[0]?.commands[0] as { value?: { modelCameras?: Array<Record<string, unknown>> } } | undefined;
    expect(patch?.value?.modelCameras?.[0]).toMatchObject({ elevation: 0.25, aspect: "1:1", focusOffset: { x: 1, y: 2, z: 3 } });
  });

  it("get_model_cameras 读取规范化镜头集合", async () => {
    const { base } = await start({
      getModelNode: async () => ({
        ok: true,
        canvasId: "c",
        nodeId: "model-1",
        title: "模型",
        prompt: "",
        source: "",
        references: [],
        cameras: [{ id: "cam-a", name: "正面", order: 0, azimuth: 0, elevation: 0.25, distance: 3, aspect: "16:9" }]
      }),
      submitScript: async () => ({ ok: false, code: "x", message: "x" })
    });
    const result = await callTool(base, "get_model_cameras", { canvasId: "c", nodeId: "model-1" });
    const structured = (result as { result?: { structuredContent?: { cameras?: Array<{ id: string }> } } }).result?.structuredContent;
    expect(structured?.cameras?.map((camera) => camera.id)).toEqual(["cam-a"]);
  });

  it("镜头 CRUD 工具构造正确 mutation 并透传 requestId", async () => {
    const captured: Array<{ nodeId: string; requestId: string; mutation: unknown }> = [];
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "x", message: "x" }),
      submitScript: async () => ({ ok: false, code: "x", message: "x" }),
      mutateCameras: async (input) => {
        captured.push(input);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", duplicate: false, noop: false, cameras: [] };
      }
    });
    await callTool(base, "create_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r1", azimuth: 0.5, distance: 4, elevation: 0.1, aspect: "4:5" });
    await callTool(base, "update_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r2", cameraId: "cam-a", distance: 6 });
    await callTool(base, "delete_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r3", cameraId: "cam-a" });
    await callTool(base, "rename_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r4", cameraId: "cam-a", name: "主视角" });
    await callTool(base, "reset_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r5", cameraId: "cam-a", azimuth: 0, distance: 3, elevation: 0.2 });

    expect(captured.map((entry) => entry.requestId)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(captured[0]?.mutation).toEqual({ kind: "create", azimuth: 0.5, distance: 4, elevation: 0.1, aspect: "4:5" });
    expect(captured[1]?.mutation).toEqual({ kind: "update", id: "cam-a", distance: 6 });
    expect(captured[2]?.mutation).toEqual({ kind: "remove", id: "cam-a" });
    expect(captured[3]?.mutation).toEqual({ kind: "rename", id: "cam-a", name: "主视角" });
    expect(captured[4]?.mutation).toEqual({ kind: "reset", id: "cam-a", azimuth: 0, distance: 3, elevation: 0.2 });
  });

  it("镜头工具接受扩展画幅并拒绝未知画幅（change: expand-shot-camera-aspects）", async () => {
    const captured: Array<{ mutation: unknown }> = [];
    let mutateCalls = 0;
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "x", message: "x" }),
      submitScript: async () => ({ ok: false, code: "x", message: "x" }),
      mutateCameras: async (input) => {
        mutateCalls += 1;
        captured.push(input);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd", duplicate: false, noop: false, cameras: [] };
      }
    });

    // 生图并集内的扩展画幅（超宽 / 竖屏 / 极端）被接受并透传。
    await callTool(base, "create_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r-wide", azimuth: 0, distance: 3, aspect: "21:9" });
    await callTool(base, "update_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r-tall", cameraId: "cam-a", aspect: "9:16" });
    await callTool(base, "update_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r-extreme", cameraId: "cam-a", aspect: "1:8" });
    expect(captured.map((entry) => (entry.mutation as { aspect?: string }).aspect)).toEqual(["21:9", "9:16", "1:8"]);

    // 未知画幅在触碰 mutateCameras 前被输入校验拒绝。
    const before = mutateCalls;
    const rejected = await callTool(base, "create_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r-bad", azimuth: 0, distance: 3, aspect: "7:3" });
    expect(rejected.isError ?? (rejected as { result?: { isError?: boolean } }).result?.isError).toBe(true);
    expect(mutateCalls).toBe(before);
  });

  it("未配置 mutateCameras 时镜头 CRUD 返回稳定 unavailable", async () => {
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "x", message: "x" }),
      submitScript: async () => ({ ok: false, code: "x", message: "x" })
    });
    const result = await callTool(base, "create_model_camera", { canvasId: "c", nodeId: "m1", requestId: "r1", azimuth: 0, distance: 3 });
    const structured = (result as { result?: { structuredContent?: { ok?: boolean; code?: string } } }).result?.structuredContent;
    expect(structured?.ok).toBe(false);
    expect(structured?.code).toBe("unavailable");
  });
});
