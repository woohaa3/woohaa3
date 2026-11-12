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
  type RemoteToolDefinition,
} from "./chat-client.js";
import { runToolLoop } from "./tool-loop.js";

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
  /**
   * 本轮的宿主 MCP 工具通道（可选）。
   *
   * 返回 null 表示本轮没有可用工具通道（宿主未装配、角色没开工具、或模式不支持写）。
   * 这时适配器只做讨论，绝不假装自己能改作品。
   */
  toolChannel?: (input: AgentAdapterRunInput) => Promise<RemoteToolChannel | null>;
};

/** 一次回合可用的宿主工具通道。 */
export type RemoteToolChannel = {
  /** 执行一次工具调用。 */
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; content: string }>;
  /** 本轮开放的工具声明。 */
  listTools: () => Promise<readonly RemoteToolDefinition[]>;
  /** 收尾（撤销 grant、关闭网关）。幂等。 */
  close: () => Promise<void>;
  /** 本轮真实产生的写入回执；有回执才算"改动已落地"。 */
  receipts: () => readonly { canvasId: string; nodeId?: string; commandId: string; revision?: number }[];
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
    // 工具能力取决于宿主是否装配了通道，与远端会话无关：会话在、通道不在时，
    // 这条连接只可用于文本与讨论，界面据此隐藏作品修改入口。
    const toolCapable = options.toolChannel !== undefined;
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
        tools:
          toolCapable
            ? { state: "ready", checkedAt: null }
            : { state: "unavailable", checkedAt: null, reason: "此宿主未装配画布工具通道" },
      },
      ready,
      capabilities: {
        // 文本交付必须有值：没有它的连接在文本节点处不可选。
        textDelivery: TEXT_DELIVERY,
        discussion: true,
        imageInput: false,
        // 有工具通道才声称支持作品修改：否则界面会让人进导演区，然后每一轮都失败。
        tools: toolCapable,
        // 目标模式随工具能力一起声明：没有工具时进导演区只能干看着。
        ...(toolCapable ? { targets: ["world", "model3d", "canvas-group"] as const } : {}),
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
      // 目标执行模式：只有宿主真的给了工具通道时这些模式才可用。
      //
      // 声明它不会让"没有工具"的部署变可用——`toolChannelFor` 在 `prepared.tools` 为空
      // 时返回 null，回合会如实报 `tool-unavailable`。这里是能力上限，不是承诺。
      targets: ["world", "model3d", "canvas-group"],
      // 声明 true 才能进导演区/模型面板；实际是否可写由每轮的宿主工具集决定。
      tools: options.toolChannel !== undefined,
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
      // 目标执行（导演区/模型/组）：宿主准备了工具集就走工具循环，否则只是讨论。
      // 注意 `toolChannelFor` 是异步的——直接比较 Promise 永远为真，会把所有讨论
      // 回合都送进写路径。
      let channel: RemoteToolChannel | null = null;
      try {
        channel = await toolChannelFor(input);
      } catch (error) {
        // grant 签发失败是**可证明的失败**，不能退化成讨论：用户要的是改作品，
        // 悄悄变成聊天会让他以为改好了。
        return {
          status: "failed",
          error: {
            code: "tool-unavailable",
            message: error instanceof Error ? error.message : "本轮无法获得画布工具授权",
          },
        };
      }
      if (channel !== null) return runTarget(input, messages, model, channel);
      return runDiscussion(input, messages, model);
    },
    async cancel() {
      // 取消由 `signal` 承担（run 里把它传给了 fetch）；这里不需要额外动作。
    },
  };

  /**
   * 目标执行路径：走工具循环，让模型通过宿主 MCP 改画布。
   *
   * 与讨论路径的区别只在"能不能调工具"：两者都是多轮对话，但这里每轮带上工具声明，
   * 模型要求调用时执行并回填。
   *
   * **只有拿到权威回执才算成功**：模型说"改好了"不等于改动落地了——回执来自宿主对
   * 实际写入的确认。这与整个仓库「不假装成功」的口径一致。
   */
  const runTarget = async (
    input: AgentAdapterRunInput,
    messages: RemoteChatMessage[],
    model: string,
    channel: RemoteToolChannel
  ): Promise<AgentAdapterRunOutcome> => {
    try {
      const result = await runToolLoop(messages, {
        turn: async ({ messages: outbound, tools }) => {
          const reply = await chatRemote(options, { model, messages: outbound, tools, signal: input.signal });
          return reply.ok
            ? { ok: true, text: reply.text, toolCalls: reply.toolCalls, finishReason: reply.finishReason }
            : { ok: false, code: reply.code, message: reply.message };
        },
        execute: channel.callTool,
        signal: input.signal,
        onToolCall: (call) => {
          input.emit({ type: "tool-started", tool: call.name, callId: call.id });
        },
        onToolResult: (call) => {
          input.emit({
            type: "tool-completed",
            tool: call.name,
            callId: call.id,
            ok: call.ok,
            ...(call.ok ? {} : { summary: call.content.slice(0, 200) }),
          });
        },
      });
      if (input.signal.aborted) {
        return { status: "cancelled", assistantText: result.text, error: { code: "cancelled", message: "已停止本次生成" } };
      }
      const receipts = channel.receipts();
      if (!result.ok) {
        return {
          status: receipts.length > 0 ? "partial" : "failed",
          assistantText: result.text,
          error: { code: result.code, message: result.message },
          ...(receipts.length > 0 ? { receipt: { kind: "canvas-commands", commands: receipts } } : {}),
        };
      }
      // 目标回合必须至少有一条真实回执：模型可能只聊了两句就结束，那不是"改好了"。
      if (receipts.length === 0) {
        return {
          status: "failed",
          assistantText: result.text,
          error: { code: "write-unconfirmed", message: "助手没有提交任何画布修改；请核对原请求" },
        };
      }
      return {
        status: "succeeded",
        assistantText: result.text,
        receipt: { kind: "canvas-commands", commands: receipts },
      };
    } finally {
      await channel.close().catch(() => undefined);
    }
  };

  /**
   * 取本轮的宿主工具通道。
   *
   * 判据是**动作类型 + 宿主准备的工具集 + 通道实现**，三者缺一不可：
   * - `action === "discuss"` 是纯对话，永远不开工具（即使角色声明了工具）；
   * - `prepared.tools` 为空说明宿主求交后没有可用工具；
   * - 没有通道实现（宿主未装配）时只做讨论。
   *
   * 为什么以 action 优先而不是只看 `prepared.tools`：两者语义不同——工具集是"允许用
   * 哪些"，action 是"这一回合要不要动手"。只看工具集会让讨论回合误入写路径。
   */
  const toolChannelFor = async (input: AgentAdapterRunInput): Promise<RemoteToolChannel | null> => {
    if (options.toolChannel === undefined) return null;
    if (input.intent.action === "discuss") return null;
    const prepared = input.prepared;
    if (!prepared || prepared.tools.length === 0) return null;
    return options.toolChannel(input);
  };

  /**
   * 文本交付路径：无工具一次性候选。
   *
   * 交付层只认 `assistantText` 里的 **纯 JSON 候选**（`decodeAssistantTextCandidate`
   * 要求恰好一个 `text` 键），散文本会判 `candidate-invalid`。所以这里做两件事：
   * 1. 消息里明确给出 schema（见 `messagesOf`）；
   * 2. 拿回正文后再**宽进严出**地抽出 JSON——模型经常加代码围栏或前后解释，
   *    那属于格式噪声，不该让整次生成失败。
   */
  const runCandidate = async (
    input: AgentAdapterRunInput,
    messages: RemoteChatMessage[],
    model: string
  ): Promise<AgentAdapterRunOutcome> => {
    const result = await chatRemote(options, { model, messages, signal: input.signal });
    if (input.signal.aborted) return { status: "cancelled", error: { code: "cancelled", message: "已停止本次生成" } };
    if (!result.ok) return { status: "failed", error: { code: result.code, message: result.message } };
    const extracted = extractJsonObject(result.text);
    if (extracted === null) {
      // 保留原文以便在详情里定位；错误码与交付层一致，便于上层归类。
      return {
        status: "failed",
        assistantText: result.text,
        error: { code: "candidate-invalid", message: "助手未返回结构化文本正文" },
      };
    }
    return { status: "succeeded", assistantText: extracted };
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
/**
 * 把宿主准备的回合输入编译成对话消息。
 *
 * **必须优先使用 `prepared.messages`**：那是宿主与角色定义合成好的规范消息
 * （`definition.instructions` 在最前、领域上下文已注入）。契约写得很直接：
 * 「通道只消费它：不得再按业务 mode 构造角色提示词」。
 *
 * 曾经只用 `intent.prompt`，后果是模型收不到角色的输出契约，于是回一段散文而不是
 * JSON，文本节点报「助手未返回结构化文本正文」。这不是解析太严，而是根本没告诉模型
 * 要输出什么。
 *
 * `intent.prompt` 只作为旧回合的兜底（`prepared` 缺失时）。
 */
function messagesOf(input: AgentAdapterRunInput): RemoteChatMessage[] {
  const messages: RemoteChatMessage[] = [];
  // 历史按 role 原样重放：压平成单条 user 会让 system 指令与先前的助手回复失去身份。
  for (const message of input.history) {
    const role = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user";
    messages.push({ role, content: message.content });
  }
  const prepared = input.prepared;
  if (prepared && prepared.messages.length > 0) {
    for (const message of prepared.messages) {
      messages.push({
        role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
        content: message.content
      });
    }
  } else {
    messages.push({ role: "user", content: input.intent.prompt });
  }
  // 角色的输出契约要求 JSON 时，把 schema 明确告诉模型。
  //
  // 为什么不假设"角色 instructions 里已经写了"：instructions 是给人读的领域描述，
  // 不保证含机器可校验的 schema。缺了这一段，模型会回一段看起来合理但解析不了的散文。
  const output = prepared?.output;
  if (input.candidate && output?.kind === "candidate") {
    messages.push({
      role: "system",
      content: [
        "只输出一个 JSON 对象，不要代码围栏、不要解释。",
        "它必须满足以下 JSON Schema：",
        JSON.stringify(output.schema)
      ].join("\n")
    });
  } else if (input.candidate) {
    // 没有角色声明的 schema 时退回候选的通用契约（`{ text }`）。
    messages.push({
      role: "system",
      content: [
        "只输出一个 JSON 对象，不要代码围栏、不要解释。",
        "它必须满足以下 JSON Schema：",
        JSON.stringify(input.candidate.outputSchema)
      ].join("\n")
    });
  }
  return messages;
}

/** 参考图是否被请求过（用于给出可读的拒绝原因）。 */
export function hasReferenceImages(input: AgentAdapterRunInput): boolean {
  return (input.candidate?.images.length ?? 0) > 0;
}

/**
 * 从模型输出里抽出第一个完整的 JSON 对象。
 *
 * 为什么需要它：交付层的解码器要求**恰好一个 `text` 键的纯对象**，而模型常见三种噪声——
 * 代码围栏（```json … ```）、前后解释（"好的，这是结果："）、以及尾随标点。这些都是
 * 格式问题，不是内容问题；让整次生成因它们失败，用户看到的是"助手未返回结构化文本正文"，
 * 而他明明得到了一段可用正文。
 *
 * 实现是**扫描配对括号**而不是贪婪正则：正文里可能含 `}`（例如写代码），
 * 正则截断会造出半个对象。字符串内的括号与转义也要跳过，否则 `{"text":"a}b"}` 会被截错。
 *
 * 返回重新序列化后的紧凑 JSON；抽不出对象时返回 null（由调用方按失败收敛）。
 */
export function extractJsonObject(raw: string): string | null {
  const text = raw.trim();
  // 去掉整段包裹的代码围栏。
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();

  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = body.slice(start, index + 1);
        try {
          const parsed: unknown = JSON.parse(candidate);
          // 只接受对象：交付层要读 `text` 键，数组或标量没有意义。
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
          return JSON.stringify(parsed);
        } catch {
          // 这一段括号配对但不是合法 JSON（例如正文里的代码片段）：继续往后找下一个对象。
          depth = 0;
          const next = body.indexOf("{", index + 1);
          if (next < 0) return null;
          index = next - 1;
        }
      }
    }
  }
  return null;
}
