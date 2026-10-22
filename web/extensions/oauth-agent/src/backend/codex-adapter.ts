import { mcpToolOutcome } from "./mcp-tool-outcome.js";
/**
 * 用户隔离的 Codex SDK 生成适配器
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.3 / design D4；
 *   change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.1 —— 补齐真实视觉附件传输）。
 *
 * 优先通过 `@openai/codex-sdk` 的 `startThread` / `run` / `runStreamed` 与 `outputSchema`
 * 调用推理；SDK 底层仍启动 Codex CLI 子进程，本模块负责隔离、取消与回收。
 *
 * 隔离边界：
 * - OAuth access token 经 demo provider 配置（`model_providers.<id>.env_key` + 实例 `env`）
 *   传入，**不**作为 SDK 默认 `apiKey`，也**不**修改共享 `process.env`；
 * - 每 owner 独立 `CODEX_HOME`、受限工作目录与 thread 上下文；thread 绑定 canvas/node/mode；
 * - `sandboxMode: "read-only"`、`approvalPolicy: "never"`、`webSearchMode: "disabled"`，
 *   并校验事件中不出现命令执行/文件变更/MCP 工具调用（受控运行 + 结构化输出双重边界）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Codex, type ThreadEvent, type UserInput } from "@openai/codex-sdk";
import type { ChatGptReasoningEffort } from "@woohaa3/contracts";
import { CHATGPT_PROVIDER_ID } from "./config.js";

/** provider 使用的 access token 环境变量名（按 owner 隔离，绝不进共享 env）。 */
export const CHATGPT_ACCESS_TOKEN_ENV = "WOOHAA3_CHATGPT_ACCESS_TOKEN";
/** 受控 MCP 工具面的 bearer 令牌环境变量名（按 owner 隔离）。 */
export const CHATGPT_MCP_BEARER_ENV = "WOOHAA3_CHATGPT_MCP_BEARER";

export type CodexRunEvent =
  | { type: "progress"; stage: string; detail?: string }
  | { type: "tool-started"; tool: string; callId: string }
  | { type: "tool"; tool: string; callId?: string; status: string; ok: boolean; message?: string }
  | { type: "final"; text: string };

/**
 * 真实视觉附件（任务 2.1 / design D2：媒体内容到达模型，而非 URL 文本）。
 *
 * `projectImage` 是服务端可导出到磁盘的稳定字节；true attachment 经 SDK 的
 * `local_image` 输入项传入 Codex CLI，**不**把 URL 或描述塞进文字 prompt。
 */
export type CodexImageAttachment = {
  /** 磁盘安全文件名（不含目录）；由调用方保证唯一。 */
  fileName: string;
  bytes: Uint8Array;
  /** 可选时间戳/来源说明，仅用于可读的文件名提示，不参与语义。 */
  label?: string;
  mimeType?: string;
};

export type CodexAdapter = {
  run: (input: CodexRunInput) => Promise<{ finalResponse: string }>;
  runStreamed: (input: CodexRunInput, onEvent: (event: CodexRunEvent) => void) => Promise<{ finalResponse: string }>;
  /** 取消某 owner 的活动调用（通过 AbortSignal 与 SDK 清理路径）。 */
  cancel: (ownerId: string) => void;
  /** 终止并回收 owner 的推理资源。 */
  disposeOwner: (ownerId: string) => void;
  dispose: () => void;
};

export type CodexRunInput = {
  ownerId: string;
  model: string;
  reasoningEffort?: ChatGptReasoningEffort;
  prompt: string;
  /**
   * 真实图像附件（可选）：落盘到 owner 工作目录后作为 `local_image` 输入项传给 SDK。
   * 仅文字模式仍有 `prompt`；附件仅供声明视觉能力的模型使用。
   */
  images?: readonly CodexImageAttachment[];
  outputSchema?: unknown;
  signal?: AbortSignal;
  /** 本轮受控工具面的 grant 令牌（任务 3.6）；注入实例 env，不进日志。 */
  mcpGrantToken?: string;
  /**
   * 无工具回合（纯讨论）：不注入 MCP 工具面、不使用静态 bearer
   * （change: 2026-10-12-add-agent-conversation-panel，任务 2.3）。
   */
  noTools?: boolean;
};

