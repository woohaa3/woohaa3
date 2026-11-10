/**
 * 四个固定 Agent 引擎的公共适配器
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 7.1/7.2/7.3 / design D2/D6）。
 *
 * 框架在本机宿主执行（Codex/Claude/OpenCode 使用配套子进程，ADK 在进程内），因此：
 * - **执行前**用显式、可核对的配置限制内建 shell / 任意文件写 / 未授权外部 MCP；无法限制时
 *   拒绝开放执行能力（不以事后事件检查替代限制）；
 * - 显式 API Key 路径：Codex 用实例 `apiKey`（不使用 ChatGPT OAuth 与实例外 env_key）；
 *   Claude 用实例 `env.ANTHROPIC_API_KEY`（不集成其订阅 OAuth）；
 * - 每连接独立 `CODEX_HOME`/工作目录，只读工作目录；不修改全局 `process.env`；
 * - 事件只投影公开文本/工具，不保存隐式推理；
 * - 原生会话 id 由调用方按完整 owner/连接/引擎/凭据代次/会话/目标索引（本模块不持久化）。
 *
 * 真实推理与工具闭环需要对应 CLI 与 API Key，未采集项在 verification 中标注「待人工验证」。
 */
import type { ModelStreamEvent, ModelToolCall, ModelToolDefinition, ModelTurnOutcome } from "../protocol/model-turn.js";
import type { ApplicationToolDelegationFacade } from "@woohaa3/contracts";
import { createTurnObserver } from "@woohaa3/agent-connections";

export type AgentSdkKind = "codex-agent-sdk" | "claude-agent-sdk" | "dsh-agent-sdk" | "gemini-agent-adk";

export type AgentSdkRunInput = {
  images?: readonly import("@woohaa3/contracts").AgentImageInput[];
  outputSchema?: Record<string, unknown>;
  model: string;
  reasoningEffort?: import("@woohaa3/contracts").AgentReasoningEffort;
  prompt: string;
  /** 真实图片附件（本机路径；由调用方落盘到只读工作目录）。 */
  imagePaths?: readonly string[];
  /** 本轮允许的工具（来自宿主允许面）。 */
  tools: readonly ModelToolDefinition[];
  /** 本轮工具 grant（讨论回合为空 → 不注入工具面）。 */
  toolToken?: string;
  toolFacade?: ApplicationToolDelegationFacade;
  /** Woohaa 受控 MCP 工具 endpoint（仅本机回环）。 */
  mcpEndpoint?: { name: string; url: string };
  signal: AbortSignal;
  /** 公开文本投递（`delivery`/`streamId` 原样来自传输，宿主据此聚合分片）。 */
  onText?: (text: string, meta?: { delivery: "append" | "replace"; streamId?: string }) => void;
  onToolCall?: (call: ModelToolCall) => void;
  onToolResult?: (call: ModelToolCall, result: { content: string; isError?: boolean }) => void;
  onStage?: (stage: string, detail?: string) => void;
  /** 原生会话续轮（同连接 + epoch）。 */
  resumeNativeId?: string | null;
};

export type AgentSdkRunResult =
  | { ok: true; outcome: ModelTurnOutcome; nativeId?: string }
  | { ok: false; code: string; message: string; nativeId?: string };

/** 运行时探测结果（缺 CLI/子进程时明确报错，不假装可用）。 */
export type AgentSdkRuntimeProbe = { ok: true } | { ok: false; code: "runtime-missing"; message: string };

export type AgentSdkAdapterOptions = {
  kind: AgentSdkKind;
  /** 显式 API Key（每连接；不使用全局 env）。 */
  apiKey: string;
  /** 隔离配置目录（Codex HOME / Claude 会话目录）。 */
  configDir: string;
  modelBaseUrl?: string;
  resourceKey?: string;
  /** 只读工作目录（不等于用户项目仓库）。 */
  workspaceDir: string;
  /** CLI/可执行入口覆盖（缺省由 SDK 解析）。 */
  executablePath?: string | null;
  /** 运行时探测（缺省按可执行入口判断）。 */
  probeRuntime?: () => Promise<AgentSdkRuntimeProbe>;
  /** 测试注入的底层 query/run 工厂。 */
  transport?: AgentSdkTransport;
  logger?: (event: Record<string, unknown>) => void;
};

/**
 * 底层传输抽象：真实实现分别调用 `@openai/codex-sdk` 与 `@anthropic-ai/claude-agent-sdk`；
 * 测试注入 fake，独立验证事件映射与限制配置，不启动真实子进程。
 */
export type AgentSdkTransport = {
  run: (input: AgentSdkTransportInput) => Promise<AgentSdkTransportResult>;
};

