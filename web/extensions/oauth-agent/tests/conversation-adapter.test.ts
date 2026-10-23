/**
 * ChatGPT 宿主 Agent 会话 adapter 协议测试
 * （change: 2026-10-12-add-agent-conversation-panel，任务 2.1–2.5 / 6.1）。
 *
 * 用 fake `ChatGptService` 覆盖 adapter 的公开协议边界，不触达真实网络或真实账户：
 * - 无工具讨论回合（不注入 MCP/shell/web search；历史只当内容）；
 * - 目标执行复用既有 generation/commit，并按授权回执映射 succeeded/partial/failed/cancelled/unknown；
 * - 目录/授权状态映射与“目录失败保留原选择、不自动换模型”；
 * - query/cancel 与 owner 映射；
 * - 事件、DTO、回执中不出现 token。
 */
import { describe, expect, it } from "vitest";
import { CHATGPT_REASONING_EFFORTS } from "@woohaa3/contracts";
import type {
  AgentAdapterRunInput,
  AgentConversationAdapterEvent,
  ChatGptGenerationReceipt
} from "@woohaa3/contracts";
import {
  CHATGPT_CONVERSATION_ADAPTER_ID,
  createChatGptConversationAdapter,
  receiptToOutcome,
  type ChatGptConversationAdapterOptions,
  type ChatGptConversationModelCatalog
} from "../src/backend/conversation-adapter.js";
import type { ChatGptAuthSnapshot } from "@woohaa3/contracts";
import type { ChatGptService } from "../src/backend/service.js";
import type { GenerateRequest, GenerationProgress } from "../src/backend/generation.js";

type SnapshotState = ChatGptAuthSnapshot["state"];

/** 最小 fake service：只实现 adapter 触及的字段面。 */
function fakeService(overrides: {
  enabled?: boolean;
  disabledReason?: string;
  authState?: SnapshotState | null;
  authorization?: boolean;
  generation?: boolean;
  converse?: ChatGptService["converse"];
  generate?: (input: GenerateRequest, onProgress?: GenerationProgress) => Promise<
    { ok: true; receipt: ChatGptGenerationReceipt } | { ok: false; status: number; code: string; message: string }
  >;
  receipt?: (requestId: string, ownerId?: string) => ChatGptGenerationReceipt;
  cancel?: (ownerId: string, requestId: string) => boolean;
} = {}) {
  const calls = {
    snapshot: [] as Array<{ ownerId: string; kind: string }>,
    ensureAccessToken: [] as string[],
    converse: [] as Array<Parameters<ChatGptService["converse"]>[0]>,
    generate: [] as GenerateRequest[],
    receipt: [] as Array<{ requestId: string; ownerId?: string }>,
    cancel: [] as Array<{ ownerId: string; requestId: string }>
  };
  const authorization = overrides.authorization === false
    ? null
    : {
        snapshot(ownerId: string, kind: "principal" | "local-session") {
          calls.snapshot.push({ ownerId, kind });
          return { state: overrides.authState ?? "ready", planEnabled: true, localSession: false, ownerKind: kind } as ChatGptAuthSnapshot;
        },
        async ensureAccessToken(ownerId: string) {
          calls.ensureAccessToken.push(ownerId);
          return "access-token-secret";
        }
      };
  const generation = overrides.generation === false
    ? null
    : {
        async generate(input: GenerateRequest, onProgress?: GenerationProgress) {
          calls.generate.push(input);
          if (overrides.generate) return overrides.generate(input, onProgress);
          return { ok: true as const, receipt: { status: "succeeded" as const, requestId: input.requestId, mode: input.mode, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "cmd-1" } };
        },
        receipt(requestId: string, ownerId?: string) {
          calls.receipt.push({ requestId, ...(ownerId !== undefined ? { ownerId } : {}) });
          return overrides.receipt?.(requestId, ownerId) ?? { status: "unknown" as const, requestId };
        },
        cancel(ownerId: string, requestId: string) {
          calls.cancel.push({ ownerId, requestId });
          return overrides.cancel?.(ownerId, requestId) ?? true;
        }
      };
  const service = {
    enabled: overrides.enabled ?? true,
    ...(overrides.disabledReason ? { disabledReason: overrides.disabledReason } : {}),
    authorization,
    generation,
    converse:
      overrides.converse ??
      (async (input) => {
        calls.converse.push(input);
        return { ok: true as const, text: "讨论回复" };
      })
  } as unknown as ChatGptService;
  return { service, calls };
}

