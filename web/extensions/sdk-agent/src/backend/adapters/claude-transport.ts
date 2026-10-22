/**
 * Claude Agent SDK 真实传输
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 7.2/7.3 / design D6）。
 *
 * 显式 API Key 路径：实例 env 传 `ANTHROPIC_API_KEY`（不集成订阅 OAuth）；隔离 `CLAUDE_CONFIG_DIR`
 * 与只读工作目录，`settingSources: []` 不加载用户/项目设置。执行前限制：`permissionMode:
 * "dontAsk"` + `disallowedTools` 关闭内建 shell/文件写/外部工具 + `allowedTools` 仅本轮工具；
 * MCP 只注入本轮受控 Woohaa 工具面（讨论回合不注入）。流式事件只投影公开文本/工具。
 *
 * 需要后端本机运行时（Claude Code CLI/子进程）与合法 Anthropic API Key；未时保持未验证。
 */
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { query, type Options, type SDKMessage, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelStreamEvent, ModelToolCall } from "../protocol/model-turn.js";
import type { AgentSdkTransport, AgentSdkTransportResult } from "./agent-sdk-adapter.js";

export type ClaudeTransportOptions = {
  /** 隔离 Claude 配置目录根（每连接子目录）。 */
  configDir: string;
  /** 只读工作目录根（每连接子目录）。 */
  workspaceDir: string;
  /** 可执行入口覆盖。 */
  executablePath?: string | null;
  /** 测试注入 fake query。 */
  createQuery?: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;
  logger?: (event: Record<string, unknown>) => void;
};