export type AgentSdkTransportInput = {
  images?: readonly import("@woohaa3/contracts").AgentImageInput[];
  outputSchema?: Record<string, unknown>;
  kind: AgentSdkKind;
  /** 显式 API Key（每连接；由适配器注入，不读全局 env）。 */
  apiKey: string;
  modelBaseUrl?: string;
  resourceKey?: string;
  model: string;
  reasoningEffort?: import("@woohaa3/contracts").AgentReasoningEffort;
  prompt: string;
  imagePaths: readonly string[];
  /** 已构建的**执行前限制**配置（内建工具关闭、只允许本轮 MCP 工具、只读工作目录）。 */
  restrictions: AgentSdkRestrictions;
  /** 讨论回合为 null：不注入任何 MCP server。 */
  mcp: { name: string; url: string; bearerToken: string } | null;
  signal: AbortSignal;
  /** 续轮的原生会话 id（缺省新会话）。 */
  resumeNativeId?: string | null;
  onEvent: (event: ModelStreamEvent) => void;
  onNativeId: (nativeId: string) => void;
};

export type AgentSdkTransportResult =
  | { ok: true; assistantText: string; toolCalls: readonly ModelToolCall[]; finishReason: ModelTurnOutcome["finishReason"]; nativeId?: string }
  | { ok: false; code: string; message: string; nativeId?: string };

export type AgentSdkRestrictions = {
  /** 只读沙箱（禁止任意文件写）。 */
  sandboxMode: "read-only";
  approvalPolicy: "never";
  /** 关闭内建 web 搜索/命令执行。 */
  webSearchMode: "disabled";
  /** 内建工具黑名单（shell/文件写/外部 MCP 等）。 */
  disallowedTools: readonly string[];
  /** 仅允许本轮工具（空 = 讨论回合，禁止所有工具）。 */
  allowedTools: readonly string[];
  /** 只读工作目录。 */
  workspaceDir: string;
  /** 不加载用户/项目设置（避免带出其他账号的 MCP/skill/凭据）。 */
  settingSources: readonly [];
  /** 显式 API Key 注入变量名（每连接隔离）。 */
  credentialEnvVar: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "GEMINI_API_KEY" | "WOOHAA_MODEL_API_KEY";
  /** 隔离配置目录变量（Codex HOME / Claude config / Harness home）。 */
  configDirEnvVar: "CODEX_HOME" | "CLAUDE_CONFIG_DIR" | "XDG_CONFIG_HOME" | "DSH_HOME";
};

/**
 * 内建工具名单（执行前黑名单）。
 *
 * Codex：内建 shell/文件写工具名。Claude：`BUILTIN_TOOL_NAMES` 全量（由调用方按安装版本注入
 * 真实名单；此处为保守基线与测试基线）。任何不在 `allowedTools` 的内建能力都在执行前被禁。
 */
/**
 * 运行时自带的 MCP 资源读取工具（`dsh-mcp-resources` 等）。
 *
 * 它们只读、不经过领域网关，也不在 `prepared.tools` 里；模型用它们查看画布资源属于合法动作。
 */
export const MCP_RESOURCE_TOOL_NAMES: readonly string[] = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/**
 * MCP clients may return a server-qualified spelling (`mcp__server__tool`)
 * in their final call list, while the gateway and prepared grant use the
 * original host tool name. Normalize that spelling before applying the
 * authorization check so valid calls do not become false violations.
 */
function canonicalToolName(name: string, allowed: readonly string[]): string {
  if (allowed.includes(name) || !name.startsWith("mcp__")) return name;
  const separator = name.indexOf("__", "mcp__".length);
  if (separator < 0) return name;
  const unqualified = name.slice(separator + 2);
  return allowed.includes(unqualified) ? unqualified : name;
}

export const CODEX_BUILTIN_TOOLS: readonly string[] = ["shell", "exec", "apply_patch", "write_file", "read_file", "web_search"];
export const CLAUDE_BUILTIN_TOOLS: readonly string[] = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Workflow"
];

/** 构建执行前限制配置（纯函数；可独立断言「内建工具不可达」）。 */
export function buildAgentSdkRestrictions(input: {
  kind: AgentSdkKind;
  workspaceDir: string;
  allowedTools: readonly string[];
  /** 覆盖内建名单（按安装版本注入）。 */
  builtinTools?: readonly string[];
}): AgentSdkRestrictions {
  const builtin = input.builtinTools ?? (input.kind === "codex-agent-sdk" ? CODEX_BUILTIN_TOOLS : CLAUDE_BUILTIN_TOOLS);
  return {
    sandboxMode: "read-only",
    approvalPolicy: "never",
    webSearchMode: "disabled",
    disallowedTools: [...builtin],
    allowedTools: [...input.allowedTools],
    workspaceDir: input.workspaceDir,
    settingSources: [],
    credentialEnvVar:
      input.kind === "claude-agent-sdk" ? "ANTHROPIC_API_KEY"
      : input.kind === "gemini-agent-adk" ? "GEMINI_API_KEY"
      : input.kind === "dsh-agent-sdk" ? "WOOHAA_MODEL_API_KEY"
      : "OPENAI_API_KEY",
    configDirEnvVar:
      input.kind === "codex-agent-sdk" ? "CODEX_HOME"
      : input.kind === "claude-agent-sdk" ? "CLAUDE_CONFIG_DIR"
      : input.kind === "dsh-agent-sdk" ? "DSH_HOME"
      : "XDG_CONFIG_HOME"
  };
}

