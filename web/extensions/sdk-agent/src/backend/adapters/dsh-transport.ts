/**
 * DeepSeek Harness（dsh）SDK 传输
 * （change: 2026-10-17-unify-agent-tool-and-sdk-runtimes）。
 *
 * 每轮一个**独立** runtime 子进程：`DSH_HOME` 指向本轮私有目录，`--patch` 注入本轮生成的
 * 最小 profile 补丁，回合结束即销毁目录。模型路由、凭据、MCP grant 与并发上下文都不跨轮
 * 或跨 owner 泄漏（与 OpenCode 每轮独立 Server 同构）。
 *
 * 隔离要点（均在真实 runtime 上验证过）：
 * - 模型请求只经宿主 loopback 转发器：自定义 `openai-completions` route 的 `baseURL` 指向它，
 *   `apiKeyEnv` 只放短期 token；不启用官方账号/OAuth 发现插件，避免读到宿主已登录凭据；
 * - 工具面只有 `dsh-mcp-client` 指向宿主受控网关；base profile 的内建 bash/fs/web/skill/
 *   subagent/todo/goal/command 插件全部显式 `disabled`，模型可见工具只剩受控 MCP 与其资源辅助项；
 * - 每轮目录、补丁与短期 token 都在 `finally` 中销毁。
 *
 * 已知限制：dsh 的 wire 协议**没有回合级 cancel**，中断只能关闭整个 runtime。宿主取消时
 * 我们关闭 runtime 并以 `cancelled` 结束，绝不把已流出的部分文本当成成功。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { AgentSdkTransport } from "./agent-sdk-adapter.js";
import type { ModelToolCall } from "../protocol/model-turn.js";

const require = createRequire(import.meta.url);

/**
 * dsh 把 `Symbol` 当作跨包服务 key（`dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER`）。
 * pnpm 的 peer 变体会把同一版本装成多个实例，Symbol 随之不等，
 * `agent-loop` 取不到 tools 的调度器，**所有工具调用**都会以
 * `Cannot read properties of undefined (reading 'prepare')` 失败。
 *
 * 因此 workspace 的 Cordis 版本须满足 dsh 的 peer 范围，并在生产部署中复核单实例。
 * 运行时使用包管理器已安装的依赖，不在启动时安装另一套 npm 依赖。
 */
/**
 * dsh 的 bin 入口用 `import.meta.main` 自启，而该属性只在 Node >= 24 存在。
 * 通过显式调用 `runCli()` 的启动器，使 Node 22/23 也能运行同一 runtime。
 *
 * 启动器写在每轮私有目录里，因此必须用**绝对**路径引用 runtime：
 * 子进程的解析根不是扩展包，裸标识符会失败。`dshBin` 只接受文件系统路径。
 */
function launcherSource(entryPath: string): string {
  const entryUrl = pathToFileURL(entryPath).href;
  return [
    "process.argv = [process.argv[0], 'dsh', ...process.argv.slice(2)];",
    `const { runCli } = await import(${JSON.stringify(entryUrl)});`,
    "await runCli();",
    ""
  ].join("\n");
}

/** base profile 里必须关闭的内建能力（shell/文件写入/搜索/技能/子代理/任务与命令面）。 */
export const DSH_DISABLED_PLUGINS: readonly string[] = [
  "tool-bash",
  "tool-pwsh",
  "tool-jobs",
  "tool-fs",
  "tool-fs-search",
  "tool-skill",
  "tool-todo",
  "tool-goal",
  "tool-web",
  "tool-subagent",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent-fork",
  "tool-workflow",
  "tool-plugin-manager",
  "tool-working-directory",
  "plan-mode",
  "skill",
  "skill-filesystem",
  "skill-badge",
  "agent-instructions",
  "commands",
  "command-feedback",
  "command-compact",
  "command-goal",
  // sdk profile 0.2.2 adds these model-facing built-ins. Keep the transport
  // surface limited to the host-controlled MCP gateway.
  "schedule",
  "tool-schedule",
  "tool-ask-user",
  "present"
];

/** dsh 运行时入口（绝对文件路径）；缺依赖时由调用方报 runtime-missing。 */
export function dshRuntimeEntry(): string {
  return path.join(path.dirname(require.resolve("@deepseek-ai/dsh/package.json")), "lib", "bin.js");
}