function runInput(overrides: Partial<AgentAdapterRunInput> = {}): AgentAdapterRunInput {
  const events: AgentConversationAdapterEvent[] = [];
  const input: AgentAdapterRunInput = {
    owner: "user-a",
    canvasId: "cv",
    conversationId: "conv-1",
    turnId: "turn-1",
    requestId: "req-1",
    intent: { action: "discuss", canvasId: "cv", prompt: "你好" },
    history: [],
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    ...overrides
  };
  return input;
}

function build(options: ChatGptConversationAdapterOptions) {
  return createChatGptConversationAdapter(options);
}

describe("ChatGPT 会话 adapter · 能力与授权", () => {
  it("转换图片作为真实附件交给无工具讨论，不走画布生成", async () => {
    const { service, calls } = fakeService();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await build({ service }).run(runInput({ images: [{ bytes, contentType: "image/png" }] }))).toMatchObject({ status: "succeeded" });
    expect(calls.converse[0]?.images).toEqual([expect.objectContaining({ bytes, mimeType: "image/png" })]);
    expect(calls.generate).toEqual([]);
  });
  it("passes trusted structured images and schema through the same no-tools assistant", async () => {
    const { service, calls } = fakeService();
    const candidate = { images: [{ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }], outputSchema: { type: "object" } };
    expect(await build({ service }).run(runInput({ candidate }))).toMatchObject({ status: "succeeded" });
    expect(calls.converse[0]).toMatchObject({ outputSchema: candidate.outputSchema, images: [{ bytes: candidate.images[0].bytes, mimeType: "image/png" }] });
    expect(calls.generate).toEqual([]);
  });
  it("声明讨论/工具与模型/片场/镜头目标，目录来源为真实账户", () => {
    const { service } = fakeService();
    const adapter = build({ service });
    expect(adapter.id).toBe(CHATGPT_CONVERSATION_ADAPTER_ID);
    expect(adapter.capabilities()).toEqual({
      candidateGeneration: { imageInput: true, maxImages: 12 },
      discussion: true,
      targets: ["model3d", "film-set", "camera"],
      tools: true,
      models: "remote"
    });
  });

  it("授权状态映射真实账户状态（不携带 token）", async () => {
    for (const [state, expected] of [
      ["ready", "ready"],
      ["authorizing", "authorizing"],
      ["connected-without-plan", "reauthorization-required"],
      ["reauthorization-required", "reauthorization-required"],
      ["disconnected", "disconnected"]
    ] as const) {
      const { service, calls } = fakeService({ authState: state });
      const adapter = build({ service });
      expect(await adapter.authorization({ owner: "user-a" })).toBe(expected);
      expect(calls.snapshot[0]).toEqual({ ownerId: "principal:user-a", kind: "principal" });
    }
  });

  it("未配置授权或服务禁用时报 unavailable", async () => {
    const noAuth = fakeService({ authorization: false });
    expect(await build({ service: noAuth.service }).authorization({ owner: "u" })).toBe("unavailable");
    const disabled = fakeService({ enabled: false });
    expect(await build({ service: disabled.service }).authorization({ owner: "u" })).toBe("unavailable");
  });
});

