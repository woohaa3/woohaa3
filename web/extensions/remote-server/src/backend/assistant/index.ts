/**
 * 远端助手的连接发现与会话适配器。
 *
 * 这两件事放在一起，因为它们共享同一份远端会话事实：连接视图的 `ready` 与执行期的
 * 凭证判据必须回答同一个问题（"现在有没有可用会话"），分开写会漂移成两种结论。
 *
 * 与「Provider 直接当助手」那座桥的区别：那座桥把模型请求交给 `sdk-agent` 的
 * `model-transport`，而它只拨公网地址、并要求一个静态可注入的 API Key。远端一条都
 * 不满足——部署常态在内网、凭据是短生命周期会话令牌。所以这里自己实现 adapter。
 */
import type {
  AgentAdapterRunInput,
  AgentAdapterRunOutcome,
  AgentCatalogSnapshot,
  AgentConnectionModel,
  AgentConnectionProvider,
  AgentConnectionView,
  AgentConversationAdapter,
  GenerationModelPolicySnapshot,
} from "@woohaa3/contracts";
import { REMOTE_SERVER_EXTENSION_ID, REMOTE_ASSISTANT_ADAPTER_ID } from "../../shared.js";
import {
  chatRemote,
  listRemoteChatModels,
  streamRemoteChat,
  type RemoteChatMessage,
  type RemoteChatTransportOptions,
} from "./chat-client.js";

/**
 * 生成侧 Provider id。模型启停策略的键是 `<providerId>:<providerModelId>`，
 * 而远端生成 Provider 注册时用的就是这个 id。
 */
const REMOTE_ASSISTANT_PROVIDER_ID = REMOTE_SERVER_EXTENSION_ID;

/**
 * 全部远端模型共用一条连接。
 *
 * 为什么不是"一个模型一条连接"：连接代表一次授权，远端会话只有一个。按模型拆连接会让
 * 用户在文本节点选了 A 模型、在助手面板却看不到 B 模型——这正是 `agent-connections`
 * 规格里明确不许的"同一来源被投影成互不相识的连接"。
 */
export const REMOTE_ASSISTANT_CONNECTION_ID = "remote-assistant:default";

/** 远端助手声明的文本交付能力。 */
const TEXT_DELIVERY = { imageInput: false, maxImages: 0 } as const;

export type RemoteAssistantOptions = RemoteChatTransportOptions & {
  /** 目录读取结果的缓存时点（毫秒）。目录不必每次点击都拉。 */
  now?: () => number;
  /**
   * 本机模型启停策略（宿主 `ctx.generation.policySnapshot`）。
   *
   * 缺席表示旧宿主：按「全部可用」处理，不假装用户关过什么。
   */
  policy?: () => GenerationModelPolicySnapshot | undefined;
};

export type RemoteAssistant = {
  provider: AgentConnectionProvider;
  adapter: AgentConversationAdapter;
  /** 会话变化时丢弃缓存的目录（登出/切服后不能继续展示旧模型）。 */
  invalidate: () => void;
};

/**
 * 构造连接提供方与会话适配器。
 *
 * 目录读取带 60 秒缓存：助手目录在每次打开面板时都会被读一次，每次都打远端会让面板
 * 明显变慢；但登出、切服时必须立刻失效——旧模型的"可用"是假的。
 */
