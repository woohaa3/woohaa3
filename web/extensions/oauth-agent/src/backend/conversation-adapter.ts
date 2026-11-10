/**
 * ChatGPT 宿主 Agent 会话 adapter
 * （change: 2026-10-12-add-agent-conversation-panel，任务 2.1–2.5 / design D1/D5）。
 *
 * 扩展把**自身已有**的授权、真实账户目录、Codex 推理与生成提交重组成宿主公开的
 * `AgentConversationAdapter`，经宿主 `registerCapability("agent-conversation-adapter:chatgpt")`
 * 装配。宿主通用面板只经会话服务间接使用，不 import 本扩展私有实现。
 *
 * 边界（design D5）：
 * - 授权/目录来自真实账户，目录失败保留原选择、不自动换模型；
 * - 讨论回合不注入 MCP/shell/文件写入/web search 与静态 bearer；历史只当内容；
 * - 目标执行复用既有 generation/commit（expectedContentHash/稳定 requestId/权威回执）；
 * - token 绝不进入宿主 DTO、事件、日志或浏览器；断开回收本 owner 在途工作。
 */
import { CHATGPT_REASONING_EFFORTS, isChatGptReasoningEffort } from "@woohaa3/contracts";
import { preparedPromptText } from "@woohaa3/agent-connections";
import type {
  AgentAdapterAuthState,
  AgentAdapterCapabilities,
  AgentAdapterRunInput,
  AgentAdapterRunOutcome,
  AgentCatalogSnapshot,
  AgentConversationAdapter,
  ChatGptGenerationMode,
  ChatGptGenerationReceipt
} from "@woohaa3/contracts";
import type { ChatGptService } from "./service.js";

export const CHATGPT_CONVERSATION_ADAPTER_ID = "chatgpt";

/** 惰性缓存的真实账户模型目录；只在首次 `models()` 调用时构造。 */
let cachedDefaultCatalog: ChatGptConversationModelCatalog | null = null;
function defaultModelCatalog(): ChatGptConversationModelCatalog {
  if (!cachedDefaultCatalog) {
    cachedDefaultCatalog = {
      list: async (accessToken: string) => {
        const { createChatGptModelCatalog } = await import("./models.js");
        return createChatGptModelCatalog({}).list(accessToken);
      }
    };
  }
  return cachedDefaultCatalog;
}

/**
 * 账户模型目录的可注入形状
 * （change: 2026-10-12-add-agent-conversation-panel，任务 2.1）。
 *
 * 生产缺省用真实账户目录（`createChatGptModelCatalog`，使用当前 owner 的有效凭据查询）；
 * 测试注入 fake，避免协议测试触达真实网络。adapter 只读取 `list`，不持有 token。
 */
export type ChatGptConversationModelCatalog = {
  list: (accessToken: string) => Promise<import("./models.js").ChatGptModelsResult>;
};

export type ChatGptConversationAdapterOptions = {
  service: ChatGptService;
  /**
   * 宿主会话 owner → ChatGPT 凭据 owner 映射。
   *
   * 生产：宿主 `principal.subject` 对应 ChatGPT `principal:<subject>`。缺省即该规则。
   * 本地开发：部署需显式对齐宿主本地会话与 ChatGPT 本地会话身份，避免跨 owner 串号。
   */
  ownerIdFor?: (hostOwner: string) => string;
  /** 账户模型目录覆盖（测试注入 fake；缺省真实账户目录）。 */
  modelCatalog?: ChatGptConversationModelCatalog;
};

