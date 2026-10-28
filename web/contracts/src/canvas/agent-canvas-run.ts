/**
 * Agent 节点执行闭环协议
 * （change: add-agent-canvas-authoring-mcp，任务 6.1–6.5 / design D10）。
 *
 * 外部 Agent 发起、查询、取消节点任务并读取输出的类型化、版本化、无副作用契约。
 * MCP Service 只转发类型化意图；Canvas Service 继续负责 catalog 校验、prompt/reference
 * 编译、begin command、Task 提交、取消、latest-run-wins 与终态投影。
 *
 * 关键约束：
 * - run 以 requestId 稳定派生 runId/jobId，MCP 重启后可按 canvas/node/run identity 恢复查询；
 * - status 区分 active / stale / terminal，不把 provider 临时状态声明为成功；
 * - output 对文本返回有界正文，对媒体返回受授权的稳定同源引用与 metadata，**不**返回
 *   COS 凭据、内部 storage key、data/blob URL 或大型 bytes。
 */

export type AgentRunPhase = "queued" | "running" | "terminal";
export type AgentRunTerminalState = "succeeded" | "failed" | "cancelled" | "unknown";

/** 规范 run 视图（structuredContent）。 */
export type AgentRunView = {
  execution?: import("../extension/assistant/assistant-execution.js").AssistantExecutionRef;
  protocolVersion: number;
  canvasId: string;
  nodeId: string;
  runId: string;
  jobId: string;
  phase: AgentRunPhase;
  /** 仅 terminal 时存在。 */
  state?: AgentRunTerminalState;
  progress?: number;
  /** run 已不是节点 active run，且无可用终态证据时标记 stale。 */
  stale: boolean;
  /** 安全终态错误（不包含堆栈、本机路径或 provider 凭据）。 */
  error?: string;
};

/** 文本输出（有界）。 */
export type AgentTextOutput = {
  kind: "text";
  runId: string;
  text: string;
  /** 是否因上限被截断。 */
  truncated: boolean;
  provenance: { canvasId: string; nodeId: string; runId: string; jobId: string };
};

/**
 * 媒体输出：只返回稳定同源引用与安全 metadata。
 *
 * `url` 是受授权的同源相对地址（`/api/media/<storageKey>` 语义），不是 COS 签名 URL；
 * 不返回 storageKey 本身。
 */
export type AgentMediaOutput = {
  kind: "image" | "video" | "audio";
  runId: string;
  url: string;
  contentType: string;
  size: number;
  durationSeconds?: number;
  /** 视频海报的同源引用（若有）。 */
  posterUrl?: string;
  provenance: { canvasId: string; nodeId: string; runId: string; jobId: string };
};

export type AgentNodeOutput = AgentTextOutput | AgentMediaOutput;

export type AgentNodeOutputView =
  | { available: true; output: AgentNodeOutput }
  | {
      available: false;
      /** 稳定原因：未运行/运行中/失败/媒体不可用。 */
      reason: "no-output" | "running" | "failed" | "output-unavailable";
      message: string;
    };

/** Agent 文本输出的字符上限（与任务协议一致）。 */
export const AGENT_TEXT_OUTPUT_MAX_CHARS = 200_000 as const;

/** run 工具的稳定输入。 */
export type AgentRunInput = {
  assistant?: import("../extension/assistant/assistant-text.js").AssistantTextSelection;
  canvasId?: string;
  requestId: string;
  nodeId: string;
  /** 稳定 catalog 身份。 */
  modelKey?: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
};