export function dshExecutable(): string {
  return require.resolve("@deepseek-ai/dsh/package.json");
}

/**
 * dsh 的可选原生包（`node-addon-*-<platform>`）与加载器分属 pnpm 的全局虚拟仓；
 * 加载器从自己的目录 `require` 平台包，默认解析不到 require-builtin 的同级目录。
 * 这里只把 dsh 自己的依赖目录挂到子进程 `NODE_PATH`，不暴露宿主模块，也不改共享 store。
 */
function dshNativeModulesPath(entry: string): string | undefined {
  try {
    const dshRequire = createRequire(entry);
    return path.dirname(path.dirname(dshRequire.resolve("node-addon-require-builtin/package.json")));
  } catch {
    return undefined;
  }
}

/** 运行时入口是否存在（不启动进程）；供 fixed-engine-runtime 探测。 */
export const dshRuntimePath = dshRuntimeEntry;

/**
 * 单轮模型输出预算。
 *
 * dsh 的缺省输出额度是 32768。导演区「一次生成整座建筑」这类长脚本很容易写满额度：截断后
 * 工具调用不完整，回合却按正常结束处理，宿主只能报成未确认写入。这里显式声明更大的预算，
 * 并允许部署用 `WOOHAA3_SDK_AGENT_MAX_OUTPUT_TOKENS` 调整（代理或模型真实上限更小时调回）。
 */
export const DSH_DEFAULT_MAX_OUTPUT_TOKENS = 65536;

export function readDshMaxOutputTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.WOOHAA3_SDK_AGENT_MAX_OUTPUT_TOKENS ?? "").trim();
  const parsed = Number(raw);
  return raw !== "" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DSH_DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * 模型上下文窗口（输入 + 输出的总预算）。
 *
 * dsh 用它做容量判断、压缩触发与溢出识别；缺省是 262144。声明得偏小会让运行时低估容量，
 * 也会让压缩的 `W − O − B` 直接变成负数（例如 128000 配 65536 输出预留时压缩失效）。
 * 部署可用 `WOOHAA3_SDK_AGENT_CONTEXT_WINDOW` 按实际接入的模型调整。
 */
export const DSH_DEFAULT_CONTEXT_WINDOW = 262144;

export function readDshContextWindow(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.WOOHAA3_SDK_AGENT_CONTEXT_WINDOW ?? "").trim();
  const parsed = Number(raw);
  return raw !== "" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DSH_DEFAULT_CONTEXT_WINDOW;
}

/**
 * 本轮 profile 补丁。
 *
 * 只复用 base 已挂载的 `llm-pi-ai` 适配器（再插一个实例会让 route 注册冲突），
 * 关闭全部内建工具插件，并且只在有受控网关时插入 `dsh-mcp-client`。
 */
export function buildDshPatch(input: {
  modelBaseUrl: string;
  model: string;
  apiKeyEnv: string;
  maxTokens?: number;
  contextWindow?: number;
  mcp: { name: string; url: string; bearerToken: string } | null;
}): string {
  const lines = [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      woohaa:",
    "        api: openai-completions",
    `        baseURL: ${JSON.stringify(input.modelBaseUrl)}`,
    `        apiKeyEnv: ${JSON.stringify(input.apiKeyEnv)}`,
    // Target execution must reach an authorized tool call promptly. The
    // provider default can spend the whole turn reasoning before it emits one.
    "        reasoning: off",
    "        compat:",
    "          supportsReasoningEffort: true",
    "        models:",
    `          - id: ${JSON.stringify(input.model)}`,
    `            name: ${JSON.stringify(input.model)}`,
    "            input: [text, image]",
    `            contextWindow: ${input.contextWindow ?? DSH_DEFAULT_CONTEXT_WINDOW}`,
    // `off` is otherwise encoded by omitting the field.  The gateway used by
    // Woohaa treats omission as its own default (reasoning enabled), so keep
    // the model reasoning-capable and map the off level to an explicit wire
    // value.  A non-off level is required by dsh's config schema even though
    // this profile always selects off.
    "            reasoningEfforts:",
    "              off: none",
    "              minimal: none",
    `            maxTokens: ${input.maxTokens ?? DSH_DEFAULT_MAX_OUTPUT_TOKENS}`
  ];
  for (const id of DSH_DISABLED_PLUGINS) lines.push(`- id: ${id}`, "  disabled: true");
  if (input.mcp) {
    lines.push(
      "- insert:",
      "    - id: mcp-woohaa",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      `        serverName: ${JSON.stringify(input.mcp.name)}`,
      "        transport: streamable-http",
      `        url: ${JSON.stringify(input.mcp.url)}`,
      "        headers:",
      `          Authorization: ${JSON.stringify(`Bearer ${input.mcp.bearerToken}`)}`,
      "        failOnStartupError: true"
    );
  }
  return `${lines.join("\n")}\n`;
}

