/**
 * 远端助手的工具回合循环。
 *
 * 一轮对话在这里可能变成**多轮模型往返**：
 *
 *   模型回复（带 tool_calls）→ 执行工具 → 回填 tool 消息 → 再问模型 → … → 最终正文
 *
 * 为什么要一个显式循环而不是"调一次就完"：模型要求调工具时正文是空的，直接返回会让
 * 用户看到一条空消息；而工具结果是模型继续推理的输入，不回填它就永远得不到答案。
 *
 * 边界（哪些**不**在这里做）：
 * - 不决定模型该调什么工具（模型自己决定）；
 * - 不组装角色提示词（`prepared.messages` 由宿主合成）；
 * - 不判业务对错（工具自己拒绝并给出原因，这里只负责如实转达给模型）。
 *
 * 循环上限是硬约束：模型可能反复调同一个工具，没有上限会让一次用户操作无限消耗配额。
 */

import type { RemoteToolCall, RemoteToolDefinition } from "./chat-client.js";

/** 一次模型往返的抽象（由调用方注入，便于测试与替换流式/非流式）。 */
export type ToolLoopTurn = {
  (input: {
    messages: readonly import("./chat-client.js").RemoteChatMessage[];
    tools: readonly RemoteToolDefinition[];
  }): Promise<
    | { ok: true; text: string; toolCalls: RemoteToolCall[]; finishReason: string }
    | { ok: false; code: string; message: string }
  >;
};

/** 工具执行抽象（由调用方注入，通常指向宿主 MCP）。 */
export type ToolLoopExecutor = {
  (name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string }>;
};

export type ToolLoopOptions = {
  turn: ToolLoopTurn;
  /** 执行工具；缺省表示本轮没有工具通道。 */
  execute?: ToolLoopExecutor;
  /**
   * 本轮开放的工具声明。
   *
   * **必须显式传入**，不能从 `execute` 上"顺手"取：`execute` 是 `channel.callTool`
   * 这样的裸函数，把 `listTools` 挂在函数对象上既不可发现也不可靠。曾经这么写过，
   * 后果是模型收不到任何 `tools` 声明，于是把工具调用写成文本（`<｜DSML｜invoke>`），
   * 表现为「助手返回了工具调用文本，本轮没有修改作品」。
   */
  tools?: readonly RemoteToolDefinition[];
  /**
   * 连续多少轮没有任何工具成功就停（缺省 6）。
   *
   * **唯一**的熔断条件，也是唯一该由本层设的限制：它回答的是"这条链路是不是坏了"
   * （工具全被拒、grant 失效、MCP 不可达），而不是"任务该做多少步"。
   *
   * 不设总轮数上限：那属于 agent 自己的决策。sdk-agent / local-agent 把整个循环交给
   * dsh、Codex、OpenCode 这些 runtime，provider 层从不规定它们跑几步；远端模型没有
   * runtime，循环在这里，但语义应当一致——**跑到模型自己不再要求调工具为止**。
   * 曾经设过 8 轮，结果一次「建宫殿」（9 轮）被掐在第五段，用户看到"部分完成"。
   */
  maxIdleRounds?: number;
  /** 每次工具调用前后的可观察钩子（用于 emit 进度与记录回执）。 */
  onToolCall?: (call: { id: string; name: string; arguments: string }) => void;
  onToolResult?: (call: { id: string; name: string; ok: boolean; content: string }) => void;
  /** 取消信号：模型往返与工具执行都该能被真正中止。 */
  signal?: AbortSignal;
};

export type ToolLoopResult =
  | { ok: true; text: string; rounds: number }
  | { ok: false; code: string; message: string; text: string; rounds: number };

/** 一条对话消息（与 chat-client 的同形，这里只用到这几个字段）。 */
type Message = import("./chat-client.js").RemoteChatMessage;

/**
 * 跑完一次工具往返循环，返回最终正文。
 *
 * `initialMessages` 是宿主编好的规范消息（角色指令 + 本轮输入）；循环只在它后面追加
 * assistant / tool 消息，**不改写**宿主编好的那部分。
 */
export async function runToolLoop(
  initialMessages: readonly Message[],
  options: ToolLoopOptions
): Promise<ToolLoopResult> {
  const maxIdleRounds = options.maxIdleRounds ?? 6;
  const messages: Message[] = [...initialMessages];
  const tools = options.execute === undefined ? [] : (options.tools ?? []);
  let text = "";
  /** 连续多少轮没有任何工具成功。 */
  let idleRounds = 0;

  // 没有总轮数上限：终点是模型自己不再要求调工具（`toolCalls` 为空）。
  for (let round = 1; ; round += 1) {
    if (options.signal?.aborted) {
      return { ok: false, code: "cancelled", message: "已停止本次生成", text, rounds: round - 1 };
    }
    const turn = await options.turn({ messages, tools });
    if (!turn.ok) {
      return { ok: false, code: turn.code, message: turn.message, text, rounds: round };
    }
    // 每一轮的正文都累积：模型可能在调用工具前先说一句话，那句话是真实产出。
    if (turn.text !== "") text = turn.text;

    if (turn.toolCalls.length === 0) {
      // 没有工具调用就是最终答案（即使 finishReason 是 length 也照样交付正文，
      // 截断由交付层按内容判断，这里不替它做结论）。
      return { ok: true, text: turn.text, rounds: round };
    }

    // 把模型这一轮的要求原样记入历史：不带 tool_calls 的话，下一轮上游无法把
    // tool 结果与调用配对，会整轮拒绝。
    messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });

    let anySucceeded = false;
    for (const call of turn.toolCalls) {
      options.onToolCall?.({ id: call.id, name: call.function.name, arguments: call.function.arguments });
      const outcome = await executeCall(options, call);
      if (outcome.ok) anySucceeded = true;
      options.onToolResult?.({ id: call.id, name: call.function.name, ok: outcome.ok, content: outcome.content });
      // tool 消息必须带 toolCallId：缺了它上游无法配对，表现为"工具结果被忽略"。
      messages.push({ role: "tool", toolCallId: call.id, content: outcome.content });
    }

    // 只在"完全没有进展"时熔断：长任务每轮都在写入，不该被任何计数掐断；
    // 连续几轮工具全失败说明这条链路坏了，继续跑只是烧配额。
    idleRounds = anySucceeded ? 0 : idleRounds + 1;
    if (idleRounds >= maxIdleRounds) {
      return {
        ok: false,
        code: "tool-loop-stalled",
        message: `助手连续 ${maxIdleRounds} 轮没有成功执行任何工具，已停止`,
        text,
        rounds: round,
      };
    }
  }
}

/** 执行一次工具调用；参数解析失败也要回给模型，而不是让整轮崩掉。 */
async function executeCall(
  options: ToolLoopOptions,
  call: RemoteToolCall
): Promise<{ ok: boolean; content: string }> {
  if (options.signal?.aborted) return { ok: false, content: "[cancelled] 已停止本次生成" };
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = call.function.arguments.trim() === "" ? {} : JSON.parse(call.function.arguments);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, content: "[invalid-arguments] 工具参数必须是 JSON 对象" };
    }
    args = parsed as Record<string, unknown>;
  } catch {
    // 模型偶尔给出截断的 JSON。如实告诉它"参数不是合法 JSON"比抛出去更有用：
    // 它能据此重发一次正确的调用。
    return { ok: false, content: "[invalid-arguments] 工具参数不是合法 JSON" };
  }
  try {
    return await options.execute!(call.function.name, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : "工具执行失败";
    return { ok: false, content: `[tool-failed] ${message}` };
  }
}
