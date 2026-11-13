/**
 * 后端入口的接线测试（change: add-prompt-skill-extension；change: prompt-skill-config-in-plugin）。
 *
 * 覆盖：公开 HTTP 路由与认证、请求解码、改写模型只来自扩展配置文档、设置页读写配置的
 * CAS 语义，以及把改写结果映射成 JSON 响应。不启动真实宿主：Task 与 documents 都用替身。
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationBackendHost,
  ApplicationBackendHttpHandlerRegistration,
  ApplicationExtensionHttpRequest,
  ApplicationExtensionHttpResponse,
  ApplicationExtensionTaskFacade,
  ExtensionDocumentStore
} from "@woohaa3/contracts";
import { createPromptSkillsExtension } from "./index.js";
import { promptRewriterRole } from "./role.js";
import {
  agentRoleDescriptorDigest,
  agentRoleTurnDigests,
  composeAgentRoleMessages,
  makeAgentRoleRef,
  preparedTurnHash
} from "@woohaa3/contracts";

function fakeTasks(text = "雨夜霓虹街道，湿漉漉的柏油路。"): ApplicationExtensionTaskFacade & { submitted: unknown[] } {
  const submitted: unknown[] = [];
  let polls = 0;
  return {
    submitted,
    async submit(input) {
      submitted.push(input);
      return { ok: true, workerTaskKey: input.workerTaskKey, reused: false, state: "pending" };
    },
    async status() {
      polls += 1;
      return { workerTaskKey: "prompt-skills-req-1", state: polls > 1 ? "succeeded" : "running" };
    },
    async result() {
      return { workerTaskKey: "prompt-skills-req-1", state: "succeeded", result: { mediaKind: "text", text } };
    },
    async cancel() {
      return { workerTaskKey: "prompt-skills-req-1", state: "cancelled" };
    }
  };
}

function fakeDocuments(initialModel?: string) {
  let current: { model: string; revision: number } | null =
    initialModel === undefined ? null : { model: initialModel, revision: 1 };
  const store = {
    owner: () => "prompt-skills",
    get: async () => current === null
      ? { found: false as const }
      : { found: true as const, document: { key: "config", value: { model: current.model }, revision: current.revision, updatedAt: "now" } },
    batch: async (operations: ReadonlyArray<{ op: "set" | "delete"; key: string; value?: { model: string }; expectedRevision?: number | null }>) => {
      const operation = operations[0]!;
      const actual = current?.revision ?? null;
      const expected = operation.expectedRevision;
      const matches = expected === undefined
        || (expected === null ? current === null : current?.revision === expected);
      if (!matches) {
        return { ok: false as const, code: "revision-conflict" as const, key: operation.key, currentRevision: actual };
      }
      const revision = (current?.revision ?? 0) + 1;
      current = { model: operation.value?.model ?? "", revision };
      return { ok: true as const, revisions: { [operation.key]: revision } };
    },
    scan: async () => ({ entries: [], nextCursor: null }),
    schemaVersion: async () => 1,
    setSchemaVersion: async () => undefined
  };
  return store as unknown as ExtensionDocumentStore;
}

function harness(options: {
  documents?: ExtensionDocumentStore;
  tasks?: ApplicationExtensionTaskFacade;
} = {}) {
  const handlers = new Map<string, ApplicationBackendHttpHandlerRegistration>();
  const host = {
    extensionId: "prompt-skills",
    host: { extensionId: "application" },
    config: { values: () => ({}), secretRefs: () => [], desiredEnabled: () => true },
    work: {},
    services: {
      tasks: options.tasks ?? fakeTasks(),
      ...(options.documents ? { documents: options.documents } : {}),
      // 宿主角色准备面：单次改写只消费已准备的规范消息与角色版本。
      agentRoles: {
        prepare: ({ input, requestId }: { input: { skillId: string; prompt: string; taskKind: string }; requestId: string }) => {
          const definition = promptRewriterRole.definition;
          const messages = promptRewriterRole.prepare({ input, context: {}, target: {}, requestId, nativeCapabilities: [] }).messages;
          const digests = agentRoleTurnDigests({ input, context: {} });
          const base = {
            schemaVersion: 1 as const,
            roleRef: makeAgentRoleRef({ extensionId: "prompt-skills", roleId: definition.id, revision: definition.revision, descriptorDigest: agentRoleDescriptorDigest(definition), artifactId: "test@1" }),
            messages: composeAgentRoleMessages(definition.instructions, messages),
            tools: [],
            nativeCapabilities: [],
            output: definition.output,
            inputDigest: digests.inputDigest,
            contextDigest: digests.contextDigest,
            attachmentDigests: [],
            target: {}
          };
          return { ok: true as const, turn: { ...base, preparedHash: preparedTurnHash(base) } };
        },
        list: () => [],
        availability: () => ({ available: true })
      }
    },
    registerAgentRole: vi.fn(),
    registerCapability: vi.fn(),
    registerHandler: vi.fn(),
    registerHttpHandler: (input: ApplicationBackendHttpHandlerRegistration) => {
      handlers.set(`${input.method} ${input.route}`, input);
    },
    registerResource: vi.fn(),
    logger: vi.fn()
  } as unknown as ApplicationBackendHost;
  const definition: ApplicationBackendExtensionDefinition = createPromptSkillsExtension({ wait: async () => undefined });
  definition.activate(host);
  const rewrite = handlers.get("POST rewrite");
  const readConfig = handlers.get("GET config");
  const writeConfig = handlers.get("POST config");
  if (!rewrite || !readConfig || !writeConfig) throw new Error("handler 未注册");
  return { rewrite, readConfig, writeConfig };
}

const body = {
  requestId: "req-1",
  skillId: "polish",
  label: "画面细节润色",
  prompt: "雨夜街道",
  canvasId: "c1",
  nodeId: "n1",
  taskKind: "image"
};

function makeRequest(
  input: unknown,
  context: { accessControl?: boolean; principal?: unknown } = {},
  method: "GET" | "POST" = "POST"
): ApplicationExtensionHttpRequest {
  const bytes = new TextEncoder().encode(typeof input === "string" ? input : JSON.stringify(input));
  return {
    method,
    url: method === "GET" ? "/api/prompt-skills/config" : "/api/prompt-skills/rewrite",
    headers: { "content-type": "application/json" },
    signal: new AbortController().signal,
    readBody: async () => bytes,
    ...context
  } as ApplicationExtensionHttpRequest;
}

function makeResponse() {
  const state = { status: 0, body: "", headers: {} as Record<string, string> };
  const res = {
    setHeader: (name: string, value: string | readonly string[]) => {
      state.headers[name] = Array.isArray(value) ? value.join(",") : String(value);
    },
    writeHead: (status: number) => {
      state.status = status;
    },
    write: () => undefined,
    end: (chunk?: string | Uint8Array) => {
      if (chunk !== undefined) state.body = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    },
    writableEnded: false,
    onClose: () => undefined
  } as unknown as ApplicationExtensionHttpResponse;
  return { res, state, json: () => JSON.parse(state.body) as Record<string, unknown> };
}

describe("createPromptSkillsExtension", () => {
  it("注册公开 rewrite/config 路由", () => {
    const { rewrite, readConfig, writeConfig } = harness({ documents: fakeDocuments("cfg:model") });
    expect(rewrite.route).toBe("rewrite");
    expect(rewrite.method).toBe("POST");
    expect(rewrite.auth).toBe("public");
    expect(readConfig.route).toBe("config");
    expect(readConfig.method).toBe("GET");
    expect(writeConfig.method).toBe("POST");
    expect(writeConfig.auth).toBe("public");
  });

  it("改写使用插件配置文档里的模型，并把结果映射成 200 JSON", async () => {
    const tasks = fakeTasks();
    const { rewrite } = harness({ tasks, documents: fakeDocuments("cfg:model") });
    const response = makeResponse();
    await rewrite.handle(makeRequest(body), response.res);
    expect(response.state.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, prompt: "雨夜霓虹街道，湿漉漉的柏油路。" });
    expect((tasks.submitted[0] as { modelKey: string }).modelKey).toBe("cfg:model");
  });

  it("设置页读写模型：GET 回 revision，POST 带 CAS 更新", async () => {
    const documents = fakeDocuments("cfg:model");
    const { readConfig, writeConfig } = harness({ documents });
    const initial = makeResponse();
    await readConfig.handle(makeRequest(undefined, {}, "GET"), initial.res);
    expect(initial.json()).toEqual({ ok: true, model: "cfg:model", revision: 1 });

    const saved = makeResponse();
    await writeConfig.handle(makeRequest({ model: "cfg:other", expectedRevision: 1 }), saved.res);
    expect(saved.state.status).toBe(200);
    expect(saved.json()).toEqual({ ok: true, model: "cfg:other", revision: 2 });

    const next = makeResponse();
    await readConfig.handle(makeRequest(undefined, {}, "GET"), next.res);
    expect(next.json()).toEqual({ ok: true, model: "cfg:other", revision: 2 });
  });

  it("首次保存用 null revision 明确“应不存在”", async () => {
    const { readConfig, writeConfig } = harness({ documents: fakeDocuments() });
    const initial = makeResponse();
    await readConfig.handle(makeRequest(undefined, {}, "GET"), initial.res);
    expect(initial.json()).toEqual({ ok: true, model: "", revision: null });

    const saved = makeResponse();
    await writeConfig.handle(makeRequest({ model: "cfg:new", expectedRevision: null }), saved.res);
    expect(saved.state.status).toBe(200);
    expect(saved.json()).toEqual({ ok: true, model: "cfg:new", revision: 1 });
  });

  it("revision 过期时返回 409，不覆盖新配置", async () => {
    const { writeConfig } = harness({ documents: fakeDocuments("cfg:model") });
    const response = makeResponse();
    await writeConfig.handle(makeRequest({ model: "cfg:stale", expectedRevision: 0 }), response.res);
    expect(response.state.status).toBe(409);
    expect(response.json()).toEqual({ ok: false, error: "配置已被其它窗口修改，请刷新后重试" });
  });

  it("启用企业访问控制后拒绝未登录调用，避免匿名改配置/刷模型", async () => {
    const { rewrite, readConfig, writeConfig } = harness({ documents: fakeDocuments("cfg:model") });
    const rewriteResponse = makeResponse();
    await rewrite.handle(makeRequest(body, { accessControl: true }), rewriteResponse.res);
    expect(rewriteResponse.state.status).toBe(401);
    const readResponse = makeResponse();
    await readConfig.handle(makeRequest(undefined, { accessControl: true }, "GET"), readResponse.res);
    expect(readResponse.state.status).toBe(401);
    const writeResponse = makeResponse();
    await writeConfig.handle(makeRequest({ model: "cfg:x", expectedRevision: 1 }, { accessControl: true }), writeResponse.res);
    expect(writeResponse.state.status).toBe(401);
  });

  it("请求体非法 JSON 或空提示词时返回 400，不提交任务", async () => {
    const tasks = fakeTasks();
    const { rewrite } = harness({ tasks, documents: fakeDocuments("cfg:model") });
    const malformed = makeResponse();
    await rewrite.handle(makeRequest("{"), malformed.res);
    expect(malformed.state.status).toBe(400);
    const empty = makeResponse();
    await rewrite.handle(makeRequest({ ...body, prompt: "  " }), empty.res);
    expect(empty.state.status).toBe(400);
    expect(tasks.submitted).toHaveLength(0);
  });

  it("未配置模型时指向插件设置，而不是静默挑一个模型", async () => {
    const { rewrite } = harness({ documents: fakeDocuments() });
    const response = makeResponse();
    await rewrite.handle(makeRequest(body), response.res);
    expect(response.state.status).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "请先在插件设置中选择快捷改写模型" });
  });

  it("宿主没有 documents 存储时明确失败，不假装可改写", async () => {
    const { rewrite, readConfig } = harness();
    const rewriteResponse = makeResponse();
    await rewrite.handle(makeRequest(body), rewriteResponse.res);
    expect(rewriteResponse.state.status).toBe(503);
    const configResponse = makeResponse();
    await readConfig.handle(makeRequest(undefined, {}, "GET"), configResponse.res);
    expect(configResponse.state.status).toBe(503);
  });
});
