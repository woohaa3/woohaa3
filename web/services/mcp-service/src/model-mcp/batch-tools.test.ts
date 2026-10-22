import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelMcpHttpHandler,
  MODEL_MCP_HTTP_PATH,
  type ModelMcpToolService,
} from "./mcp-http.js";
import type { ModelMcpHttpOptions } from "./http-types.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function start(options: ModelMcpHttpOptions = {}) {
  const handler = createModelMcpHttpHandler(options);
  const server = http.createServer((req, res) => {
    void handler.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  closers.push(async () => {
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return async (method: string, params: unknown, token?: string) => {
    const response = await fetch(
      `http://127.0.0.1:${port}${MODEL_MCP_HTTP_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
    );
    const text = await response.text();
    return JSON.parse(
      text.trim().startsWith("{")
        ? text
        : text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .at(-1)!
            .slice(5),
    ).result;
  };
}
const request = {
  canvasId: "c",
  requestId: "batch",
  commonSource: "const size=2;",
  items: [
    { nodeId: "a", source: "scene.box({id:'body',size:[size,1,1]});" },
    { nodeId: "b", source: "scene.sphere({id:'ball',radius:1});" },
  ],
};
function service(partial: Partial<ModelMcpToolService>): ModelMcpToolService {
  return { getModelNode: vi.fn(), submitScript: vi.fn(), ...partial };
}
describe("model batch MCP", () => {
  it("discovers three tools with strict schemas and accurate side effects", async () => {
    const rpc = await start();
    const listed = await rpc("tools/list", {});
    const byName = new Map<string, any>(
      listed.tools.map((tool: any) => [tool.name, tool]),
    );
    expect(byName.get("get_model_nodes").annotations.readOnlyHint).toBe(true);
    expect(byName.get("validate_model_scripts").annotations.readOnlyHint).toBe(
      true,
    );
    expect(byName.get("submit_model_scripts").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(
      byName.get("submit_model_scripts").inputSchema.additionalProperties,
    ).toBe(false);
    expect(
      byName.get("submit_model_scripts").inputSchema.properties.items.maxItems,
    ).toBe(64);
  });
  it("forwards shared code, item preconditions and camera sets without per-node calls", async () => {
    const getModelNodes = vi
      .fn()
      .mockResolvedValue({ ok: true, canvasId: "c", revision: 3, nodes: [] });
    const outcome = {
      ok: true,
      canvasId: "c",
      requestId: "batch",
      commandId: "cmd",
      revision: 4,
      duplicate: false,
      noop: false,
      validatedOnly: false,
      nodes: [],
    };
    const validateScripts = vi
      .fn()
      .mockResolvedValue({ ...outcome, validatedOnly: true });
    const submitScripts = vi.fn().mockResolvedValue(outcome);
    const rpc = await start({
      service: service({ getModelNodes, validateScripts, submitScripts }),
    });
    await rpc("tools/call", {
      name: "get_model_nodes",
      arguments: { canvasId: "c", nodeIds: ["a", "b"] },
    });
    const validation = await rpc("tools/call", {
      name: "validate_model_scripts",
      arguments: request,
    });
    expect(validation.structuredContent.validatedOnly).toBe(true);
    expect(validation.structuredContent).not.toHaveProperty("validationToken");
    const result = await rpc("tools/call", {
      name: "submit_model_scripts",
      arguments: request,
    });
    expect(result.structuredContent).toEqual(outcome);
    expect(submitScripts).toHaveBeenCalledTimes(1);
    expect(submitScripts).toHaveBeenCalledWith(request);
    expect(validateScripts).toHaveBeenCalledWith(request);
    expect(getModelNodes).toHaveBeenCalledWith({
      canvasId: "c",
      nodeIds: ["a", "b"],
    });
  });
  it("preserves indexed errors and rejects unknown input fields before delegation", async () => {
    const failure = {
      ok: false,
      code: "model-batch-invalid",
      message: "invalid",
      errors: [
        {
          index: 1,
          nodeId: "b",
          code: "model-script-compile",
          message: "syntax",
        },
      ],
    };
    const submitScripts = vi.fn().mockResolvedValue(failure);
    const rpc = await start({ service: service({ submitScripts }) });
    const result = await rpc("tools/call", {
      name: "submit_model_scripts",
      arguments: request,
    });
    expect(result).toMatchObject({ isError: true, structuredContent: failure });
    expect(result.content.some((entry: { text?: string }) => entry.text?.includes('"syntax"'))).toBe(true);
    const invalid = await rpc("tools/call", {
      name: "submit_model_scripts",
      arguments: { ...request, validationToken: "obsolete" },
    });
    expect(invalid.isError).toBe(true);
    expect(submitScripts).toHaveBeenCalledTimes(1);
  });
  it("passes all targets to a single grant check and refuses out-of-scope batches", async () => {
    const submitScripts = vi.fn().mockResolvedValue({ ok: true });
    const authorize = vi.fn((input: { nodeIds?: string[] }) =>
      input.nodeIds?.includes("b")
        ? { ok: false as const, reason: "node-not-allowed" }
        : { ok: true as const },
    );
    const rpc = await start({
      service: service({ submitScripts }),
      toolGrant: { authorize },
    });
    const denied = await rpc(
      "tools/call",
      { name: "submit_model_scripts", arguments: request },
      "grant",
    );
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: { code: "unauthorized" },
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith({
      token: "grant",
      tool: "submit_model_scripts",
      canvasId: "c",
      nodeIds: ["a", "b"],
    });
    expect(submitScripts).not.toHaveBeenCalled();
  });
  it("reports unmounted batch services explicitly", async () => {
    const rpc = await start({ service: service({}) });
    expect(
      await rpc("tools/call", {
        name: "submit_model_scripts",
        arguments: request,
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { code: "unavailable" },
    });
  });
});
