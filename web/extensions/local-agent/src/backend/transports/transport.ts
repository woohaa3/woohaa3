/**
 * 本机来源会话传输抽象（可注入；测试用本地协议模拟）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 4.2/6.2/6.4 / design D5/D6）。
 *
 * 三种本机协议统一到同一「一次回合」抽象：
 * - Codex App Server：stdio JSON-RPC（`send` 请求、`onMessage` 收通知）；
 * - OpenCode / CodeBuddy：HTTP(+SSE)（`request` 取响应、`onEvent` 收事件）。
 *
 * 真实实现由 `transports/*` 用专用进程与回环 HTTP 完成；测试注入 fake，独立验证
 * 初始化/账号证据、工具面限制、取消与终态映射，不启动真实进程。
 */
import type { AgentNativeCapability, AgentConversationAdapterEvent, AgentAdapterRunOutcome, AgentModelView, AgentConnectionStatus } from "@woohaa3/contracts";
import type { StdioConnection } from "../process-manager.js";

export type LocalAgentTransportId = "codex-appserver" | "opencode-server" | "codebuddy-server";

export type LocalAgentTransportInput = {
  images?: readonly import("@woohaa3/contracts").AgentImageInput[];
  outputSchema?: Record<string, unknown>;
  /** 专用进程的配置目录（隔离）。 */
  configDir: string;
  /** 本轮 cwd；桌面画布目录或隔离的默认目录。 */
  workDir: string;
  /** Trusted desktop canvas workspace: use harness-native file/shell tools. */
  workspace?: boolean;
  /** 回环基地址（HTTP 协议；stdio 为 null）。 */
  loopbackUrl: string | null;
  httpHeaders?: Record<string, string>;
  /** stdio 连接（stdio 协议；HTTP 为 null）。由 process-manager 句柄提供。 */
  stdio: StdioConnection | null;
  model: string;
  reasoningEffort?: import("@woohaa3/contracts").AgentReasoningEffort;
  prompt: string;
  /** 本轮允许的工具（宿主允许面）；讨论回合为空。 */
  allowedTools: readonly string[];
  /** 已准备角色允许的内建能力，缺省关闭。 */
  nativeCapabilities?: readonly AgentNativeCapability[];
  /** 执行器同步写入 journal；路径不进入模型可见消息。 */
  onGeneratedImage?: (image: { savedPath: string; codexHome: string }) => void;
  /** 本轮工具 grant（讨论回合为 null）。 */
  toolToken: string | null;
  /** 受控 MCP 工具 endpoint（讨论回合为 null）。 */
  mcpEndpoint: { name: string; url: string } | null;
  /**
   * 本回合 requestId。Codex 传输在生图事件到达时立刻登记路径，
   * 供回合进行中的导入工具按索引读取。
   */
  turnRequestId?: string;
  /** 续轮原生会话 id（按连接 + epoch 归属）。 */
  resumeNativeId: string | null;
  signal: AbortSignal;
  onEvent: (event: AgentConversationAdapterEvent) => void;
  /** 初始化/账号证据（真实探测；用于状态证据）。 */
  onEvidence?: (evidence: { transport?: "ready" | "unavailable"; credential?: "ready" | "unavailable"; reason?: string }) => void;
};

export type LocalAgentTransportResult =
  | {
      ok: true;
      outcome: AgentAdapterRunOutcome;
      nativeId?: string;
      /**
       * 本回合内建生图产生的产物绝对路径，按到达顺序（change: 2026-11-03-add-codex-image-import）。
       * 仅 Codex 传输填充；不含 base64 内容。
       */
      generatedImagePaths?: string[];
    }
  | { ok: false; code: string; message: string; nativeId?: string };

/** 模型目录探测输入：只打开协议目录，不发送 prompt、不触发生成。 */
export type LocalAgentTransportModelInput = {
  configDir: string;
  workDir: string;
  loopbackUrl: string | null;
  httpHeaders?: Record<string, string>;
  stdio: StdioConnection | null;
};

export type LocalAgentTransport = {
  id: LocalAgentTransportId;
  /** 运行依赖探测（缺 CLI/版本不支持明确报错；不启动进程）。 */
  probe: () => Promise<{ ok: true } | { ok: false; code: "runtime-missing" | "version-unsupported"; message: string }>;
  /**
   * 读取真实模型目录（可选）。未实现时宿主回落到连接记录中的手填模型；
   * 失败 MUST 返回原因，不伪造目录。
   */
  /** Explicit maintenance handshake/account check; never starts a model turn. */
  check?: (input: LocalAgentTransportModelInput) => Promise<AgentConnectionStatus>;
  models?: (input: LocalAgentTransportModelInput) => Promise<{ models: AgentModelView[]; error?: string }>;
  run: (input: LocalAgentTransportInput) => Promise<LocalAgentTransportResult>;
};