type SessionEvent = { type?: unknown; data?: Record<string, unknown> };

/** 从通知里取出真实 `session.event`（`{ sessionId, event: { type, data } }`）。 */
function sessionEvents(notifications: readonly { params: Record<string, unknown> }[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const notification of notifications) {
    const params = notification.params as Record<string, unknown> | undefined;
    const event = params?.event as SessionEvent | undefined;
    if (event && typeof event.type === "string") out.push(event);
  }
  return out;
}

/** 助手消息的可见文本块（不读 reasoning）。 */
function assistantTextOf(data: Record<string, unknown> | undefined): string {
  const message = data?.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/**
 * 一条助手消息的块类型与终止原因。
 *
 * `stream` 是这条消息的完整分片快照，末尾的 `finish` 分片带模型级终止原因。输出额度写满时
 * dsh 会把 tool-call 块整个丢弃，只剩「正常结束」——所以必须从原始原因才能判断是不是截断。
 */
function assistantBlocksOf(data: Record<string, unknown> | undefined): {
  blocks: string[];
  finish?: string;
  /** 本次请求的真实用量：推理 token 也计入输出帽，必须能看见是谁吃掉了额度。 */
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
} {
  const message = data?.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const blocks = content.map((block) => {
    if (typeof block !== "object" || block === null) return "unknown";
    const record = block as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "unknown";
    return type === "tool-call" && typeof record.name === "string" ? `${type}:${record.name}` : type;
  });
  const stream = data?.stream;
  let finish: string | undefined;
  if (Array.isArray(stream)) {
    for (let index = stream.length - 1; index >= 0; index--) {
      const chunk = (stream[index] as { chunk?: { type?: unknown; reason?: { kind?: unknown } } } | undefined)?.chunk;
      if (chunk?.type !== "finish") continue;
      finish = typeof chunk.reason?.kind === "string" ? chunk.reason.kind : "unknown";
      break;
    }
  }
  const raw = data?.usage as Record<string, unknown> | undefined;
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const usage = raw && count(raw.outputTokens) !== undefined ? {
    ...(count(raw.inputTokens) !== undefined ? { inputTokens: count(raw.inputTokens) } : {}),
    outputTokens: count(raw.outputTokens)!,
    ...(count(raw.reasoningTokens) !== undefined ? { reasoningTokens: count(raw.reasoningTokens) } : {})
  } : undefined;
  return { blocks, ...(finish !== undefined ? { finish } : {}), ...(usage ? { usage } : {}) };
}

/**
 * 把 dsh 的会话事件投影为宿主事件。
 *
 * `tool/call` 的 `name` 是 `mcp__<server>__<tool>`；宿主只认原始工具名。同一 callId 只投影一次
 * （`assistant/message` 的 tool-call 块与 `tool/call` 事件可能同时出现）。
 */
export function projectDshEvents(
  events: readonly SessionEvent[],
  mcpName: string | null,
  emit: (
    event:
      | { type: "text-delta"; text: string; delivery?: "append" | "replace"; streamId?: string }
      | { type: "tool-call"; call: ModelToolCall }
  ) => void
): {
  assistantText: string;
  toolCalls: ModelToolCall[];
  /**
   * `turn/end` 的结束原因（`completed` / `max-tokens` / `blocked` / `error` / `aborted`）。
   *
   * dsh 把「输出额度写满」当成正常结束而不是错误；不透出这个原因，宿主就只能把这类
   * 回合归为「未确认写入」，用户看不到真实原因。
   */
  turnEnd?: string;
  /** `turn/end` 的原始 reason 文本（诊断用；不参与业务判断）。 */
  turnEndReason?: string;
  /** 每条助手消息的块类型与模型级终止原因（诊断与截断归因用）。 */
  assistantMessages: Array<{ blocks: string[]; finish?: string; usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } }>;
} {
  let assistantText = "";
  let turnEndReason: string | undefined;
  const toolCalls: ModelToolCall[] = [];
  const seen = new Set<string>();
  let turnEnd: string | undefined;
  const assistantMessages: Array<{ blocks: string[]; finish?: string; usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } }> = [];
  // 无稳定 message id 时，每个完整 `assistant/message` 各成一条消息。
  let messageSequence = 0;
  const strip = (name: string): string =>
    mcpName && name.startsWith(`mcp__${mcpName}__`) ? name.slice(`mcp__${mcpName}__`.length) : name;
  for (const event of events) {
    if (event.type === "assistant/message") {
      assistantMessages.push(assistantBlocksOf(event.data));
      const text = assistantTextOf(event.data);
      // `assistant/message` 是**完整**消息（可多次出现）：replace 收敛到对应逻辑消息。
      if (text !== "") {
        assistantText += text;
        const messageId = event.data?.messageId ?? event.data?.id;
        emit({
          type: "text-delta",
          text,
          delivery: "replace",
          // 没有稳定 message id 时，每个 `assistant/message` 都是一条完整消息：给独立身份，
          // 避免多条回复被 replace 覆盖成一条。
          streamId: typeof messageId === "string" ? messageId : `dsh-message-${++messageSequence}`
        });
      }
      const message = event.data?.message as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const record = block as Record<string, unknown>;
        if (record.type !== "tool-call" || typeof record.id !== "string") continue;
        const raw = typeof record.name === "string" ? record.name : "";
        if (raw === "" || seen.has(record.id)) continue;
        seen.add(record.id);
        const call: ModelToolCall = {
          id: record.id,
          name: strip(raw),
          argumentsJson: typeof record.arguments === "string" ? record.arguments : JSON.stringify(record.arguments ?? {})
        };
        toolCalls.push(call);
        emit({ type: "tool-call", call });
      }
      continue;
    }
    if (event.type === "turn/end") {
      const reason = event.data?.reason as Record<string, unknown> | undefined;
      if (typeof reason?.kind === "string") turnEnd = reason.kind;
      if (reason) turnEndReason = JSON.stringify(reason).slice(0, 500);
      continue;
    }
    if (event.type !== "tool/call") continue;
    const callId = typeof event.data?.callId === "string" ? event.data.callId : "";
    const raw = typeof event.data?.name === "string" ? event.data.name : "";
    if (callId === "" || raw === "" || seen.has(callId)) continue;
    seen.add(callId);
    const call: ModelToolCall = {
      id: callId,
      name: strip(raw),
      argumentsJson: typeof event.data?.arguments === "string" ? event.data.arguments : "{}"
    };
    toolCalls.push(call);
    emit({ type: "tool-call", call });
  }
  return { assistantText, toolCalls, assistantMessages, ...(turnEnd !== undefined ? { turnEnd } : {}), ...(turnEndReason !== undefined ? { turnEndReason } : {}) };
}