function connectionKey(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

export function createClaudeTransport(options: ClaudeTransportOptions): AgentSdkTransport {
  const log = options.logger ?? (() => undefined);
  return {
    async run(input): Promise<AgentSdkTransportResult> {
      const key = input.resourceKey ?? connectionKey(`${input.model}:${input.restrictions.workspaceDir}`);
      const configDir = path.join(options.configDir, key);
      const cwd = path.join(options.workspaceDir, key);

      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      let child: ChildProcessWithoutNullStreams | undefined;
      const options_ = {
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
          child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
          return child;
        },
        abortController,
        tools: [],
        strictMcpConfig: true,
        includePartialMessages: true,
        persistSession: true,
        model: input.model,
        ...(["low", "medium", "high"].includes(input.reasoningEffort ?? "") ? { effort: input.reasoningEffort as "low" | "medium" | "high", thinking: { type: "adaptive" as const } } : {}),
        cwd,
        settingSources: [] as const,
        permissionMode: "dontAsk" as const,
        allowedTools: input.mcp ? input.restrictions.allowedTools.map((name) => `mcp__${input.mcp!.name}__${name}`) : [],
        disallowedTools: [...input.restrictions.disallowedTools],
        maxTurns: 12,
        env: {
          ANTHROPIC_API_KEY: input.apiKey,
          ANTHROPIC_BASE_URL: input.modelBaseUrl ?? "",
          HOME: configDir,
          XDG_CONFIG_HOME: configDir,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CONFIG_DIR: configDir,
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),

        },
        ...(options.executablePath ? { pathToClaudeCodeExecutable: options.executablePath } : {}),
        ...(input.resumeNativeId ? { resume: input.resumeNativeId } : {}),
        ...(input.mcp
          ? {
              mcpServers: {
                [input.mcp.name]: { type: "http" as const, url: input.mcp.url, headers: { authorization: `Bearer ${input.mcp.bearerToken}` } }
              }
            }
          : {})
      } satisfies Options;

      const prompt = input.images?.length ? (async function* (): AsyncGenerator<SDKUserMessage> {
        yield { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [
          { type: "text", text: input.prompt },
          ...input.images!.map(image => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.contentType as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: Buffer.from(image.bytes).toString("base64") } }))
        ] } };
      })() : input.prompt;
      let stream: AsyncIterable<SDKMessage> | undefined;

      const toolCalls: ModelToolCall[] = [];
      let assistantText = "";
      let nativeId = input.resumeNativeId ?? undefined;
      let finishReason: AgentSdkTransportResult extends { finishReason: infer R } ? R : never = "stop" as never;
      try {
        stream = options.createQuery ? options.createQuery({ prompt, options: options_ }) : (query({ prompt, options: options_ }) as AsyncIterable<SDKMessage>);
        for await (const message of stream) {
          if (input.signal.aborted) return { ok: false, code: "cancelled", message: "回合已取消", ...(nativeId ? { nativeId } : {}) };
          const events = mapClaudeMessage(message);
          for (const event of events) {
            if (event.type === "text-delta") {
              assistantText += event.text;
              input.onEvent(event);
            } else if (event.type === "tool-call") {
              toolCalls.push(event.call);
              input.onEvent(event);
            } else if (event.type === "error") {
              return { ok: false, code: event.code, message: event.message, ...(nativeId ? { nativeId } : {}) };
            }
          }
          if (message.type === "result") {
            if (message.subtype === "success") {
              if (typeof message.result === "string" && message.result !== "" && assistantText === "") {
                assistantText = message.result;
                // 结果消息给的是整段正文：replace 收敛到同一条助手消息。
                input.onEvent({ type: "text-delta", text: message.result, delivery: "replace" });
              }
              finishReason = (toolCalls.length > 0 ? "tool_calls" : "stop") as never;
            } else {
              const errors = "errors" in message && Array.isArray(message.errors) ? message.errors.join("; ") : "Claude 运行失败";
              return { ok: false, code: "protocol-mismatch", message: errors, ...(nativeId ? { nativeId } : {}) };
            }
          }
          if (typeof message.session_id === "string" && message.session_id !== "") {
            nativeId = message.session_id;
          }
        }
      } catch (error) {
        return { ok: false, code: input.signal.aborted ? "cancelled" : "transport-unavailable", message: error instanceof Error ? error.message : "Claude 运行失败", ...(nativeId ? { nativeId } : {}) };
      } finally {
        input.signal.removeEventListener("abort", abort);
        // End the owned process before invoking SDK cleanup: close/return can
        // throw or never settle, and the caller releases its runtime lease next.
        const process = child;
        if (process && process.exitCode === null && process.signalCode === null) {
          await new Promise<void>((resolve) => {
            const finish = () => { clearTimeout(timer); process.removeListener("exit", finish); process.removeListener("close", finish); resolve(); };
            const timer = setTimeout(() => process.kill("SIGKILL"), 2000);
            // A spawn failure emits close without exit. Waiting for exit alone
            // would strand the turn and its lease after an ENOENT failure.
            process.once("exit", finish);
            process.once("close", finish);
            if (process.exitCode !== null || process.signalCode !== null) finish();
            else process.kill("SIGTERM");
          });
        }
        if (stream) {
          const sdk = stream as Partial<Query>;
          // Both cleanup hooks get a chance even when one throws. Bound SDK-only
          // cleanup after process exit so a stuck iterator cannot strand a turn.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const hooks = Promise.allSettled([
              Promise.resolve().then(() => sdk.close?.()),
              Promise.resolve().then(() => sdk.return?.(undefined))
            ]).then(results => {
              for (const result of results) if (result.status === "rejected") log({ event: "claude-agent-cleanup-failed", message: String(result.reason).slice(0, 200) });
            });
            await Promise.race([hooks, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
          } finally { if (timer) clearTimeout(timer); }
        }
      }
      if (nativeId) input.onNativeId(nativeId);
      log({ event: "claude-agent-turn-complete", toolCount: toolCalls.length });
      return { ok: true, assistantText, toolCalls, finishReason, ...(nativeId ? { nativeId } : {}) };
    }
  };
}

/**
 * 投影 Claude SDK 消息为公开事件（不保存隐式推理/thinking）。
 *
 * `stream_event` 的 text delta 与 `assistant` 消息的 tool_use 块都映射为公开过程。
 */
export function mapClaudeMessage(message: SDKMessage): ModelStreamEvent[] {
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      // 真增量：宿主合并进当前消息，不按分片各存一条。
      return [{ type: "text-delta", text: event.delta.text, delivery: "append" }];
    }
    return [];
  }
  if (message.type === "assistant") {
    const events: ModelStreamEvent[] = [];
    for (const block of message.message.content ?? []) {
      if (block.type === "tool_use") {
        events.push({ type: "tool-call", call: { id: block.id, name: block.name, argumentsJson: JSON.stringify(block.input ?? {}) } });
      }
    }
    return events;
  }
  return [];
}

export type { ModelToolCall };
