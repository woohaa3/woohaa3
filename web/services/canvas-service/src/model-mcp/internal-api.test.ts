/**
 * Canvas 内部协议 handler 测试（change: split-model-mcp-into-mcp-service）。
 *
 * 覆盖 spec「受认证的内部语义命令入口」：协议版本、服务令牌、actorId 由身份派生、
 * 稳定错误映射，以及未认证/不兼容在副作用前拒绝。
 */
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModelMcpInternalHandler, type ModelMcpInternalService } from "./internal-api.js";
import type { ApplyCommandsInput, ApplyCommandsOutcome } from "./service.js";
import type { ModelBatchContext } from "./batch-service.js";
import type { CanvasCommand, GetModelNodesInput, ModelNodesOutcome, ModelScriptBatchOutcome, ModelScriptBatchRequest } from "@woohaa3/contracts";

const DEFAULT_CANVAS = "woohaa3-default-canvas";
const TOKEN = "mcp-token";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function start(service?: ModelMcpInternalService, serviceToken: string | undefined = TOKEN) {
  const handler = createModelMcpInternalHandler({ service, serviceToken });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${port}` };
}

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-woohaa3-mcp-protocol-version": "1",
      ...headers
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const AUTH = { "x-woohaa3-service-token": TOKEN };

describe("Canvas 内部 MCP 协议", () => {
  it("缺少服务令牌时在副作用前拒绝", async () => {
    let called = false;
    const { base } = await start({
      listModelNodes: async () => {
        called = true;
        return { ok: true, canvasId: "c", nodes: [] };
      }
    } as unknown as ModelMcpInternalService);
    const result = await post(base, "/internal/v1/model-mcp/nodes/list", { canvasId: "c" });
    expect(result.status).toBe(401);
    expect(called).toBe(false);
  });

  it("协议版本不兼容时拒绝且不触达 service", async () => {
    let called = false;
    const { base } = await start({
      listModelNodes: async () => {
        called = true;
        return { ok: true, canvasId: "c", nodes: [] };
      }
    } as unknown as ModelMcpInternalService);
    const result = await post(
      base,
      "/internal/v1/model-mcp/nodes/list",
      { canvasId: "c" },
      { ...AUTH, "x-woohaa3-mcp-protocol-version": "2" }
    );
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("protocol-incompatible");
    expect(called).toBe(false);
  });

  it("applyCommands 透传命令（canvasId 必填）", async () => {
    const commands: CanvasCommand[] = [{ type: "nodeData.patch", nodeId: "n1", value: { prompt: "x" } as never }];
    const captured: Array<{ canvasId: string; commandId: string; commands: readonly CanvasCommand[] }> = [];
    const { base } = await start({
      applyCommands: async (input: ApplyCommandsInput): Promise<ApplyCommandsOutcome> => {
        captured.push(input);
        return { ok: true, canvasId: input.canvasId, commandId: input.commandId, duplicate: false, noop: false };
      }
    } as unknown as ModelMcpInternalService);
    const result = await post(
      base,
      "/internal/v1/model-mcp/commands",
      { canvasId: DEFAULT_CANVAS, commandId: "cmd-1", baseRevision: 0, commands },
      AUTH
    );
    expect(result.status).toBe(200);
    expect(captured[0]?.canvasId).toBe(DEFAULT_CANVAS);
    expect(captured[0]?.commands).toEqual(commands);
  });

  it("非法请求体返回稳定 malformed-request", async () => {
    const { base } = await start({} as ModelMcpInternalService);
    const result = await post(base, "/internal/v1/model-mcp/commands", { commandId: "c" }, AUTH);
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("malformed-request");
  });

  it("下游 canvas-not-found 映射为 404", async () => {
    const { base } = await start({
      getModelNode: async () => ({ ok: false, code: "canvas-not-found", message: "无画布" })
    } as unknown as ModelMcpInternalService);
    const result = await post(base, "/internal/v1/model-mcp/nodes/get", { canvasId: "c", nodeId: "n" }, AUTH);
    expect(result.status).toBe(404);
    expect(result.body.code).toBe("canvas-not-found");
  });

  it("未知内部路径不认领", async () => {
    const { base } = await start({} as ModelMcpInternalService);
    const response = await fetch(`${base}/internal/v1/other`);
    expect(response.status).toBe(404);
  });

  it("模型统计：透传 source 并返回当前/候选身份（change: 2026-10-18-align-model-statistics-with-agent）", async () => {
    const captured: Array<{ canvasId: string; nodeId: string; source?: string }> = [];
    const statistics = { objects: 389, groups: 1, vertices: 42880, triangles: 32608, materials: 16, animations: 0 };
    const breakdown = {
      box: { count: 178, vertices: 1424, triangles: 2136 },
      cylinder: { count: 0, vertices: 0, triangles: 0 },
      sphere: { count: 0, vertices: 0, triangles: 0 },
      capsule: { count: 100, vertices: 40000, triangles: 28800 },
      mesh: { count: 111, vertices: 1456, triangles: 1672 }
    };
    const { base } = await start({
      getModelStatistics: async (input: { canvasId: string; nodeId: string; source?: string }) => {
        captured.push(input);
        return {
          ok: true,
          canvasId: input.canvasId,
          nodeId: input.nodeId,
          source: input.source === undefined ? "current" : "candidate",
          statistics,
          breakdown
        };
      }
    } as unknown as ModelMcpInternalService);
    const current = await post(base, "/internal/v1/model-mcp/models/statistics", { canvasId: DEFAULT_CANVAS, nodeId: "m1" }, AUTH);
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ ok: true, source: "current", statistics });
    const candidate = await post(
      base,
      "/internal/v1/model-mcp/models/statistics",
      { canvasId: DEFAULT_CANVAS, nodeId: "m1", source: "scene.box({ id: 'b' });" },
      AUTH
    );
    expect(candidate.status).toBe(200);
    expect(candidate.body.source).toBe("candidate");
    expect(captured[1]).toMatchObject({ source: "scene.box({ id: 'b' });" });
    // 无 source 时不得发送 undefined 字段，保持请求体可预测。
    expect(captured[0]).toEqual({ canvasId: DEFAULT_CANVAS, nodeId: "m1" });
  });

  it("模型统计：非法 source 与缺失能力分别返回 malformed-request / 503", async () => {
    let called = false;
    const { base } = await start({
      getModelStatistics: async () => {
        called = true;
        return { ok: false, code: "x", message: "x" };
      }
    } as unknown as ModelMcpInternalService);
    const malformed = await post(
      base,
      "/internal/v1/model-mcp/models/statistics",
      { canvasId: DEFAULT_CANVAS, nodeId: "m1", source: "   " },
      AUTH
    );
    expect(malformed.status).toBe(400);
    expect(called).toBe(false);

    const { base: bare } = await start({} as ModelMcpInternalService);
    const missing = await post(
      bare,
      "/internal/v1/model-mcp/models/statistics",
      { canvasId: DEFAULT_CANVAS, nodeId: "m1" },
      AUTH
    );
    expect(missing.status).toBe(503);
  });

  it("getModelNode 透传 includeStatistics", async () => {
    const captured: Array<{ canvasId: string; nodeId: string; includeStatistics?: boolean }> = [];
    const { base } = await start({
      getModelNode: async (input: { canvasId: string; nodeId: string; includeStatistics?: boolean }) => {
        captured.push(input);
        return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, title: "t", prompt: "", source: "", references: [], cameras: [] };
      }
    } as unknown as ModelMcpInternalService);
    await post(base, "/internal/v1/model-mcp/nodes/get", { canvasId: DEFAULT_CANVAS, nodeId: "m1" }, AUTH);
    await post(base, "/internal/v1/model-mcp/nodes/get", { canvasId: DEFAULT_CANVAS, nodeId: "m1", includeStatistics: true }, AUTH);
    expect(captured[0]).toEqual({ canvasId: DEFAULT_CANVAS, nodeId: "m1" });
    expect(captured[1]).toMatchObject({ includeStatistics: true });
  });

  it("批量模型读取：透传 canvasId/nodeIds，actor 不影响读取", async () => {
    const captured: GetModelNodesInput[] = [];
    const { base } = await start({
      getModelNodes: async (input: GetModelNodesInput): Promise<ModelNodesOutcome> => {
        captured.push(input);
        return { ok: true, canvasId: input.canvasId, revision: 3, nodes: [] };
      }
    } as unknown as ModelMcpInternalService);
    const result = await post(
      base,
      "/internal/v1/model-mcp/models/nodes",
      { canvasId: DEFAULT_CANVAS, nodeIds: ["m1", "m2"], includeSource: true },
      AUTH
    );
    expect(result.status).toBe(200);
    expect(result.body.revision).toBe(3);
    expect(captured[0]).toEqual({ canvasId: DEFAULT_CANVAS, nodeIds: ["m1", "m2"], includeSource: true });
  });

  it("批量模型脚本：validate 只校验、submit 提交，二者都用内部 actor 作为 principal", async () => {
    const seen: Array<{ kind: string; input: ModelScriptBatchRequest; principalId: string }> = [];
    const okBatch = (input: ModelScriptBatchRequest): ModelScriptBatchOutcome => ({
      ok: true,
      canvasId: input.canvasId,
      requestId: input.requestId,
      commandId: "cmd-batch",
      revision: 1,
      duplicate: false,
      noop: false,
      validatedOnly: false,
      nodes: []
    });
    const { base } = await start({
      validateScripts: async (input: ModelScriptBatchRequest, context: ModelBatchContext) => {
        seen.push({ kind: "validate", input, principalId: context.principalId });
        return { ...okBatch(input), validatedOnly: true };
      },
      submitScripts: async (input: ModelScriptBatchRequest, context: ModelBatchContext) => {
        seen.push({ kind: "submit", input, principalId: context.principalId });
        return okBatch(input);
      }
    } as unknown as ModelMcpInternalService);
    const body = {
      canvasId: DEFAULT_CANVAS,
      requestId: "batch-1",
      items: [{ nodeId: "m1", source: "export default {}" }]
    };
    const validated = await post(base, "/internal/v1/model-mcp/models/validate", body, AUTH);
    expect(validated.status).toBe(200);
    expect(validated.body.validatedOnly).toBe(true);
    const submitted = await post(base, "/internal/v1/model-mcp/models/submit", body, AUTH);
    expect(submitted.status).toBe(200);
    expect(submitted.body.commandId).toBe("cmd-batch");
    expect(seen.map((entry) => entry.kind)).toEqual(["validate", "submit"]);
    for (const entry of seen) expect(entry.principalId).toBe("mcp-service");
    expect(seen[1]?.input.items).toEqual([{ nodeId: "m1", source: "export default {}" }]);
  });

  it("批量模型脚本：非法 body 在触达 service 前返回 malformed-request", async () => {
    let called = false;
    const { base } = await start({
      submitScripts: async () => {
        called = true;
        return { ok: false, code: "x", message: "x" };
      }
    } as unknown as ModelMcpInternalService);
    const result = await post(
      base,
      "/internal/v1/model-mcp/models/submit",
      { canvasId: DEFAULT_CANVAS, requestId: "batch-1", items: [] },
      AUTH
    );
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("malformed-request");
    expect(called).toBe(false);
  });
});
