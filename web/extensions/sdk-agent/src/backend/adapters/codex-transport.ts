/**
 * Codex Agent SDK 真实传输
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 7.1/7.3 / design D6）。
 *
 * 显式 API Key 路径：`new Codex({ apiKey })`；不使用 ChatGPT OAuth，也不在共享 `process.env`
 * 放凭据（实例 `env` 只含每连接 `CODEX_HOME` 与必要 PATH/HOME）。执行前限制：
 * `sandboxMode: "read-only"`、`approvalPolicy: "never"`、`webSearchMode: "disabled"`、
 * `features.shell_tool = false`；MCP 只注入本轮受控 Woohaa 工具面（讨论回合不注入）。
 * 事件里的命令执行/文件变更一律视为越界并中止（不当作成功）。
 *
 * 需要后端本机安装匹配的 Codex CLI 且有合法 OpenAI API Key；未时保持未验证。
 */
import { withAgentImageFiles } from "@woohaa3/agent-connections";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Codex, type ThreadEvent, type UserInput } from "@openai/codex-sdk";
import type { ModelStreamEvent, ModelToolCall } from "../protocol/model-turn.js";
import type { AgentSdkRestrictions, AgentSdkTransport, AgentSdkTransportResult } from "./agent-sdk-adapter.js";

export const CODEX_MCP_BEARER_ENV = "WOOHAA3_CODEX_AGENT_MCP_BEARER";

export type CodexTransportOptions = {
  /** 隔离 Codex HOME 根（每连接子目录）。 */
  configDir: string;
  /** 只读工作目录根（每连接子目录）。 */
  workspaceDir: string;
  /** CLI 入口覆盖。 */
  executablePath?: string | null;
  /** 测试注入 fake SDK 工厂。 */
  createCodex?: (options: { apiKey: string; baseUrl?: string; env: Record<string, string>; config: Record<string, unknown> }) => CodexLike;
  logger?: (event: Record<string, unknown>) => void;
};

type CodexLike = { startThread: (o: Record<string, unknown>) => CodexThreadLike; resumeThread?: (id: string, o: Record<string, unknown>) => CodexThreadLike };
type CodexThreadLike = {
  readonly id?: string | null;
  runStreamed: (input: string | UserInput[], options: { signal?: AbortSignal; outputSchema?: Record<string, unknown> }) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
};

function connectionKey(connectionId: string): string {
  return createHash("sha256").update(connectionId).digest("hex");
}