describe("ChatGPT 会话 adapter · 账户目录", () => {
  it("未就绪时返回需授权原因，不读取目录、不使用其它模型", async () => {
    const { service, calls } = fakeService({ authState: "disconnected" });
    let catalogCalls = 0;
    const modelCatalog: ChatGptConversationModelCatalog = {
      list: async () => {
        catalogCalls += 1;
        return { ok: true, models: [] };
      }
    };
    const result = await build({ service, modelCatalog }).models({ owner: "u" });
    expect(result.models).toEqual([]);
    expect(result.error).toContain("授权");
    expect(catalogCalls).toBe(0);
    expect(calls.ensureAccessToken).toHaveLength(0);
  });

  it("就绪时用当前 owner 凭据读取真实目录", async () => {
    const { service, calls } = fakeService();
    let seenToken = "";
    const modelCatalog: ChatGptConversationModelCatalog = {
      list: async (token) => {
        seenToken = token;
        return { ok: true, models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }] };
      }
    };
    const result = await build({ service, modelCatalog }).models({ owner: "user-a" });
    expect(result.models).toEqual([{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", reasoningEfforts: CHATGPT_REASONING_EFFORTS }]);
    expect(seenToken).toBe("access-token-secret");
    expect(calls.ensureAccessToken).toEqual(["principal:user-a"]);
  });

  it("目录读取失败返回原因，保留原选择且不自动换模型", async () => {
    const { service } = fakeService();
    const modelCatalog: ChatGptConversationModelCatalog = {
      list: async () => ({ ok: false, message: "读取账户模型失败（HTTP 500）" })
    };
    const result = await build({ service, modelCatalog }).models({ owner: "u" });
    expect(result.models).toEqual([]);
    expect(result.error).toContain("HTTP 500");
  });

  it("目录抛错时给出可读原因且不泄漏 token", async () => {
    const { service } = fakeService();
    const modelCatalog: ChatGptConversationModelCatalog = {
      list: async () => {
        throw new Error("网络不可用");
      }
    };
    const result = await build({ service, modelCatalog }).models({ owner: "u" });
    expect(result.error).toBe("网络不可用");
    expect(JSON.stringify(result)).not.toContain("access-token-secret");
  });
});

describe("ChatGPT 会话 adapter · 无工具讨论", () => {
  it("discuss 走 converse，历史只当内容，无工具与写许可", async () => {
    const { service, calls } = fakeService();
    const adapter = build({ service });
    const events: AgentConversationAdapterEvent[] = [];
    const outcome = await adapter.run(
      runInput({
        intent: { action: "discuss", canvasId: "cv", nodeId: "n1", model: "gpt-6.1-sol", prompt: "解释一下" },
        history: [
          { messageId: "m1", conversationId: "conv-1", turnId: "t0", requestId: "r0", role: "user", content: "前一个问题", truncated: false, sequence: 1, createdAt: "t" },
          { messageId: "m2", conversationId: "conv-1", turnId: "t0", requestId: "r0", role: "assistant", content: "前一个回答", truncated: false, sequence: 2, createdAt: "t" }
        ],
        emit: (event) => events.push(event)
      })
    );
    expect(outcome).toEqual({ status: "succeeded", assistantText: "讨论回复" });
    expect(calls.converse).toHaveLength(1);
    expect(calls.converse[0]).toMatchObject({
      ownerId: "principal:user-a",
      model: "gpt-6.1-sol",
      prompt: "解释一下",
      history: [
        { role: "user", content: "前一个问题" },
        { role: "assistant", content: "前一个回答" }
      ]
    });
    // 讨论不触达 generation（无目标提交）。
    expect(calls.generate).toHaveLength(0);
    // 至少发出推理阶段，界面不伪造 token 流。
    expect(events.some((event) => event.type === "stage")).toBe(true);
  });

  it("discuss 不传 model 时仍按所给 prompt 调用（不静默换模型）", async () => {
    const { service, calls } = fakeService();
    await build({ service }).run(runInput({ intent: { action: "discuss", canvasId: "cv", prompt: "x" } }));
    expect(calls.converse[0]!.model).toBe("");
  });

  it("discuss 失败映射稳定错误码", async () => {
    const { service } = fakeService({ converse: async () => ({ ok: false, code: "authorization-required", message: "未授权" }) });
    const outcome = await build({ service }).run(runInput({ intent: { action: "discuss", canvasId: "cv", prompt: "x" } }));
    expect(outcome).toEqual({ status: "failed", error: { code: "authorization-required", message: "未授权" } });
  });

  it("服务禁用时讨论返回 adapter-unavailable", async () => {
    const { service } = fakeService({ enabled: false, disabledReason: "ChatGPT 未配置" });
    const outcome = await build({ service }).run(runInput());
    expect(outcome).toMatchObject({ status: "failed", error: { code: "adapter-unavailable", message: "ChatGPT 未配置" } });
  });
});

describe("ChatGPT 会话 adapter · 目标执行", () => {
  it("generate 复用既有 generation/commit 并透传目标身份与 precondition", async () => {
    const { service, calls } = fakeService();
    const adapter = build({ service });
    const events: AgentConversationAdapterEvent[] = [];
    const outcome = await adapter.run(
      runInput({
        intent: {
          action: "generate",
          canvasId: "cv",
          nodeId: "n1",
          mode: "camera",
          model: "gpt-6.1-sol",
          prompt: "调整镜头",
          cameraId: "cam-9",
          clipId: "clip-3",
          expectedContentHash: "hash-abc"
        },
        emit: (event) => events.push(event)
      })
    );
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(calls.generate).toHaveLength(1);
    expect(calls.generate[0]).toMatchObject({
      ownerId: "principal:user-a",
      requestId: "req-1",
      canvasId: "cv",
      nodeId: "n1",
      mode: "camera",
      model: "gpt-6.1-sol",
      prompt: "调整镜头",
      selectedCameraId: "cam-9",
      clipId: "clip-3",
      expectedContentHash: "hash-abc"
    });
  });

  it("工具阶段事件从 generation 进度投影为 tool-started（有界摘要）", async () => {
    const { service } = fakeService({
      generate: async (input, onProgress) => {
        onProgress?.({ requestId: input.requestId, stage: "tool:submit_model_script" });
        onProgress?.({ requestId: input.requestId, stage: "committing", detail: "写入画布" });
        return { ok: true, receipt: { status: "succeeded", requestId: input.requestId, mode: input.mode, canvasId: input.canvasId, nodeId: input.nodeId, commandId: "c" } };
      }
    });
    const events: AgentConversationAdapterEvent[] = [];
    await build({ service }).run(
      runInput({ intent: { action: "generate", canvasId: "cv", nodeId: "n1", mode: "model3d", model: "m", prompt: "p" }, emit: (e) => events.push(e) })
    );
    expect(events).toContainEqual({ type: "tool-started", tool: "submit_model_script" });
    expect(events).toContainEqual({ type: "stage", stage: "committing", detail: "写入画布" });
  });

  it("缺少模式/节点/模型时在执行前拒绝", async () => {
    const { service, calls } = fakeService();
    const adapter = build({ service });
    // mode 缺省由 nodeId 推导为 model3d（合法）：无 nodeId 且无 mode 才是 malformed。
    const missingMode = await adapter.run(runInput({ intent: { action: "generate", canvasId: "cv", model: "m", prompt: "p" } }));
    expect(missingMode).toMatchObject({ status: "failed", error: { code: "malformed-request" } });
    const missingNode = await adapter.run(runInput({ intent: { action: "generate", canvasId: "cv", mode: "model3d", model: "m", prompt: "p" } }));
    expect(missingNode).toMatchObject({ status: "failed", error: { code: "malformed-request" } });
    const missingModel = await adapter.run(runInput({ intent: { action: "generate", canvasId: "cv", nodeId: "n1", mode: "model3d", prompt: "p" } }));
    expect(missingModel).toMatchObject({ status: "failed", error: { code: "malformed-request" } });
    expect(calls.generate).toHaveLength(0);
  });

  it("mode 缺省时由 nodeId 推导为 model3d", async () => {
    const { service, calls } = fakeService();
    const outcome = await build({ service }).run(
      runInput({ intent: { action: "generate", canvasId: "cv", nodeId: "n1", model: "m", prompt: "p" } })
    );
    expect(outcome).toMatchObject({ status: "succeeded" });
    expect(calls.generate[0]!.mode).toBe("model3d");
  });

  it("生成未启用时报 capability-unsupported", async () => {
    const { service } = fakeService({ generation: false });
    const outcome = await build({ service }).run(
      runInput({ intent: { action: "generate", canvasId: "cv", nodeId: "n1", mode: "model3d", model: "m", prompt: "p" } })
    );
    expect(outcome).toMatchObject({ status: "failed", error: { code: "capability-unsupported" } });
  });

  it("generate 失败时按权威回执结算，而不是助手正文", async () => {
    const { service, calls } = fakeService({
      generate: async () => ({ ok: false, status: 409, code: "request-id-conflict", message: "输入不一致" }),
      receipt: () => ({ status: "failed", requestId: "req-1", mode: "model3d", code: "commit-conflict", message: "内容已被修改" })
    });
    const outcome = await build({ service }).run(
      runInput({ intent: { action: "generate", canvasId: "cv", nodeId: "n1", mode: "model3d", model: "m", prompt: "p" } })
    );
    expect(outcome).toEqual({ status: "failed", receipt: expect.objectContaining({ status: "failed" }), error: { code: "commit-conflict", message: "内容已被修改" } });
    expect(calls.receipt[0]).toEqual({ requestId: "req-1", ownerId: "principal:user-a" });
  });
});

describe("ChatGPT 会话 adapter · 回执映射", () => {
  it("权威回执状态映射为宿主回合结果", () => {
    expect(receiptToOutcome({ status: "succeeded", requestId: "r", mode: "model3d", canvasId: "cv", nodeId: "n", commandId: "c", llmOutput: "done" }))
      .toMatchObject({ status: "succeeded", assistantText: "done" });
    expect(receiptToOutcome({ status: "partial", requestId: "r", mode: "model3d", canvasId: "cv", nodeId: "n", applied: ["model"], failed: [{ part: "camera", code: "x", message: "y" }] }))
      .toMatchObject({ status: "partial" });
    expect(receiptToOutcome({ status: "failed", requestId: "r", mode: "model3d", code: "c", message: "m" }))
      .toEqual({ status: "failed", receipt: expect.objectContaining({ status: "failed" }), error: { code: "c", message: "m" } });
    expect(receiptToOutcome({ status: "cancelled", requestId: "r", mode: "model3d" })).toMatchObject({ status: "cancelled" });
    expect(receiptToOutcome({ status: "unknown", requestId: "r" })).toMatchObject({ status: "unknown" });
  });

  it("回执不含 token", () => {
    const outcome = receiptToOutcome({ status: "succeeded", requestId: "r", mode: "model3d", canvasId: "cv", nodeId: "n", commandId: "c" });
    expect(JSON.stringify(outcome)).not.toMatch(/token|secret/i);
  });
});

describe("ChatGPT 会话 adapter · 查询/取消/owner", () => {
  it("query 在运行中返回 null，终态返回权威结果", async () => {
    const running = fakeService({ receipt: () => ({ status: "running", requestId: "r", stage: "reasoning" }) });
    expect(await build({ service: running.service }).query!({ owner: "u", requestId: "r" })).toBeNull();
    const done = fakeService({ receipt: () => ({ status: "succeeded", requestId: "r", mode: "model3d", canvasId: "cv", nodeId: "n", commandId: "c" }) });
    expect(await build({ service: done.service }).query!({ owner: "u", requestId: "r" })).toMatchObject({ status: "succeeded" });
  });

  it("生成未启用时 query 返回 null", async () => {
    const { service } = fakeService({ generation: false });
    expect(await build({ service }).query!({ owner: "u", requestId: "r" })).toBeNull();
  });

  it("cancel 经 owner 映射转发到 generation", async () => {
    const { service, calls } = fakeService();
    await build({ service }).cancel!({ owner: "user-a", requestId: "req-9" });
    expect(calls.cancel).toEqual([{ ownerId: "principal:user-a", requestId: "req-9" }]);
  });

  it("ownerIdFor 覆盖宿主 owner → 凭据 owner 规则", async () => {
    const { service, calls } = fakeService();
    const adapter = build({ service, ownerIdFor: (owner) => `local:${owner}` });
    await adapter.authorization({ owner: "abc" });
    expect(calls.snapshot[0]!.ownerId).toBe("local:abc");
  });
});


describe("ChatGPT 会话 adapter · 混合事件流", () => {
  it("按原顺序发出中间消息、工具开始/失败与最终消息，保留权威终态汇总", async () => {
    const events: AgentConversationAdapterEvent[] = [];
    const { service } = fakeService({ generate: async (input, progress) => {
      progress?.({ requestId: input.requestId, stage: "message", message: "先读取模型" });
      progress?.({ requestId: input.requestId, stage: "tool:get_model_node", tool: { name: "get_model_node", callId: "call-1", status: "started" } });
      progress?.({ requestId: input.requestId, stage: "tool:get_model_node", tool: { name: "get_model_node", callId: "call-1", status: "failed", ok: false, summary: "节点不存在" } });
      progress?.({ requestId: input.requestId, stage: "message", message: "需要重新选择节点" });
      return { ok: true, receipt: { status: "partial", requestId: input.requestId, mode: "model3d", canvasId: input.canvasId, nodeId: input.nodeId, applied: [], failed: [], llmOutput: "先读取模型\n\n需要重新选择节点" } };
    } });
    const outcome = await build({ service }).run(runInput({
      intent: { action: "generate", canvasId: "cv", nodeId: "n", mode: "model3d", model: "m", prompt: "修改模型" },
      emit: (event) => events.push(event)
    }));
    // 每次 `message` 进度是一条完整回复：用不同 streamId + replace，各自成条。
    expect(events).toEqual([
      { type: "message", role: "assistant", content: "先读取模型", delivery: "replace", streamId: "chatgpt-message-1" },
      { type: "tool-started", tool: "get_model_node", callId: "call-1", summary: undefined },
      { type: "tool-completed", tool: "get_model_node", callId: "call-1", ok: false, summary: "节点不存在" },
      { type: "message", role: "assistant", content: "需要重新选择节点", delivery: "replace", streamId: "chatgpt-message-2" }
    ]);
    expect(outcome.status).toBe("partial");
    expect(outcome.assistantText).toBe("先读取模型\n\n需要重新选择节点");
    expect(outcome.receipt).toHaveProperty("llmOutput", "先读取模型\n\n需要重新选择节点");
  });
});


describe("思考强度边界", () => {
  it("讨论与目标执行保留显式强度，不支持的强度在推理前拒绝", async () => {
    const { service, calls } = fakeService();
    const adapter = build({ service });
    await adapter.run(runInput({ intent: { action: "discuss", canvasId: "cv", prompt: "你好", model: "gpt-5", reasoningEffort: "high" } }));
    expect(calls.converse[0]).toMatchObject({ model: "gpt-5", reasoningEffort: "high" });
    await adapter.run(runInput({ intent: { action: "modify", canvasId: "cv", nodeId: "n1", mode: "model3d", prompt: "修改", model: "gpt-5", reasoningEffort: "low" } }));
    expect(calls.generate[0]).toMatchObject({ model: "gpt-5", reasoningEffort: "low" });
    expect(await adapter.run(runInput({ intent: { action: "discuss", canvasId: "cv", prompt: "你好", reasoningEffort: "none" } }))).toMatchObject({ status: "failed", error: { code: "capability-unsupported" } });
    expect(calls.converse).toHaveLength(1);
  });
});
