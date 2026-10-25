/**
 * sdk-agent 受控 HTTP handler 测试
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.4/1.5/5.3 验收）。
 *
 * 覆盖：owner 只取可信 principal；连接 CRUD；Key 保存/清除推进 epoch 且不回读明文；
 * `/check` 不调用模型（无生成探测）；`/test-generation` 才显式调用模型；跨 owner 不可见。
 */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse,
  ApplicationExtensionRequestContext,
} from "@woohaa3/contracts";
import {
  createSdkAgentHandler,
  type SdkAgentHandlerOptions,
} from "./handler.js";
import type { ConnectionService } from "@woohaa3/agent-connections";

type ConnectionRecord = {
  connectionId: string;
  owner: string;
  adapterId: string;
  name: string;
  runCategory: string;
  authMode: string;
  configRevision: number;
  credentialEpoch: number;
  baseUrl?: string;
  models?: string[];
  createdAt: string;
  updatedAt: string;
};

function fakeService(initial: ConnectionRecord[] = []): {
  service: ConnectionService;
  records: ConnectionRecord[];
  secrets: Map<string, string>;
} {
  const records = [...initial];
  const secrets = new Map<string, string>();
  let counter = initial.length;
  const service = {
    list: async (owner: string) =>
      records.filter((record) => record.owner === owner),
    get: async (owner: string, connectionId: string) =>
      records.find(
        (record) =>
          record.owner === owner && record.connectionId === connectionId,
      ) ?? null,
    create: async (owner: string, input: Record<string, unknown>) => {
      counter += 1;
      const created: ConnectionRecord = {
        connectionId: `c${counter}`,
        owner,
        adapterId: String(input.adapterId),
        name: String(input.name ?? input.adapterId),
        runCategory: String(input.runCategory),
        authMode: String(input.authMode),
        configRevision: 1,
        credentialEpoch: 0,
        ...(input.baseUrl ? { baseUrl: String(input.baseUrl) } : {}),
        ...(input.models ? { models: input.models as string[] } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      records.push(created);
      return { ok: true as const, value: created };
    },
    remove: async (owner: string, connectionId: string) => {
      const index = records.findIndex(
        (record) =>
          record.owner === owner && record.connectionId === connectionId,
      );
      if (index < 0)
        return {
          ok: false as const,
          error: { code: "not-found", message: "x" },
        };
      records.splice(index, 1);
      return { ok: true as const, value: { removed: true } };
    },
    saveCredential: async ({
      owner,
      connectionId,
      secret,
    }: {
      owner: string;
      connectionId: string;
      secret: string;
    }) => {
      const record = records.find(
        (entry) => entry.owner === owner && entry.connectionId === connectionId,
      );
      if (!record)
        return {
          ok: false as const,
          error: { code: "not-found", message: "x" },
        };
      secrets.set(connectionId, secret);
      record.credentialEpoch += 1;
      return {
        ok: true as const,
        value: { credentialEpoch: record.credentialEpoch },
      };
    },
    clearCredential: async ({
      owner,
      connectionId,
    }: {
      owner: string;
      connectionId: string;
    }) => {
      const record = records.find(
        (entry) => entry.owner === owner && entry.connectionId === connectionId,
      );
      if (!record)
        return {
          ok: false as const,
          error: { code: "not-found", message: "x" },
        };
      secrets.delete(connectionId);
      record.credentialEpoch += 1;
      return {
        ok: true as const,
        value: { credentialEpoch: record.credentialEpoch },
      };
    },
    credentialConfigured: async ({ connectionId }: { connectionId: string }) =>
      secrets.has(connectionId),
    readCredential: async ({ connectionId }: { connectionId: string }) =>
      secrets.has(connectionId) ? { secret: secrets.get(connectionId)! } : null,
    setStatus: async () => ({ ok: true as const, value: records[0] }),
  };
  return { service: service as unknown as ConnectionService, records, secrets };
}

/** 用真正的可读流模拟请求体；handler 在挂监听后才开始读，event 不会丢失。 */
function request(
  method: string,
  path: string,
  body?: unknown,
): ApplicationExtensionRawRequest {
  const stream = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")],
  );
  const req = stream as unknown as ApplicationExtensionRawRequest;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { url: string }).url = path;
  return req;
}

function context(owner = "u1"): ApplicationExtensionRequestContext {
  return {
    principal: { subject: owner },
  } as unknown as ApplicationExtensionRequestContext;
}

function response(): {
  res: ApplicationExtensionRawResponse;
  status: () => number;
  json: () => unknown;
} {
  let statusCode = 0;
  let payload = "";
  const res = {
    set statusCode(value: number) {
      statusCode = value;
    },
    get statusCode() {
      return statusCode;
    },
    setHeader: () => undefined,
    end: (chunk?: string) => {
      payload = chunk ?? "";
    },
  } as unknown as ApplicationExtensionRawResponse;
  return {
    res,
    status: () => statusCode,
    json: () => (payload === "" ? null : JSON.parse(payload)),
  };
}