export function createChatGptConversationAdapter(
  options: ChatGptConversationAdapterOptions
): AgentConversationAdapter {
  const service = options.service;
  const ownerIdFor = options.ownerIdFor ?? ((owner) => `principal:${owner}`);
  const candidateRuns = new Map<string, { controller: AbortController; done: Promise<unknown> }>();

  const capabilities = (): AgentAdapterCapabilities => ({
    textDelivery: { imageInput: true, maxImages: 12 },
    candidateGeneration: { imageInput: true, maxImages: 12 },
    discussion: true,
    targets: ["model3d", "camera"],
    tools: true,
    models: "remote"
  });

  const authorization = async (input: { owner: string }): Promise<AgentAdapterAuthState> => {
    if (!service.enabled || !service.authorization) return "unavailable";
    const ownerId = ownerIdFor(input.owner);
    const snapshot = service.authorization.snapshot(ownerId, "principal");
    switch (snapshot.state) {
      case "ready":
        return "ready";
      case "authorizing":
        return "authorizing";
      case "connected-without-plan":
      case "reauthorization-required":
        return "reauthorization-required";
      default:
        return "disconnected";
    }
  };

  const models = async (input: { owner: string }): Promise<AgentCatalogSnapshot> => {
    if (!service.enabled || !service.authorization) return { models: [], error: "ChatGPT 授权未配置" };
    const ownerId = ownerIdFor(input.owner);
    if (service.authorization.snapshot(ownerId, "principal").state !== "ready") {
      return { models: [], error: "需要有效的 ChatGPT 订阅授权" };
    }
    try {
      const token = await service.authorization.ensureAccessToken(ownerId);
      const catalog = options.modelCatalog ?? defaultModelCatalog();
      const result = await catalog.list(token);
      if (!result.ok) return { models: [], error: result.message };
      return { models: result.models.map(model => ({ ...model, reasoningEfforts: CHATGPT_REASONING_EFFORTS })) };
    } catch (error) {
      return { models: [], error: error instanceof Error ? error.message : "账户模型目录读取失败" };
    }
  };

  const run = async (input: AgentAdapterRunInput): Promise<AgentAdapterRunOutcome> => {
    if (!service.enabled) {
      return { status: "failed", error: { code: "adapter-unavailable", message: service.disabledReason ?? "ChatGPT 未配置" } };
    }
    const ownerId = ownerIdFor(input.owner);
    if (input.intent.reasoningEffort && !isChatGptReasoningEffort(input.intent.reasoningEffort)) return { status: "failed", error: { code: "capability-unsupported", message: "当前授权模型不支持此思考强度" } };

    // 通道只消费宿主准备好的角色回合。
    const prepared = input.prepared;
    if (!prepared) return { status: "failed", error: { code: "role-not-found", message: "本回合没有宿主准备的角色请求" } };
    // 仅讨论：无工具面、无写能力；历史只当内容（design D2/D5）。
    if (input.intent.action === "discuss") {
      input.emit({ type: "stage", stage: "reasoning" });
      const controller = input.candidate ? new AbortController() : null;
      const abort = () => controller?.abort();
      if (controller) { input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort(); }
      const operation = service.converse({
        requestId: input.requestId,
        prepared,
        ownerId,
        model: input.intent.model ?? "",
        prompt: preparedPromptText(prepared),
        ...((input.candidate?.images ?? input.images)?.length ? { images: (input.candidate?.images ?? input.images)!.map((image, index) => ({ ...image, fileName: `image-${index}`, mimeType: image.contentType })) } : {}),
        ...(input.candidate
          ? { outputSchema: prepared.output.kind === "candidate" ? prepared.output.schema : input.candidate.outputSchema }
          : {}),
        ...(isChatGptReasoningEffort(input.intent.reasoningEffort) ? { reasoningEffort: input.intent.reasoningEffort } : {}),
        history: input.history.map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content })),
        signal: controller?.signal ?? input.signal,
        onStage: (stage) => input.emit({ type: "stage", stage })
      });
      const key = JSON.stringify([input.owner, input.requestId]);
      if (controller) candidateRuns.set(key, { controller, done: operation });
      let result: Awaited<typeof operation>;
      try { result = await operation; }
      finally { if (controller) { input.signal.removeEventListener("abort", abort); candidateRuns.delete(key); } }
      if (!result.ok) return { status: "failed", error: { code: result.code, message: result.message } };
      return { status: "succeeded", assistantText: result.text };
    }

    // 目标执行：复用既有 generation/commit 编排与权威回执。
    if (!service.generation) {
      return { status: "failed", error: { code: "capability-unsupported", message: "ChatGPT 生成未启用" } };
    }
    if (input.intent.mode !== undefined && input.intent.mode !== "model3d") {
      return { status: "failed", error: { code: "capability-unsupported", message: "此连接只支持 3D 模型目标，不能执行文本、导演区或 2D 组创作" } };
    }
    const mode: ChatGptGenerationMode = "model3d";
    if (!input.intent.nodeId) return { status: "failed", error: { code: "malformed-request", message: "目标动作必须带 nodeId" } };
    if (!input.intent.model) return { status: "failed", error: { code: "malformed-request", message: "缺少账户模型，无法生成" } };

    // 每次 `progress.message` 是一条完整回复；累计序号给出稳定的逻辑消息身份。
    let messageSequence = 0;
    const result = await service.generation.generate(
      {
        ownerId,
        requestId: input.requestId,
        canvasId: input.intent.canvasId,
        nodeId: input.intent.nodeId,
        mode,
        model: input.intent.model,
        prompt: input.intent.prompt,
        prepared,
        roleId: prepared.roleRef.namespacedId,
        ...(isChatGptReasoningEffort(input.intent.reasoningEffort) ? { reasoningEffort: input.intent.reasoningEffort } : {}),
        ...(input.intent.expectedContentHash ? { expectedContentHash: input.intent.expectedContentHash } : {}),
        ...(input.intent.cameraId ? { selectedCameraId: input.intent.cameraId } : {}),
        ...(input.intent.clipId ? { clipId: input.intent.clipId } : {}),
        ...(input.intent.itemId ? { itemId: input.intent.itemId } : {})
      },
      (progress) => {
        if (progress.message !== undefined) {
          // 每次 `message` 进度是一条**完整**助手消息（Codex 的 final 事件），不是增量：
          // 用独立 streamId + replace，保证同一轮的多条回复各自成条、不按分片裂开。
          input.emit({
            type: "message",
            role: "assistant",
            content: progress.message,
            delivery: "replace",
            streamId: `chatgpt-message-${++messageSequence}`
          });
          return;
        }
        if (progress.tool) {
          const tool = progress.tool;
          input.emit(tool.status === "started"
            ? { type: "tool-started", tool: tool.name, callId: tool.callId, summary: tool.summary }
            : { type: "tool-completed", tool: tool.name, callId: tool.callId, ok: tool.ok === true, summary: tool.summary });
          return;
        }
        if (progress.stage.startsWith("tool:")) {
          input.emit({ type: "tool-started", tool: progress.stage.slice("tool:".length) });
          return;
        }
        input.emit({ type: "stage", stage: progress.stage, ...(progress.detail ? { detail: progress.detail } : {}) });
      }
    );
    return receiptToOutcome(result.ok ? result.receipt : service.generation.receipt(input.requestId, ownerId));
  };

  const query = async (input: { owner: string; requestId: string }): Promise<AgentAdapterRunOutcome | null> => {
    if (!service.generation) return null;
    const receipt = service.generation.receipt(input.requestId, ownerIdFor(input.owner));
    if (receipt.status === "running") return null;
    return receiptToOutcome(receipt);
  };

  const cancel: NonNullable<AgentConversationAdapter["cancel"]> = async (input): Promise<void> => {
    if (input.candidateContext) {
      const running = candidateRuns.get(JSON.stringify([input.owner, input.requestId]));
      if (!running) throw new Error("无法确认 OAuth 候选执行已停止");
      running.controller.abort();
      await running.done;
      return;
    }
    service.generation?.cancel(ownerIdFor(input.owner), input.requestId);
  };

  return {
    id: CHATGPT_CONVERSATION_ADAPTER_ID,
    capabilities,
    authorization,
    models,
    run,
    // 宿主重启接管：领域回执/执行器 journal 都按 requestId 幂等；重新进入 run 只接回原回合，
    // 不重新推理（daemon `turn.run` 按 turnId 去重）。重复事件由宿主按 content 指纹去重。
    resume: (input) => run(input),
    query,
    cancel
  };
}

