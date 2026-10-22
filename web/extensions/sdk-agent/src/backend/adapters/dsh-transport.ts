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
  "command-goal"
];

/** dsh 运行时入口（绝对文件路径）；缺依赖时由调用方报 runtime-missing。 */
export function dshRuntimeEntry(): string {
  return path.join(path.dirname(require.resolve("@deepseek-ai/dsh/package.json")), "lib", "bin.js");
}

export function dshExecutable(): string {
  return require.resolve("@deepseek-ai/dsh/package.json");
}

/** 运行时入口是否存在（不启动进程）；供 fixed-engine-runtime 探测。 */
export const dshRuntimePath = dshRuntimeEntry;

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
    "        models:",
    `          - id: ${JSON.stringify(input.model)}`,
    `            name: ${JSON.stringify(input.model)}`,
    "            input: [text, image]",
    "            contextWindow: 128000"
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
): { assistantText: string; toolCalls: ModelToolCall[] } {
  let assistantText = "";
  const toolCalls: ModelToolCall[] = [];
  const seen = new Set<string>();
  // 无稳定 message id 时，每个完整 `assistant/message` 各成一条消息。
  let messageSequence = 0;
  const strip = (name: string): string =>
    mcpName && name.startsWith(`mcp__${mcpName}__`) ? name.slice(`mcp__${mcpName}__`.length) : name;
  for (const event of events) {
    if (event.type === "assistant/message") {
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
  return { assistantText, toolCalls };
}

type DshHarness = import("@deepseek-ai/dsh-sdk-client").DeepSeekHarness;

export function createDshTransport(options: { configDir: string; workspaceDir: string }): AgentSdkTransport {
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
          [input.restrictions.configDirEnvVar]: home,
          [credentialEnv]: input.apiKey
        };
        await writeFile(launcher, launcherSource(dshRuntimeEntry()), { mode: 0o600 });
        await writeFile(patchPath, buildDshPatch({
          modelBaseUrl: input.modelBaseUrl,
          model: input.model,
          apiKeyEnv: credentialEnv,
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
          const result = await harness.run(input.images?.length ? [{ type: "text", text: input.prompt }, ...input.images.map(image => ({ type: "image" as const, mimeType: image.contentType as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: Buffer.from(image.bytes).toString("base64") }))] : input.prompt, { onNotification: () => undefined });
          if (cancelled || input.signal.aborted) return { ok: false, code: "cancelled", message: "回合已停止" };
          const projected = projectDshEvents(
            sessionEvents(result.notifications),
            input.mcp?.name ?? null,
            (event) => input.onEvent(event)
          );
          // `finalResponse` 只是区间内最后一条助手文本，不与 prompt 因果绑定：
          // 只在事件投影为空时回落到它。
          const assistantText = projected.assistantText !== "" ? projected.assistantText : result.finalResponse;
          return {
            ok: true,
            assistantText,
            toolCalls: projected.toolCalls,
            finishReason: "stop",
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
          return { ok: false, code: "runtime-missing", message: "缺少 DeepSeek Harness 运行时，请重新安装本扩展" };
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