export function createAgentSdkAdapter(options: AgentSdkAdapterOptions) {
  const log = options.logger ?? (() => undefined);

  const probeRuntime = async (): Promise<AgentSdkRuntimeProbe> => {
    if (options.probeRuntime) return options.probeRuntime();
    if (options.executablePath) return { ok: true };
    // 未显式提供入口且未注入探测：视为缺少运行时（真实实现由 SDK 解析 CLI 后再探测）。
    return { ok: false, code: "runtime-missing", message: `未检测到 ${options.kind} 所需的本机运行时（CLI/子进程）` };
  };

  const run = async (input: AgentSdkRunInput): Promise<AgentSdkRunResult> => {
    if (options.apiKey.trim() === "") return { ok: false, code: "credential-missing", message: "该连接尚未保存 API Key" };
    const runtime = await probeRuntime();
    if (!runtime.ok) return { ok: false, code: runtime.code, message: runtime.message };

    const observation = createTurnObserver();
    const discussion = (input.toolToken ?? "") === "";
    const allowedToolNames = discussion ? [] : input.tools.map((tool) => tool.name);
    // MCP 客户端自带的资源读取工具（只读、不写画布）由运行时注入，不在网关领域工具集里；
    // 模型用它们查看画布资源是合法动作，不能按「越权工具」中止整个回合。
    const acceptedToolNames = discussion ? [] : [...allowedToolNames, ...MCP_RESOURCE_TOOL_NAMES];
    const restrictions = buildAgentSdkRestrictions({ kind: options.kind, workspaceDir: options.workspaceDir, allowedTools: allowedToolNames });
    const mcp =
      !discussion && input.mcpEndpoint && input.toolToken
        ? { name: input.mcpEndpoint.name, url: input.mcpEndpoint.url, bearerToken: input.toolToken }
        : null;

    let assistantText = "";
    let toolCalls: ModelToolCall[] = [];
    const transport = options.transport;
    if (!transport) return { ok: false, code: "runtime-missing", message: "未配置 Agent SDK 传输实现" };

    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    let toolViolation: string | null = null;
    try {
    const result = await transport.run({
      kind: options.kind,
      apiKey: options.apiKey,
      ...(options.modelBaseUrl ? { modelBaseUrl: options.modelBaseUrl } : {}),
      ...(options.resourceKey ? { resourceKey: options.resourceKey } : {}),
      model: input.model,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      prompt: input.prompt,
      imagePaths: input.imagePaths ?? [],
      ...(input.images ? { images: input.images } : {}),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
      restrictions,
      mcp,
      signal: controller.signal,
      ...(input.resumeNativeId ? { resumeNativeId: input.resumeNativeId } : {}),
      onNativeId: () => undefined,
      onEvent: (event) => {
        if (event.type === "text-delta") {
          // 公开输出只用于诊断；长正文本身不被应用额度截断。
          observation.addOutput(Buffer.byteLength(event.text, "utf8"));
          // `replace` 是完整正文，不重复累计；增量才追加。
          assistantText = event.delivery === "replace" ? event.text : assistantText + event.text;
          input.onText?.(event.text, { delivery: event.delivery ?? "append", ...(event.streamId ? { streamId: event.streamId } : {}) });
          return;
        }
        if (event.type === "tool-call") {
          // Authorization happens at the MCP gateway before execution, never at this event.
          observation.noteToolCall();
          const name = canonicalToolName(event.call.name, acceptedToolNames);
          if (!acceptedToolNames.includes(name)) {
            toolViolation = event.call.name;
            controller.abort();
            input.onToolResult?.(event.call, { content: "工具不在本轮允许范围", isError: true });
            return;
          }
          input.onToolCall?.(name === event.call.name ? event.call : { ...event.call, name });
          return;
        }
        // Hidden reasoning is never persisted or forwarded as public progress.
        if (event.type === "reasoning-summary") return;
        if (event.type === "error") {
          log({ event: "agent-sdk-error", kind: options.kind, code: event.code });
        }
      }
    });

    const normalizedToolCalls = result.ok
      ? result.toolCalls.map(call => {
        const name = canonicalToolName(call.name, acceptedToolNames);
        return name === call.name ? call : { ...call, name };
      })
      : [];
    const denied = toolViolation ?? normalizedToolCalls.find(call => !acceptedToolNames.includes(call.name))?.name;
    if (denied !== undefined && denied !== null) return { ok: false, code: "capability-unsupported", message: `助手调用了本轮未授权的工具：${denied}` };
    if (input.signal.aborted) return { ok: false, code: "cancelled", message: "回合已停止" };
    if (!result.ok) return { ok: false, code: result.code, message: result.message, ...(result.nativeId ? { nativeId: result.nativeId } : {}) };
    toolCalls = normalizedToolCalls;
    return {
      ok: true,
      outcome: { assistantText: result.assistantText || assistantText, toolCalls, finishReason: result.finishReason },
      ...(result.nativeId ? { nativeId: result.nativeId } : {})
    };
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  };

  return { run, probeRuntime };
}

export type AgentSdkAdapter = ReturnType<typeof createAgentSdkAdapter>;