/**
 * 领域回执 → 宿主回合结果。
 *
 * succeeded/partial/failed/cancelled 一律来自权威回执，不从助手正文推断；
 * 无法确认的外部工作保留 `outcome-unknown` 错误码，但映射到回合结果时必须是 failed。
 * （change: 2026-10-12-add-agent-conversation-panel，design D7）。
 */
export function receiptToOutcome(receipt: ChatGptGenerationReceipt): AgentAdapterRunOutcome {
  switch (receipt.status) {
    case "succeeded":
      return { status: "succeeded", receipt, ...(receipt.llmOutput !== undefined ? { assistantText: receipt.llmOutput } : {}) };
    case "partial":
      return { status: "partial", receipt, ...(receipt.llmOutput !== undefined ? { assistantText: receipt.llmOutput } : {}) };
    case "failed":
      return { status: "failed", receipt, error: { code: receipt.code, message: receipt.message } };
    case "cancelled":
      return { status: "cancelled", receipt };
    case "unknown":
      return { status: "failed", receipt, error: { code: "outcome-unknown", message: "外部生成结果无法确认；已保留原回执，不自动重试" } };
    default:
      return { status: "failed", receipt, error: { code: "outcome-unknown", message: "外部生成回执无法解析；已保留原回执，不自动重试" } };
  }
}
