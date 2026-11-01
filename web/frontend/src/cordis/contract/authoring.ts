/**
 * 通用 authoring 生成 contribution 契约
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 6.4 / design D9）。
 *
 * 模型/镜头宿主（ModelParameterPanel、镜头区域）通过类型化 slot 接受**生成入口 UI**；
 * 宿主只声明目标身份与门禁，不导入任何具体个人生成插件的面板、service 或协议实现。
 * 贡献方（如 ChatGPT 插件）在自己的作用域内持有 service，并把它闭包进渲染组件。
 *
 * 这里刻意**不**引入 JSON/布局 DSL、module URL、dynamic import 或远程 component loader；
 * 贡献只能是生产构建中静态装配的受信任本地插件。
 */
import type { ComponentType } from "react";
import type { AgentConversationService } from "./agent-conversation.js";
import type { PanelPresentationIntent } from "./model-interaction.js";

/** 生成目标模式。 */
export type AuthoringGenerateMode = "model3d" | "text";

/** A finite domain delivery adapter. Conversation data and presentation remain host owned. */
export type AssistantDeliveryTarget = {
  domain?: {
    requestId: string;
    sourceNodeId: string;
    targetNodeId: string;
    commandId?: string;
  };
  execution?: import("@woohaa3/contracts").AssistantExecutionRef;
  status: import("@woohaa3/contracts").ConversationTurnStatus;
  stage: string;
  reason?: string;
  query(): Promise<{ ok: boolean; error?: string }>;
  cancel?: () => Promise<{ ok: boolean; error?: string }>;
  retry?: () => Promise<{ ok: boolean; error?: string }>;
};

/**
 * 宿主提供给 authoring 生成 contribution 的**受限** props。
 *
 * 不含 raw service、token、Y.Doc 或任意 canonical setter：贡献方自行读取所属插件的作用域
 * service；宿主只提供目标身份、可写性与并发 precondition。
 */
export type AuthoringGenerationProps = {
  /** Reports whether this exact controller owns a nonempty draft or an active submission. */
  onDraftStateChange?: (state: { hasDraft: boolean; busy: boolean }) => void;
  requestPresentation?: (intent: PanelPresentationIntent) => void;
  /** Domain delivery uses the same authoring panel; unfinished delivery locks ordinary edits. */
  initialPrompt?: string;
  deliveryHistory?: AssistantDeliveryTarget;
  canvasId: string;
  nodeId: string;
  mode: AuthoringGenerateMode;
  /** 外侧生成 dock 与聚焦检查器共享执行逻辑，分别组织输入和操作布局。 */
  presentation?: "dock" | "expanded" | "inspector";
  /** 会话可写性（离线/同步未就绪/历史只读时为 false）。 */
  writable: boolean;
  /** 不可写原因（展示用）；可写时为 null。 */
  disabledReason?: string | null;
  /** 模型内容哈希等并发 precondition（可选）。 */
  expectedContentHash?: string;
  /** 打开授权入口（如 Provider 凭据弹窗）；由宿主注入，贡献方只调用。 */
  onAuthorize?: () => void;
  /** 宿主拥有的参考素材 UI，贡献方只决定在生成面板中的呈现位置。 */
  renderers?: Pick<
    import("./model-interaction.js").ModelPanelRenderers,
    "references"
  >;
  /**
   * MCP 相关能力状态与外部连接指引
   * （change: 2026-10-12-add-agent-conversation-panel，任务 5.3 / design D4）。
   *
   * 常驻文字入口（不依赖展开详情）；`blockedReason` 非空表示缺工具阻止生成动作。外部地址复制
   * 仅反馈“已复制”，不代表外部客户端已连接；内置发现状态由后端提供，缺省不在此伪造就绪。
   */
  mcpHint?: {
    label: string;
    text: string;
    serverUrl: string;
    blockedReason?: string | null;
  };
  /**
   * 宿主拥有的来源/连接选择与当前会话注入
   * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 2.4 / design D8）。
   *
   * 宿主（不是贡献方）决定当前生成来源与连接：单一来源可省略选择器；多来源时由宿主按
   * owner-scoped 可见连接渲染选择，并把选定 `connectionId` 注入被渲染的 contribution。
   * 失效选择保留并显示原因，**不**自动切换到别家来源。
   */
  sourceSelection?: {
    /** 可选来源（未配置时可为空；贡献方据 `selectedSourceId` 判定自己是否被渲染）。 */
    sources: ReadonlyArray<{ sourceId: string; label: string }>;
    selectedSourceId: string;
    /** 该来源当前可选连接（不含秘密）。 */
    connections: ReadonlyArray<{
      connectionId: string;
      textDelivery?: import("@woohaa3/contracts").AssistantTextCapabilities;
      binding?: import("@woohaa3/contracts").AgentConnectionBinding;
      label: string;
      ready: boolean;
      modelSelection?: "tool-default" | "explicit";
      models?: ReadonlyArray<import("@woohaa3/contracts").AgentModelView>;
      modelsError?: string;
      /** 配置或凭据变化后，为新的提交生成新的请求身份。 */
      revision?: string;
      /** 不可用原因（展示用）。 */
      reason?: string | null;
    }>;
    /** 当前选定连接（未选定为 null；单连接时宿主可隐式选定）。 */
    selectedConnectionId: string | null;
    /** 选择另一来源（宿主重新解析该来源连接；不自动执行生成）。 */
    onSelectSource: (sourceId: string) => void;
    /** 选择另一连接（不自动执行生成）。 */
    onSelectConnection: (connectionId: string) => void;
    /** 宿主级阻止原因（如活动回合禁止切换），非空时选择器只读展示。 */
    blockedReason?: string | null;
    loading?: boolean;
    error?: string | null;
    onRefresh?: () => void;
  };
  /**
   * 宿主 Agent 会话 service
   * （change: 2026-10-12-add-agent-conversation-panel，任务 4.1/4.3/5.2 / design D6）。
   *
   * 贡献方经它**提交首轮**（建立会话/回合与既有领域提交），并据此在生成面板状态区展示按状态
   * 强化的具名详情动作与摘要。宿主拥有会话事实源；贡献方不自行持久化。
   *
   * 可选：未装配会话能力时（旧入口/测试）不出现详情入口，生成主流程不变。
   */
  agentConversation?: {
    service: AgentConversationService;
    /** 当前目标已有会话（同一节点重复提交时复用，不把旧入口重绑到新会话）。 */
    conversationId?: string | null;
    /** 该会话最近回合（用于状态区摘要与详情定位）。 */
    latestRequestId?: string | null;
    /** 打开该确切回合的详情（只读；宿主切换到详情面板 route）。 */
    onOpenDetail: (input: {
      conversationId: string;
      requestId: string;
      nodeId?: string;
    }) => void;
  };
};

export type AuthoringGenerationComponent =
  ComponentType<AuthoringGenerationProps>;
