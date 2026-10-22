/**
 * Task 插件任务内部 API 测试
 * （change: 2026-10-05-extract-application-plugin-host，任务 4.1 / design D4）。
 *
 * 验证：无服务身份拒绝、插件不可提交画布节点任务（不能绕过 Canvas）、
 * 只允许查询/取消同一插件的任务。
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteExtensionTaskAssociationRepository } from "../repository/extension-task-association-repository.js";
import { createTaskExtensionTaskApiHandler } from "./extension-task-api.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-task-plugin-task-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeHarness(resultText?: string) {
  const associations = createSqliteExtensionTaskAssociationRepository({ path: tempDb() });
  const submitted: Array<{ extensionId: string; configVersion: number }> = [];
  const handler = createTaskExtensionTaskApiHandler({
    resolveCatalog: async () => ({
      available: true,
      models: [
        {
          modelKey: "litellm:gpt-4o-mini",
          providerId: "litellm",
          providerModelId: "gpt-4o-mini",
          modelType: "language",
          title: "gpt",
          interaction: { id: "language", version: 1 },
          inputSchema: {},
          defaultInput: {},
          bindings: [],
          taskTimeoutMs: 1000
        }
      ],
      defaultModels: {}
    }),
    history: { get: (_key:string, options:{fullText:boolean}) => resultText && options.fullText ? {state:"succeeded",result:{text:resultText,textTruncated:false}} : undefined } as never,
    associations,
    submit: async (_request, association) => {
      submitted.push(association);
      return { reused: false, state: "queued" };
    },
    cancel: async () => "cancelled",
    status: async () => ({ taskKey: "k", state: "succeeded" }) as never,
    serviceToken: "svc"
  });
  return { handler, associations, submitted };
}

function makeRequest(options: { method: string; url: string; headers?: Record<string, string>; body?: unknown }): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.method = options.method;
  req.url = options.url;
  req.headers["x-woohaa3-protocol-version"] = "1";
  for (const [key, value] of Object.entries(options.headers ?? {})) req.headers[key] = value;
  if (options.body !== undefined) {
    const payload = JSON.stringify(options.body);
    queueMicrotask(() => {
      req.emit("data", Buffer.from(payload));
      req.emit("end");
    });
  }
  return req;
}

function mockResponse(req: IncomingMessage): { res: ServerResponse; written: string[] } {
  const written: string[] = [];
  const res = new ServerResponse(req);
  res.setHeader = (() => res) as typeof res.setHeader;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") written.push(chunk);
    return res;
  }) as typeof res.end;
  return { res, written };
}

async function call(handler: ReturnType<typeof createTaskExtensionTaskApiHandler>, request: IncomingMessage) {
  const { res, written } = mockResponse(request);
  await handler(request, res);
  const text = written.join("");
  return { status: res.statusCode, body: text === "" ? null : JSON.parse(text) };
}

const SUBMIT_BODY = {
  extensionId: "sample-site-extension",
  configVersion: 1,
  modelType: "language",
  modelKey: "litellm:gpt-4o-mini",
  prompt: "hello",
  parameters: {}
};

describe("Task 插件任务内部 API（任务 4.1）", () => {
  it("无服务身份拒绝（浏览器/loopback 不授权）", async () => {
    const { handler } = makeHarness();
    const result = await call(handler, makeRequest({ method: "PUT", url: "/internal/v1/extensions/sample-site-extension/tasks/key-1", body: SUBMIT_BODY }));
    expect(result.status).toBe(401);
  });

  it("拒绝 Application 伪造画布节点任务", async () => {
    const { handler, submitted } = makeHarness();
    const result = await call(
      handler,
      makeRequest({
        method: "PUT",
        url: "/internal/v1/extensions/sample-site-extension/tasks/key-2",
        headers: { "x-woohaa3-service-token": "svc" },
        body: { ...SUBMIT_BODY, canvasId: "c1", nodeId: "n1", runId: "r1" }
      })
    );
    expect(result.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });

  it("合法非画布任务提交并持久化插件关联", async () => {
    const { handler, associations, submitted } = makeHarness();
    const result = await call(
      handler,
      makeRequest({
        method: "PUT",
        url: "/internal/v1/extensions/sample-site-extension/tasks/key-3",
        headers: { "x-woohaa3-service-token": "svc" },
        body: SUBMIT_BODY
      })
    );
    expect(result.status).toBe(202);
    expect(submitted).toEqual([{ extensionId: "sample-site-extension", configVersion: 1 }]);
    expect(associations.find("key-3")?.extensionId).toBe("sample-site-extension");
  });

  it("插件只能查询/取消自己拥有的任务", async () => {
    const { handler, associations } = makeHarness();
    await call(
      handler,
      makeRequest({
        method: "PUT",
        url: "/internal/v1/extensions/sample-site-extension/tasks/key-4",
        headers: { "x-woohaa3-service-token": "svc" },
        body: SUBMIT_BODY
      })
    );
    // 另一个插件查询同一 key：拒绝，不泄漏任务数据。
    const wrongExtension = await call(
      handler,
      makeRequest({
        method: "GET",
        url: "/internal/v1/extensions/other-extension/tasks/key-4",
        headers: { "x-woohaa3-service-token": "svc" }
      })
    );
    expect(wrongExtension.status).toBe(404);
    // 正确插件可查询。
    const own = await call(
      handler,
      makeRequest({
        method: "GET",
        url: "/internal/v1/extensions/sample-site-extension/tasks/key-4",
        headers: { "x-woohaa3-service-token": "svc" }
      })
    );
    expect(own.status).toBe(200);
    expect(associations.find("key-4")?.extensionId).toBe("sample-site-extension");
  });
});

it("插件结果读取经持久 owner 关联，恢复完整生成文本",async()=>{
 const text="游戏源码".repeat(2000);const {handler}=makeHarness(text);
 await call(handler,makeRequest({method:"PUT",url:"/internal/v1/extensions/sample-site-extension/tasks/result-key",headers:{"x-woohaa3-service-token":"svc"},body:SUBMIT_BODY}));
 const read=await call(handler,makeRequest({method:"GET",url:"/internal/v1/extensions/sample-site-extension/tasks/result-key/result",headers:{"x-woohaa3-service-token":"svc"}}));expect(read.body.result.text).toBe(text);expect(read.body.result.textTruncated).toBe(false);
 const wrong=await call(handler,makeRequest({method:"GET",url:"/internal/v1/extensions/other/tasks/result-key/result",headers:{"x-woohaa3-service-token":"svc"}}));expect(wrong.status).toBe(404);
});