/**
 * A common DeepSeek failure mode is a normal stop immediately after the
 * preparatory reads. The model has the right context in the Harness session,
 * but ends the turn before issuing a write. One continuation on that same
 * session is safe: the gateway still owns the grant and de-duplicates calls,
 * while a second continuation is deliberately not attempted.
 */
export function shouldContinueAfterReadOnlyTurn(projected: ReturnType<typeof projectDshEvents>): boolean {
  return projected.toolCalls.length > 0
    && projected.toolCalls.every(call => call.name.startsWith("get_") || call.name === "sample_scene_animation" || call.name === "read_mcp_resource" || call.name === "list_mcp_resources" || call.name === "list_mcp_resource_templates")
    && projected.turnEnd !== "max-tokens"
    && projected.turnEnd !== "blocked"
    && projected.turnEnd !== "error"
    && projected.turnEnd !== "aborted";
}

const READ_ONLY_CONTINUATION_PROMPT = [
  "继续完成用户刚才要求的画布创作。",
  "你上一轮已经成功读取了权威上下文和模型 API；读取只是准备阶段，不能结束目标回合。",
  "现在必须立即调用至少一个本轮已授权的写工具（例如 create_world_model、replace_world_model_content、move_world_model、create_world_camera、set_world_camera 或 set_scene_animation_script），并等待工具成功回执。",
  "不要再次只发送计划、确认或说明文字；如果确实缺少一个关键字段，可以读取一次后立刻写入。"
].join("\n");