export type CodexAdapterDependencies = {
  codexHomeDir: string;
  workspaceDir: string;
  /** CLI 入口覆盖（测试注入 fake SDK 时不需要）。 */
  codexBin?: string | null;
  /** 每 owner 读取当前 access token（供换 token 后新调用使用）。 */
  accessTokenFor: (ownerId: string) => Promise<string>;
  /**
   * 受控 MCP 工具面配置（用户调整 2026-10-08，design D4b）。
   *
   * 返回 MCP server 名称与 streamable HTTP URL；可选 bearer 令牌经实例 env（`bearer_token_env_var`）
   * 传入，不进浏览器/日志。缺失时不注入工具面（回退结构化候选）。
   *
   * 注：当前连接的 `/mcp/model-canvas` 与应用既有 Agent 工具板同一信任边界（同源可达）；per-owner
   * 令牌与画布级收窄为后续增强（见 spec/design 的限制说明）。
   */
  mcpTools?: { name: string; url: string; bearerToken?: string } | null;
  /** SDK 工厂（测试注入 fake）；缺省构造真实 `Codex`。 */
  createCodex?: (options: CodexFactoryOptions) => CodexLike;
  logger?: (event: Record<string, unknown>) => void;
};

/** 真实 SDK 与 fake 共用的最小结构。 */
export type CodexLike = {
  startThread: (options: {
    model?: string;
    modelReasoningEffort?: ChatGptReasoningEffort;
    sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
    workingDirectory?: string;
    skipGitRepoCheck?: boolean;
    approvalPolicy?: "never" | "on-request" | "on-failure" | "untrusted";
    webSearchMode?: "disabled" | "cached" | "live";
  }) => CodexThreadLike;
};

export type CodexThreadLike = {
  runStreamed: (
    input: string | UserInput[],
    options: { outputSchema?: unknown; signal?: AbortSignal }
  ) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
};

/** SDK 用户输入项（text / local_image）；测试与调用方可据此断言附件形状。 */
export type CodexUserInput = UserInput;

export type CodexFactoryOptions = {
  env: Record<string, string>;
  config: Record<string, unknown>;
};

function ownerKey(ownerId: string): string {
  // 文件系统安全的短摘要；不再使用原始 owner 文本作目录名。
  return Buffer.from(ownerId, "utf8").toString("base64url").slice(0, 40);
}

/**
 * 构造 owner 隔离的 provider 配置。
 *
 * `env_key` 指向一个 per-owner 环境变量；token 只放进实例 `env`，不修改共享 `process.env`。
 * 不把 token 作为 `apiKey`（SDK 会把 `apiKey` 放到 `CODEX_API_KEY`，语义不同于 OAuth）。
 */
export function buildChatGptProviderConfig(): Record<string, unknown> {
  return {
    model_provider: CHATGPT_PROVIDER_ID,
    [`model_providers.${CHATGPT_PROVIDER_ID}.name`]: "ChatGPT plan",
    [`model_providers.${CHATGPT_PROVIDER_ID}.base_url`]: "https://api.openai.com/v1",
    [`model_providers.${CHATGPT_PROVIDER_ID}.env_key`]: CHATGPT_ACCESS_TOKEN_ENV,
    [`model_providers.${CHATGPT_PROVIDER_ID}.wire_api`]: "responses",
    [`model_providers.${CHATGPT_PROVIDER_ID}.requires_openai_auth`]: false,
    [`model_providers.${CHATGPT_PROVIDER_ID}.supports_websockets`]: false,
    web_search: "disabled",
    // 关闭 codex 内建 shell 工具：本回合只允许经受控 MCP 工具读写画布。codex 0.161 的模型会优先用
    // shell/`exec` 探索工作区（产生 `command_execution` 事件，且对本应用的只读沙箱毫无意义），
    // 这不仅触发我们的边界守卫中止回合，也偏离「只改画布」的目标。关闭后模型直接调用 MCP 工具。
    "features.shell_tool": false
  };
}