export function createRemoteAssistant(options: RemoteAssistantOptions): RemoteAssistant {
  const now = options.now ?? (() => Date.now());
  let cache: { at: number; models: readonly AgentConnectionModel[] } | null = null;
  let inflight: Promise<{ models: readonly AgentConnectionModel[]; error?: string }> | null = null;
  const CACHE_MS = 60_000;

  /**
   * 按本机启停策略过滤远端模型。
   *
   * 必须与设置页「生成的模型」开关给出同一个答案：只读上游 `/v1/models` 会让用户在下拉里
   * 看到自己明确关掉的模型——那不是"目录更全"，而是两个界面说了相反的话。
   *
   * 策略语义与 catalog 一致：
   * - 宿主没提供 `policySnapshot`（旧宿主）或 `initialized=false` → 按全部可用处理；
   * - 已初始化但策略里没有这条 → 视为未启用（新接入的 Provider 从未被勾选过）；
   * - `enabled=false` 或 `tombstone` → 不出现。
   *
   * 模型键的形状是 `<providerId>:<providerModelId>`：`remote-server` 的 providerModelId
   * 就是上游模型的稳定 id，与 `/v1/models` 里的一致。
   */
  const filterByPolicy = (models: readonly AgentConnectionModel[]): readonly AgentConnectionModel[] => {
    const snapshot = options.policy?.();
    if (!snapshot || !snapshot.initialized) return models;
    const byKey = new Map(snapshot.models.map((row) => [row.modelKey, row]));
    return models.filter((model) => {
      const row = byKey.get(`${REMOTE_ASSISTANT_PROVIDER_ID}:${model.id}`);
      return row !== undefined && row.enabled && row.tombstone !== true;
    });
  };

  const readModels = async (): Promise<{ models: readonly AgentConnectionModel[]; error?: string }> => {
    if (cache !== null && now() - cache.at < CACHE_MS) {
      // 策略可以随时被用户在设置页改掉，所以缓存只保存上游目录，过滤每次都现算。
      return { models: filterByPolicy(cache.models) };
    }
    if (inflight !== null) return inflight;
    const started = (async () => {
      const result = await listRemoteChatModels(options);
      if (!result.ok) {
        // 失败不清空缓存：一次网络抖动不该让已经可用的模型列表消失。
        return { models: cache === null ? [] : filterByPolicy(cache.models), error: result.message };
      }
      const models: AgentConnectionModel[] = result.models.map((model) => ({
        id: model.id,
        label: model.label,
        source: "user-provided" as const,
        // 远端目录没有"账号已授权"的额外证据：手填来源不得冒充已授权。
        accountAuthorized: false,
      }));
      cache = { at: now(), models };
      return { models: filterByPolicy(models) };
    })().finally(() => {
      if (inflight === started) inflight = null;
    });
    inflight = started;
    return started;
  };

  const buildView = async (): Promise<AgentConnectionView | null> => {
    const session = await options.session();
    if (!session) return null;
    const { models, error } = await readModels();
    const ready = error === undefined && models.length > 0;
    return {
      connectionId: REMOTE_ASSISTANT_CONNECTION_ID,
      adapterId: REMOTE_ASSISTANT_ADAPTER_ID,
      extensionId: REMOTE_SERVER_EXTENSION_ID,
      name: "远端服务端",
      // 远端凭据是宿主内的会话，不是用户填的 Key；接入方式按 api-key 归类，
      // 因为界面上它确实是"已配置凭据"的形态。
      authMode: "api-key",
      runCategory: "agent-sdk",
      configRevision: 1,
      // 会话本身没有 epoch 概念，用 0 表示"随会话变化由 provider 重新计算"。
      credentialEpoch: 0,
      status: {
        transport: { state: error === undefined ? "ready" : "unknown", checkedAt: null },
        credential: { state: "ready", checkedAt: null },
        modelAccess: { state: ready ? "ready" : "unknown", checkedAt: null },
        tools: { state: "unavailable", checkedAt: null, reason: "远端助手不提供画布写工具" },
      },
      ready,
      capabilities: {
        // 文本交付必须有值：没有它的连接在文本节点处不可选。
        textDelivery: TEXT_DELIVERY,
        discussion: true,
        imageInput: false,
        // 明确 false：远端助手没有画布写权限，界面据此说明"不支持作品修改"。
        tools: false,
        structuredResult: false,
        cancel: true,
        resume: false,
      },
      models,
      // 即使目录读失败也保留已缓存的模型；只有完全没读到过才是空列表。
      ...(error !== undefined ? { modelsError: error } : {}),
      credentialConfigured: true,
      ...(error !== undefined ? { reason: error } : {}),
    };
  };

  const provider: AgentConnectionProvider = {
    id: REMOTE_SERVER_EXTENSION_ID,
    async listConnections() {
      const view = await buildView();
      return view === null ? [] : [view];
    },
    async getConnection(input) {
      if (input.connectionId !== REMOTE_ASSISTANT_CONNECTION_ID) return null;
      return buildView();
    },
  };

  const adapter: AgentConversationAdapter = {
    id: REMOTE_ASSISTANT_ADAPTER_ID,
    capabilities: () => ({
      // 同一个 adapter 同时承载文本交付与讨论：文本节点走无工具一次性候选，
      // 讨论走带增量的普通回合，两者共用连接与模型目录。
      textDelivery: TEXT_DELIVERY,
      // 刻意**不**声明 `candidateGeneration`：那是「生成图片候选」的能力
      //（片场/生物等媒体候选走它），远端助手只做文本。
      //
      // 也不能用 TEXT_DELIVERY 的值去填它：契约要求 `maxImages >= 1`
      // （见 isAgentAdapterCapabilities），拿 `maxImages: 0` 去声明会让整份能力
      // 被判非法，表现为助手目录里「Agent adapter 能力声明非法」，所有远端模型
      // 从下拉里消失。这曾真实发生过。
      discussion: true,
      targets: [],
      tools: false,
      models: "remote",
    }),
    async authorization() {
      const session = await options.session();
      return session === null ? "disconnected" : "ready";
    },
    async models(): Promise<AgentCatalogSnapshot> {
      const { models, error } = await readModels();
      // AgentCatalogSnapshot 的 models 是可变数组：复制一份而不是交出缓存的只读视图，
      // 否则调用方一次原地排序就会污染缓存。
      const view = models.map((model) => ({ id: model.id, label: model.label }));
      return error === undefined ? { models: view } : { models: view, error };
    },
    async run(input: AgentAdapterRunInput): Promise<AgentAdapterRunOutcome> {
      const model = input.intent.model?.trim() ?? "";
      if (model === "") {
        return { status: "failed", error: { code: "model-unavailable", message: "请选择有效的助手模型" } };
      }
      const messages = messagesOf(input);
      if (input.candidate) return runCandidate(input, messages, model);
      return runDiscussion(input, messages, model);
    },
    async cancel() {
      // 取消由 `signal` 承担（run 里把它传给了 fetch）；这里不需要额外动作。
    },
  };

  /**
   * 文本交付路径：无工具一次性候选。
   *
   * 必须明确要求结构化输出：`assistant-text-service` 只认 `assistantText` 里的
   * JSON 候选正文，散文本会被判 `candidate-invalid`。
   */
  const runCandidate = async (
    input: AgentAdapterRunInput,
    messages: RemoteChatMessage[],
    model: string
  ): Promise<AgentAdapterRunOutcome> => {
    const result = await chatRemote(options, { model, messages, signal: input.signal });
    if (input.signal.aborted) return { status: "cancelled", error: { code: "cancelled", message: "已停止本次生成" } };
    if (!result.ok) return { status: "failed", error: { code: result.code, message: result.message } };
    return { status: "succeeded", assistantText: result.text };
  };

  /** 讨论路径：逐段增量，允许中途取消。 */
  const runDiscussion = async (
    input: AgentAdapterRunInput,
    messages: RemoteChatMessage[],
    model: string
  ): Promise<AgentAdapterRunOutcome> => {
    let text = "";
    const result = await streamRemoteChat(options, {
      model,
      messages,
      signal: input.signal,
      emit: (delta) => {
        text += delta;
        input.emit({ type: "message", role: "assistant", content: delta });
      },
    });
    if (input.signal.aborted || (!result.ok && result.code === "cancelled")) {
      // 已输出的正文保留：它是真实发生过的产出，不能因为失败就丢掉。
      return { status: "cancelled", assistantText: text, error: { code: "cancelled", message: "已停止本次生成" } };
    }
    if (!result.ok) {
      return { status: "failed", assistantText: text, error: { code: result.code, message: result.message } };
    }
    return { status: "succeeded", assistantText: text };
  };

  return {
    provider,
    adapter,
    invalidate: () => {
      cache = null;
      inflight = null;
    },
  };
}

/**
 * 把宿主提供的回合输入编译成对话消息。
 *
 * 历史在前、本轮提示在后，role 原样保留：压成单条 user 消息会让 system 指令与助手
 * 先前的回复失去身份，模型会表现得像第一次看到这段对话。
 *
 * 参考图明确不支持（`imageInput: false`）：有图片时直接失败而不是静默丢弃——用户会
 * 以为是模型忽略了图，而不是这条通路根本没有传图。
 */
function messagesOf(input: AgentAdapterRunInput): RemoteChatMessage[] {
  const messages: RemoteChatMessage[] = [];
  for (const message of input.history) {
    const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user";
    messages.push({ role, content: message.content });
  }
  messages.push({ role: "user", content: input.intent.prompt });
  return messages;
}

/** 参考图是否被请求过（用于给出可读的拒绝原因）。 */
export function hasReferenceImages(input: AgentAdapterRunInput): boolean {
  return (input.candidate?.images.length ?? 0) > 0;
}