async function call(
  options: SdkAgentHandlerOptions,
  method: string,
  path: string,
  body?: unknown,
  owner = "u1",
) {
  const handler = createSdkAgentHandler(options);
  const req = request(
    method,
    `/api/sdk-agent/${path.replace(/^\/+/, "")}`,
    body,
  );
  const out = response();
  await handler.handle(req, out.res, context(owner));
  return { status: out.status(), body: out.json() as Record<string, unknown> };
}

const deployment = { allowedHosts: ["api.openai.com"], allowHttp: false };

const openAiRecord: ConnectionRecord = {
  connectionId: "c1",
  owner: "u1",
  adapterId: "openai-responses",
  name: "OpenAI",
  runCategory: "http-sdk",
  authMode: "api-key",
  configRevision: 1,
  credentialEpoch: 0,
  models: ["gpt-5"],
  createdAt: "",
  updatedAt: "",
};

describe("sdk-agent handler（任务 1.4/1.5/5.3）", () => {
  it("创建连接只写设置，不调用模型", async () => {
    const { service } = fakeService();
    const result = await call({ service, deployment }, "POST", "connections", {
      adapterId: "openai-responses",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ connectionId: expect.any(String) });
  });

  it("部署未允许的自定义 Base URL 被拒绝", async () => {
    const { service } = fakeService();
    const result = await call({ service, deployment }, "POST", "connections", {
      adapterId: "openai-responses",
      baseUrl: "https://example.com",
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: "endpoint-not-allowed" });
  });

  it("保存 Key 推进 epoch，且响应不回读明文", async () => {
    const { service, secrets } = fakeService([
      { ...openAiRecord, credentialEpoch: 0 },
    ]);
    const saved = await call(
      { service, deployment },
      "POST",
      "connections/c1/credential",
      { secret: "sk-secret-123" },
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      credentialConfigured: true,
      credentialEpoch: 1,
    });
    expect(JSON.stringify(saved.body)).not.toContain("sk-secret-123");
    expect(secrets.get("c1")).toBe("sk-secret-123");

    const cleared = await call(
      { service, deployment },
      "POST",
      "connections/c1/clear",
    );
    expect(cleared.body).toMatchObject({
      credentialConfigured: false,
      credentialEpoch: 2,
    });
    expect(secrets.has("c1")).toBe(false);
  });

  it("/check 不调用模型（无 fetch），只报告凭据是否已保存", async () => {
    const { service } = fakeService([{ ...openAiRecord }]);
    let fetched = 0;
    const result = await call(
      {
        service,
        deployment: {
          ...deployment,
          fetchImpl: async () => {
            fetched += 1;
            throw new Error("不应调用模型");
          },
        },
      },
      "POST",
      "check",
      { connectionId: "c1" },
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      transport: "unknown",
      credential: "unavailable",
      modelAccess: "unknown",
    });
    expect(fetched).toBe(0);
  });

  it("/test-generation 缺 Key 或运行时拒绝，禁止直调 HTTP 降级", async () => {
    const { service } = fakeService([{ ...openAiRecord }]);
    const noKey = await call(
      { service, deployment },
      "POST",
      "test-generation",
      { connectionId: "c1" },
    );
    expect(noKey.body).toMatchObject({ code: "credential-missing" });

    await call({ service, deployment }, "POST", "connections/c1/credential", {
      secret: "sk-x",
    });
    const stream =
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n` +
      "data: [DONE]\n\n";
    const fetchImpl = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const result = await call(
      { service, deployment: { ...deployment, fetchImpl } },
      "POST",
      "test-generation",
      { connectionId: "c1", model: "gpt-5" },
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: false, code: "runtime-missing", model: "gpt-5" });
  });

  it("跨 owner 不可见：他人连接返回 not-found", async () => {
    const { service } = fakeService([{ ...openAiRecord }]);
    const result = await call(
      { service, deployment },
      "POST",
      "check",
      { connectionId: "c1" },
      "u2",
    );
    expect(result.status).toBe(404);
  });
});

it("configure 路由按用户串行保存，双击不重复创建并且只读取模型", async () => {
  const { createConnectionService } = await import(
    "@woohaa3/agent-connections"
  );
  const { createInMemoryDocumentStore, createInMemorySecretStore } =
    await import("../../../../services/agent-connections/src/test-doubles.js");
  const service = createConnectionService({
    documents: createInMemoryDocumentStore(["sdk"]).forExtension("sdk")!,
    secrets: createInMemorySecretStore(),
  });
  const methods: string[] = [];
  const handler = createSdkAgentHandler({
    service,
    deployment: {
      ...deployment,
      fetchImpl: async (_url, init) => {
        methods.push(init!.method!);
        return new Response('{"data":[{"id":"m1"}]}');
      },
    },
  });
  const save = async () => {
    const out = response();
    await handler.handle(
      request("POST", "/api/sdk-agent/configure", {
        adapterId: "compat-chat",
        secret: "sk-secret",
        operationId: "stable-double-click",
        owner: "attacker",
      }),
      out.res,
      context(),
    );
    expect(out.status()).toBe(200);
    expect(JSON.stringify(out.json())).not.toContain("sk-secret");
  };
  await Promise.all([save(), save()]);
  expect(await service.list("u1")).toHaveLength(1);
  expect(await service.list("attacker")).toHaveLength(0);
  expect(methods).toEqual(["GET"]);
});
