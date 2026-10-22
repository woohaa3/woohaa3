/**
 * Task Service submit 的 mention token 防线
 * （change: add-reference-inputs-and-mentions，任务 6.3）。
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createTaskApiHandler } from "./api/internal-api.js";
import { WOOHAA3_PROTOCOL_VERSION, type CanvasTaskCatalog } from "@woohaa3/contracts";

function catalogWithLanguage(): CanvasTaskCatalog {
  return {
    available: true,
    models: [
      {
        modelKey: "litellm:gpt-4o",
        providerId: "litellm",
        providerModelId: "gpt-4o",
        modelType: "language",
        title: "语言",
        interaction: { id: "generic-model", version: 1 },
        inputSchema: {},
        defaultInput: {},
        bindings: [
          {
            field: "imageUrls",
            semantic: "reference-image",
            roles: ["reference_image"],
            mediaKinds: ["image"],
            mediaTypes: ["image/png"],
            maxItems: 4,
            valueFormat: "url"
          }
        ],
        taskTimeoutMs: 1000
      }
    ],
    defaultModels: {}
  };
}

function submitRequest(body: unknown): { req: IncomingMessage; res: ServerResponse; written: string[] } {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = "PUT";
  req.url = "/internal/v1/tasks/r1";
  req.headers["authorization"] = "Bearer test-token";
  req.headers["x-woohaa3-protocol-version"] = String(WOOHAA3_PROTOCOL_VERSION);
  req.headers["x-woohaa3-service-token"] = "test-token";
  const written: string[] = [];
  const res = new ServerResponse(req);
  res.setHeader = (() => res) as typeof res.setHeader;
  res.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") written.push(chunk);
    return res;
  }) as typeof res.end;
  // 模拟读 body：手动 emit data/end。
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
    req.emit("end");
  });
  return { req, res, written };
}

describe("submit token 防线（任务 6.3）", () => {
  it("prompt 含内部 mention token 时在 provider 调用前拒绝", async () => {
    let called = false;
    const handler = createTaskApiHandler({
      resolveCatalog: async () => catalogWithLanguage(),
      history: {
        get: () => undefined,
        upsertRecord: () => 0,
        appendEvent: () => 0,
        listSince: () => ({ records: [], cursor: 0 })
      } as never,
      submit: async () => {
        called = true;
        return { reused: false, state: "queued" };
      },
      cancel: async () => null,
      status: async () => undefined,
      listHistory: () => ({ items: [], cursor: 0 }),
      listCanvasActivity: () => ({ active: [], recent: [], cursor: 0 }),
      listCanvasActivitySince: () => ({ items: [], cursor: 0 }),
      serviceToken: "test-token"
    });
    const { req, res, written } = submitRequest({
      workerTaskKey: "r1",
      protocolVersion: WOOHAA3_PROTOCOL_VERSION,
      canvasId: "c1",
      nodeId: "n1",
      runId: "run1",
      jobId: "job1",
      nodeType: "text",
      modelType: "language",
      modelKey: "litellm:gpt-4o",
      prompt: "参考 {{input_image:slot-x:图片 1}}",
      parameters: {},
      inputs: []
    });
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(called).toBe(false);
    expect(written.join("")).toContain("未编译的内部 mention token");
  });
});