/**
 * 把真实图像附件落盘并把 prompt 组装为 SDK `UserInput[]`（任务 2.1）。
 *
 * 无附件时保持既有纯字符串输入（兼容既有请求与 fake SDK）。附件只写到该 owner 的受限工作目录，
 * 且文件名由调用方提供的 `fileName` 决定；路径不回显到 prompt 文本。
 */
export function buildCodexInput(
  prompt: string,
  images: readonly CodexImageAttachment[] | undefined,
  workspaceDir: string
): string | UserInput[] {
  if (!images || images.length === 0) return prompt;
  const attachmentDir = path.join(workspaceDir, "conversion-input");
  mkdirSync(attachmentDir, { recursive: true, mode: 0o700 });
  const items: UserInput[] = [{ type: "text", text: prompt }];
  for (const image of images) {
    const file = path.join(attachmentDir, safeImageName(image.fileName));
    writeFileSync(file, image.bytes, { mode: 0o600 });
    items.push({ type: "local_image", path: file });
  }
  return items;
}

/** 只保留文件名，阻止目录穿越；空名回退稳定名。 */
function safeImageName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, "_");
  return base.length > 0 && base !== "." && base !== ".." ? base : "frame.bin";
}

export function createCodexAdapter(deps: CodexAdapterDependencies): CodexAdapter {
  const log = deps.logger ?? (() => undefined);
  const controllers = new Map<string, AbortController>();

  const factory =
    deps.createCodex ??
    ((options: CodexFactoryOptions) => {
      // 注意：这里只传实例 env/config；SDK 自身仍会注入 CODEX_API_KEY 等必需变量。
      return new Codex({
        ...(deps.codexBin ? { codexPathOverride: deps.codexBin } : {}),
        env: options.env,
        config: options.config as never
      }) as unknown as CodexLike;
    });

  const prepare = async (ownerId: string, grantToken?: string, noTools = false): Promise<CodexLike> => {
    const token = await deps.accessTokenFor(ownerId);
    const home = path.join(deps.codexHomeDir, ownerKey(ownerId));
    const cwd = path.join(deps.workspaceDir, ownerKey(ownerId));
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    // 每 owner 独立 CODEX_HOME 与受限工作目录；token 只进实例 env。
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      CODEX_HOME: home,
      [CHATGPT_ACCESS_TOKEN_ENV]: token
    };
    const config = buildChatGptProviderConfig();
    // 无工具回合：不注入 MCP server（design D5；讨论不借用静态 bearer 或服务权限）。
    const mcp = noTools ? null : deps.mcpTools ?? null;
    if (mcp) {
      config[`mcp_servers.${mcp.name}.url`] = mcp.url;
      config[`mcp_servers.${mcp.name}.startup_timeout_sec`] = 20;
      // 受控工具面授权：写工具带有 `readOnlyHint:false`，codex 的 `auto` 模式仍会要求逐次审批；
      // 由于本进程以 `approvalPolicy: "never"` 运行（非交互），未获批准的工具调用会被直接拒绝
      // （错误：`MCP tool call requires approval, but approval policy is never`），导致模型拿不到
      // 画布上下文并最终返回「未做任何改动」。这里显式 `approve`，即对该 MCP server 的工具一律自动放行；
      // 真正的写入边界仍由宿主 grant（画布/节点/工具范围与预算）在 MCP 工具入口强制。
      config[`mcp_servers.${mcp.name}.default_tools_approval_mode`] = "approve";
      // 每回合 grant 令牌优先于静态令牌（任务 3.6：工具入口据此强制范围与预算）。
      const bearer = grantToken ?? mcp.bearerToken;
      if (bearer) {
        env[CHATGPT_MCP_BEARER_ENV] = bearer;
        config[`mcp_servers.${mcp.name}.bearer_token_env_var`] = CHATGPT_MCP_BEARER_ENV;
      }
    }
    return factory({ env, config });
  };

  const runInternal = async (input: CodexRunInput, onEvent?: (event: CodexRunEvent) => void): Promise<{ finalResponse: string }> => {
    const controller = input.signal ? null : new AbortController();
    const signal = input.signal ?? controller!.signal;
    if (controller) controllers.set(input.ownerId, controller);
    const codex = await prepare(input.ownerId, input.mcpGrantToken, input.noTools === true);
    const workspaceDir = path.join(deps.workspaceDir, ownerKey(input.ownerId));
    const thread = codex.startThread({
      model: input.model,
      ...(input.reasoningEffort === undefined ? {} : { modelReasoningEffort: input.reasoningEffort }),
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      workingDirectory: workspaceDir,
      skipGitRepoCheck: true
    });

    let finalResponse = "";
    const replies: string[] = [];
    try {
      const { events } = await thread.runStreamed(
        buildCodexInput(input.prompt, input.images, workspaceDir),
        { outputSchema: input.outputSchema, signal }
      );
      for await (const event of events) {
        const guard = assertNoToolExecution(event, input.ownerId);
        if (guard) throw new Error(guard);
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          finalResponse = event.item.text;
          replies.push(event.item.text);
          onEvent?.({ type: "final", text: event.item.text });
        } else if (event.type === "item.started" && event.item.type === "mcp_tool_call") {
          onEvent?.({ type: "tool-started", tool: event.item.tool, callId: event.item.id });
        } else if (event.type === "item.completed" && event.item.type === "reasoning") {
          onEvent?.({ type: "progress", stage: "reasoning" });
        } else if (event.type === "item.completed" && event.item.type === "mcp_tool_call") {
          // 受控工具面调用：只转发结果（tools 由后端注入并限制画布范围）。
          onEvent?.({
            type: "tool",
            tool: event.item.tool,
            callId: event.item.id,
            status: event.item.status,
            ...mcpToolOutcome(event.item),
            ...(event.item.error?.message ? { message: event.item.error.message.slice(0, 300) } : {})
          });
        } else if (event.type === "turn.failed") {
          throw new Error(event.error.message);
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    } finally {
      if (controller) controllers.delete(input.ownerId);
    }
    return { finalResponse: input.outputSchema ? finalResponse : replies.join("\n\n") };
  };

  return {
    run: (input) => runInternal(input),
    runStreamed: (input, onEvent) => runInternal(input, onEvent),
    cancel: (ownerId) => {
      const controller = controllers.get(ownerId);
      if (controller) {
        controller.abort();
        controllers.delete(ownerId);
      }
    },
    disposeOwner: (ownerId) => {
      const controller = controllers.get(ownerId);
      if (controller) {
        controller.abort();
        controllers.delete(ownerId);
      }
    },
    dispose: () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      log({ event: "chatgpt-codex-disposed" });
    }
  };
}

/**
 * 受控边界：推理回合 MUST NOT 执行命令或改动文件。
 *
 * MCP 工具调用（`mcp_tool_call`）**允许**——它们是后端按 owner 注入的受控工具面（design D4b），
 * 仍走 Canvas 语义端口。仅声明 read-only/never 或要求输出 JSON 不足以证明边界；这里对事件做强
 * 校验，一旦出现命令执行/文件变更即中止该回合。
 */
export function assertNoToolExecution(event: ThreadEvent, ownerId: string): string | null {
  if (event.type !== "item.completed" && event.type !== "item.started" && event.type !== "item.updated") return null;
  const item = event.item;
  if (item.type === "command_execution") return `推理尝试执行命令，已被拒绝（owner ${ownerId.slice(0, 8)}…）。`;
  if (item.type === "file_change") return "推理尝试修改文件，已被拒绝。";
  return null;
}