type DshHarness = import("@deepseek-ai/dsh-sdk-client").DeepSeekHarness;

export function createDshTransport(options: { configDir: string; workspaceDir: string; runtimeEntry?: string }): AgentSdkTransport {
  const active = new Set<string>();
  return {
    async run(input) {
      if (!input.modelBaseUrl || !input.resourceKey) {
        return { ok: false, code: "runtime-missing", message: "缺少隔离上下文或受控模型传输入口" };
      }
      const key = input.resourceKey;
      if (active.has(key)) return { ok: false, code: "capability-unsupported", message: "前轮尚未排空" };
      active.add(key);
      // 每轮独立 home/work：配置、凭据与 MCP grant 都不跨轮保留。
      const home = path.join(options.configDir, key);
      const work = path.join(options.workspaceDir, key);
      const launcher = path.join(home, "dsh-launcher.mjs");
      const patchPath = path.join(home, "woohaa.patch.yml");
      const runtimeEntry = options.runtimeEntry ?? dshRuntimeEntry();
      const nativeModules = dshNativeModulesPath(runtimeEntry);
      let harness: DshHarness | null = null;
      try {
        await mkdir(home, { recursive: true, mode: 0o700 });
        await mkdir(work, { recursive: true, mode: 0o700 });
        const credentialEnv = input.restrictions.credentialEnvVar;
        // 完整替换子进程环境：不继承宿主已有的模型 Key / provider 选择。
        const env: NodeJS.ProcessEnv = {
          PATH: path.dirname(process.execPath),
          HOME: home,
          ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
          ...(nativeModules ? { NODE_PATH: nativeModules } : {}),
          [input.restrictions.configDirEnvVar]: home,
          [credentialEnv]: input.apiKey
        };
        await writeFile(launcher, launcherSource(runtimeEntry), { mode: 0o600 });
        await writeFile(patchPath, buildDshPatch({
          modelBaseUrl: input.modelBaseUrl,
          model: input.model,
          apiKeyEnv: credentialEnv,
          maxTokens: readDshMaxOutputTokens(),
          contextWindow: readDshContextWindow(),
          mcp: input.mcp
        }), { mode: 0o600 });

        const { DeepSeekHarness } = await import("@deepseek-ai/dsh-sdk-client");
        harness = new DeepSeekHarness({
          // 显式启动器绕过 `import.meta.main`（Node 22/23 没有该属性，bin 会静默退出）。
          dshBin: launcher,
          profile: "sdk",
          patches: [patchPath],
          dshHome: home,
          processCwd: work,
          cwd: work,
          env,
          provider: "woohaa",
          model: input.model
        });

        if (input.signal.aborted) return { ok: false, code: "cancelled", message: "回合已停止" };
        let cancelled = false;
        // dsh 没有回合级 cancel：中断只能关闭 runtime；随后一律以 cancelled 结束。
        const onAbort = () => { cancelled = true; void harness?.close().catch(() => undefined); };
        input.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const promptInput = input.images?.length ? [{ type: "text" as const, text: input.prompt }, ...input.images.map(image => ({ type: "image" as const, mimeType: image.contentType as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: Buffer.from(image.bytes).toString("base64") }))] : input.prompt;
          let result = await harness.run(promptInput, { onNotification: () => undefined });
          if (cancelled || input.signal.aborted) return { ok: false, code: "cancelled", message: "回合已停止" };
          let projected = projectDshEvents(
            sessionEvents(result.notifications),
            input.mcp?.name ?? null,
            (event) => input.onEvent(event)
          );
          // Keep the continuation in the same Harness session so the model can
          // see the read-tool results instead of starting a contextless retry.
          let continued = false;
          if (shouldContinueAfterReadOnlyTurn(projected)) {
            continued = true;
            const continuation = await harness.run(READ_ONLY_CONTINUATION_PROMPT, { sessionId: result.sessionId, onNotification: () => undefined });
            if (cancelled || input.signal.aborted) return { ok: false, code: "cancelled", message: "回合已停止" };
            const next = projectDshEvents(sessionEvents(continuation.notifications), input.mcp?.name ?? null, (event) => input.onEvent(event));
            projected = {
              assistantText: projected.assistantText + next.assistantText,
              toolCalls: [...projected.toolCalls, ...next.toolCalls],
              assistantMessages: [...projected.assistantMessages, ...next.assistantMessages],
              ...(next.turnEnd !== undefined ? { turnEnd: next.turnEnd } : projected.turnEnd !== undefined ? { turnEnd: projected.turnEnd } : {})
            };
            result = { ...continuation, finalResponse: continuation.finalResponse || result.finalResponse };
          }
          // `finalResponse` 只是区间内最后一条助手文本，不与 prompt 因果绑定：
          // 只在事件投影为空时回落到它。
          const assistantText = projected.assistantText !== "" ? projected.assistantText : result.finalResponse;
          const modelFinish = projected.assistantMessages.at(-1)?.finish;
          // 结构性诊断：dsh 对「写满额度」「工具调用块被丢弃」都只记一条 turn/end，宿主无法区分。
          // 执行器进程的 stdout/stderr 被 supervisor 丢弃，所以每轮都保留一个有界、0600 的本地摘要；
          // 这不进入会话账本，也不保存凭据或完整工具参数，但能核对原始结束原因和隐藏资源工具。
          void writeFile(path.join(os.tmpdir(), "woohaa-dsh-last-turn.json"), JSON.stringify({
            at: new Date().toISOString(),
            model: input.model,
            continued,
            turnEnd: projected.turnEnd ?? null,
            modelFinish: modelFinish ?? null,
            calls: projected.toolCalls.map((call) => call.name),
            messages: projected.assistantMessages,
            assistantText: assistantText.slice(-4000),
            assistantTextLength: assistantText.length,
            finalResponse: String(result.finalResponse ?? "").slice(-4000)
          }, null, 1), { mode: 0o600 }).catch(() => undefined);
          // dsh 只有「正常结束」才会 resolve；`blocked`/`error` 不是模型完成，必须如实报错。
          if (projected.turnEnd === "blocked") return { ok: false, code: "turn-blocked", message: "回合被运行时阻塞，未执行写入；请重试" };
          if (projected.turnEnd === "error") {
            // 保留上游终止原因：`turn/end` 的 reason 是唯一能区分「上游拒绝」「限流」「协议错误」的证据。
            const detail = projected.turnEndReason;
            void writeFile(path.join(os.tmpdir(), "woohaa-dsh-last-turn.json"), JSON.stringify({ at: new Date().toISOString(), model: input.model, turnEnd: projected.turnEnd, reason: detail ?? null, calls: projected.toolCalls.map((call) => call.name) }, null, 1), { mode: 0o600 }).catch(() => undefined);
            return { ok: false, code: "execution-failed", message: detail ? `模型回合以错误结束（${detail}），未提交写入；请重试` : "模型回合以错误结束，未提交写入；请重试" };
          }
          // 模型自称以工具调用结束，却没有留下任何完整调用：分片被丢弃，本轮不可能写入。
          if (projected.toolCalls.length === 0 && modelFinish === "tool-calls")
            return { ok: false, code: "tool-call-incomplete", message: "模型生成的工具调用不完整，本轮未提交写入；请拆分需求后重试" };
          return {
            ok: true,
            assistantText,
            toolCalls: projected.toolCalls,
            // `max-tokens` 表示输出额度写满：末尾的工具调用通常已被截断，交给宿主按截断归因。
            finishReason: projected.turnEnd === "max-tokens" || modelFinish === "max-tokens" ? "length" : "stop",
            ...(result.sessionId ? { nativeId: result.sessionId } : {})
          };
        } finally {
          input.signal.removeEventListener("abort", onAbort);
        }
      } catch (error) {
        if (input.signal.aborted) return { ok: false, code: "cancelled", message: "回合已停止" };
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown } | null)?.code;
        // 只有确实缺依赖才报 runtime-missing；启动/协议失败单独报告，不吞掉原因。
        if (code === "ERR_MODULE_NOT_FOUND" || /^Cannot find (module|package) /.test(message)) {
          return { ok: false, code: "runtime-missing", message: "缺少 DeepSeek Harness 运行时，请在设置 → 运行时组件中准备并重试" };
        }
        return { ok: false, code: "transport-unavailable", message: `DeepSeek Harness 执行失败：${message.slice(0, 200)}` };
      } finally {
        await harness?.close().catch(() => undefined);
        // 不保留短期 MCP grant 与模型 token。
        await Promise.all([
          rm(home, { recursive: true, force: true }),
          rm(work, { recursive: true, force: true })
        ]);
        active.delete(key);
      }
    }
  };
}