export function createCodexTransport(options: CodexTransportOptions): AgentSdkTransport {
  const log = options.logger ?? (() => undefined);
  return {
    async run(input): Promise<AgentSdkTransportResult> {
      const key = input.resourceKey ?? connectionKey(input.model + ":" + input.restrictions.workspaceDir);
      const home = path.join(options.configDir, key);
      const cwd = path.join(options.workspaceDir, key);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      mkdirSync(cwd, { recursive: true, mode: 0o700 });

      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: home,
        XDG_DATA_HOME: home,
        CODEX_HOME: home
      };
      const config: Record<string, unknown> = {
        web_search: input.restrictions.webSearchMode,
        "features.shell_tool": false,
        "features.multi_agent": false,
        "features.collab": false,
        "features.multi_agent_v2": false,
        "features.goals": false,
        "features.view_image": false,
        "features.default_mode_request_user_input": false,
        "features.collaboration_modes": false,
        "tools.experimental_request_user_input.enabled": false,
        "tools.update_plan.enabled": false,
        "features.apply_patch_freeform": false,
        "features.exec_policy": false,
        "features.js_repl": false,
        "features.apps": false,
        "features.skills": false,
        "analytics.enabled": false,
        "feedback.enabled": false,
        model_provider: "woohaa",
        "model_providers.woohaa.name": "Woohaa controlled transport",
        "model_providers.woohaa.base_url": input.modelBaseUrl ?? "",
        "model_providers.woohaa.wire_api": "responses",
        "model_providers.woohaa.env_key": "OPENAI_API_KEY",
        "model_providers.woohaa.requires_openai_auth": false
      };
      env.OPENAI_API_KEY = input.apiKey;
      if (input.mcp) {
        config[`mcp_servers.${input.mcp.name}.url`] = input.mcp.url;
        config[`mcp_servers.${input.mcp.name}.enabled_tools`] = [...input.restrictions.allowedTools];
        config[`mcp_servers.${input.mcp.name}.startup_timeout_sec`] = 20;
        config[`mcp_servers.${input.mcp.name}.default_tools_approval_mode`] = "approve";
        env[CODEX_MCP_BEARER_ENV] = input.mcp.bearerToken;
        config[`mcp_servers.${input.mcp.name}.bearer_token_env_var`] = CODEX_MCP_BEARER_ENV;
      }

      const factory =
        options.createCodex ??
        ((factoryOptions) =>
          new Codex({
            apiKey: factoryOptions.apiKey,
            baseUrl: factoryOptions.baseUrl,
            ...(options.executablePath ? { codexPathOverride: options.executablePath } : {}),
            env: factoryOptions.env,
            config: factoryOptions.config as never
          }) as unknown as CodexLike);
      const codex = factory({ apiKey: input.apiKey, baseUrl: input.modelBaseUrl, env, config });

      const threadOptions: Record<string, unknown> = {
        model: input.model,
        ...(input.reasoningEffort ? { modelReasoningEffort: input.reasoningEffort } : {}),
        sandboxMode: input.restrictions.sandboxMode,
        approvalPolicy: input.restrictions.approvalPolicy,
        webSearchMode: input.restrictions.webSearchMode,
        workingDirectory: cwd,
        skipGitRepoCheck: true
      };
      const thread = input.resumeNativeId && codex.resumeThread ? codex.resumeThread(input.resumeNativeId, threadOptions) : codex.startThread(threadOptions);

      return withAgentImageFiles(input.images ?? [], async files => {
      const imagePaths = [...input.imagePaths, ...files];
      const items: UserInput[] = [{ type: "text", text: input.prompt }];
      for (const imagePath of imagePaths) items.push({ type: "local_image", path: imagePath });
      const modelInput: string | UserInput[] = imagePaths.length > 0 ? items : input.prompt;

      const toolCalls: ModelToolCall[] = [];
      let assistantText = "";
      // 无稳定 item id 时，每个完整 agent_message 各成一条消息。
      let messageSequence = 0;
      let finishReason: AgentSdkTransportResult extends { finishReason: infer R } ? R : never = "stop" as never;
      try {
        const { events } = await thread.runStreamed(modelInput, { signal: input.signal, ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}) });
        for await (const event of events) {
          const violation = codexBoundaryViolation(event);
          if (violation) return { ok: false, code: "capability-unsupported", message: violation };
          if (event.type === "item.completed" && event.item.type === "agent_message") {
            assistantText = event.item.text;
            // 完整正文：replace 收敛同一条消息；item id 作为逻辑身份。
            const item = event.item as { id?: unknown; text: string };
            input.onEvent({
              type: "text-delta",
              text: event.item.text,
              delivery: "replace",
              streamId: typeof item.id === "string" ? item.id : `codex-message-${++messageSequence}`
            });
          } else if (event.type === "item.completed" && event.item.type === "mcp_tool_call") {
            const call: ModelToolCall = { id: event.item.id, name: event.item.tool, argumentsJson: JSON.stringify(event.item.arguments ?? {}) };
            toolCalls.push(call);
            input.onEvent({ type: "tool-call", call });
          } else if (event.type === "turn.completed") {
            finishReason = (toolCalls.length > 0 ? "tool_calls" : "stop") as never;
          } else if (event.type === "turn.failed") {
            return { ok: false, code: "protocol-mismatch", message: event.error.message };
          }
        }
      } catch (error) {
        return { ok: false, code: input.signal.aborted ? "cancelled" : "transport-unavailable", message: error instanceof Error ? error.message : "Codex 运行失败" };
      }
      const nativeId = thread.id ?? input.resumeNativeId ?? undefined;
      if (nativeId) input.onNativeId(nativeId);
      log({ event: "codex-agent-turn-complete", toolCount: toolCalls.length });
      return { ok: true, assistantText, toolCalls, finishReason, reasoning: input.reasoningEffort ? { requested: input.reasoningEffort, applied: true } : { applied: "provider-default" }, ...(nativeId ? { nativeId } : {}) };
      });
    }
  };
}

/** 受控边界：命令执行/文件变更一律越界（MCP 工具调用是受控工具面）。 */
export function codexBoundaryViolation(event: ThreadEvent): string | null {
  if (event.type !== "item.completed" && event.type !== "item.started" && event.type !== "item.updated") return null;
  if (event.item.type === "command_execution") return "Codex 尝试执行命令，已被拒绝";
  if (event.item.type === "file_change") return "Codex 尝试修改文件，已被拒绝";
  return null;
}

export type { AgentSdkRestrictions, ModelStreamEvent };
