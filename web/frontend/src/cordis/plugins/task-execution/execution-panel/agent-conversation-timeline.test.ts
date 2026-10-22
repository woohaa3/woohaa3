import { describe, expect, it } from "vitest";
import type { ConversationEvent, ConversationMessage, ConversationSnapshot, ConversationTurn } from "@woohaa3/contracts";
import { buildConversationTimeline } from "./agent-conversation-timeline.js";

const time = "2026-10-13T00:00:00.000Z";
function message(id: string, role: ConversationMessage["role"], content: string, sequence: number, turnId = "t1"): ConversationMessage {
  return { messageId: id, conversationId: "c", turnId, requestId: turnId, role, content, truncated: false, sequence, createdAt: time };
}
function event(sequence: number, type: ConversationEvent["type"], payload: unknown, turnId = "t1"): ConversationEvent {
  return { sequence, conversationId: "c", turnId, requestId: turnId, type, payload, createdAt: time };
}
function turn(turnId = "t1"): ConversationTurn {
  return { turnId, conversationId: "c", requestId: turnId, action: "generate", status: "succeeded", stage: "succeeded", target: { canvasId: "cv" }, tools: [], createdAt: time, updatedAt: time };
}
function snapshot(messages: ConversationMessage[], events: ConversationEvent[], turns = [turn()]): ConversationSnapshot {
  return { conversation: { conversationId: "c", canvasId: "cv", adapterId: "chatgpt", title: "对话", status: "succeeded", createdAt: time, updatedAt: time, turnCount: turns.length }, turns, messages, events, cursor: 100, resyncRequired: false };
}

describe("Agent 对话时间线", () => {
  it("消息编号与事件编号不同且时间戳相同时，仍按执行序列混排并原位更新工具", () => {
    const messages = [message("m1", "user", "修改模型", 1), message("m2", "assistant", "先读取", 2), message("m3", "assistant", "已完成", 3)];
    const rows = buildConversationTimeline(snapshot(messages, [
      event(10, "message-completed", { role: "user", content: "修改模型" }),
      event(20, "message-completed", { role: "assistant", content: "先读取" }),
      event(30, "tool-started", { tool: "get_model", callId: "a" }),
      event(40, "tool-completed", { tool: "get_model", callId: "a", ok: true, summary: "读取成功" }),
      event(50, "message-completed", { role: "assistant", content: "已完成" })
    ]));
    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "tool", "message"]);
    expect(rows[2]).toMatchObject({ tool: { status: "completed", summary: "读取成功" } });
  });

  it("同名并行调用按 callId 匹配，失败不会覆盖另一次调用", () => {
    const rows = buildConversationTimeline(snapshot([], [
      event(1, "tool-started", { tool: "get_model", callId: "a" }),
      event(2, "tool-started", { tool: "get_model", callId: "b" }),
      event(3, "tool-completed", { tool: "get_model", callId: "b", ok: false }),
      event(4, "tool-completed", { tool: "get_model", callId: "a", ok: true })
    ]));
    expect(rows).toMatchObject([{ tool: { status: "completed" } }, { tool: { status: "failed" } }]);
  });

  it("切换到后续回合后仍保留上一轮工具与回执，不重复展示事件中的消息", () => {
    const messages = [message("m1", "assistant", "完成", 1), message("m2", "user", "继续", 2, "t2")];
    const rows = buildConversationTimeline(snapshot(messages, [
      event(1, "tool-completed", { tool: "submit_model", ok: true }),
      event(2, "message-completed", { role: "assistant", content: "完成" }),
      event(3, "message-completed", { role: "user", content: "继续" }, "t2")
    ], [{ ...turn(), receipt: { status: "succeeded" } }, turn("t2")]));
    expect(rows.map((row) => row.kind)).toEqual(["tool", "message", "result", "message"]);
    expect(rows.filter((row) => row.kind === "message")).toHaveLength(2);
  });

  it("没有事件的旧快照保留本轮输入、工具、回复和错误", () => {
    const rows = buildConversationTimeline(snapshot([message("m1", "user", "修改", 1), message("m2", "assistant", "失败", 2)], [], [{ ...turn(), tools: [{ tool: "submit_model", status: "failed" }], error: { code: "failed", message: "失败" } }]));
    expect(rows.map((row) => row.kind)).toEqual(["message", "tool", "message", "result"]);
  });
  it("窗口截在工具开始后时，用持久投影补全完成事件与后续工具", () => {
    const rows = buildConversationTimeline(snapshot([message("m1", "user", "修改", 1), message("m2", "assistant", "完成", 2)], [
      event(10, "message-completed", { role: "user", content: "修改" }),
      event(20, "tool-started", { tool: "get_model", callId: "a" })
    ], [{ ...turn(), tools: [
      { tool: "get_model", status: "started", afterSequence: 10, createdAt: time },
      { tool: "get_model", status: "completed", afterSequence: 20, createdAt: time },
      { tool: "submit_model", status: "completed", afterSequence: 30, createdAt: time }
    ] }]));
    expect(rows.map((row) => row.kind)).toEqual(["message", "tool", "tool", "message"]);
    expect(rows[1]).toMatchObject({ tool: { tool: "get_model", status: "completed" } });
    expect(rows[2]).toMatchObject({ tool: { tool: "submit_model", status: "completed" } });
  });

  it("流式消息在 message-delta 与 message-completed 之间只占一行", () => {
    const messages = [
      message("m1", "user", "生成模型", 1),
      message("m2", "assistant", "正在生成的回复", 2)
    ];
    const rows = buildConversationTimeline(snapshot(messages, [
      event(10, "message-completed", { messageId: "m1", role: "user", content: "生成模型" }),
      event(20, "message-delta", { messageId: "m2", role: "assistant" }),
      event(30, "tool-started", { tool: "submit_model_script", callId: "a" }),
      event(40, "tool-completed", { tool: "submit_model_script", callId: "a", ok: true }),
      event(50, "message-completed", { messageId: "m2", role: "assistant", content: "正在生成的回复" })
    ]));
    // 同一条消息只出现一次，位置取自它开始增长的那个事件（工具在其后仍按序显示）。
    expect(rows.map((row) => row.kind)).toEqual(["message", "message", "tool"]);
    expect(rows.filter((row) => row.kind === "message")).toHaveLength(2);
    expect(rows[1]).toMatchObject({ message: { messageId: "m2" } });
  });

  it("同一轮多条助手消息各有自己的 delta/completed 事件", () => {
    const messages = [
      message("m1", "assistant", "先读取", 1),
      message("m2", "assistant", "已完成", 2)
    ];
    const rows = buildConversationTimeline(snapshot(messages, [
      event(10, "message-delta", { messageId: "m1", role: "assistant" }),
      event(11, "message-completed", { messageId: "m1", role: "assistant", content: "先读取" }),
      event(12, "tool-started", { tool: "get_model", callId: "a" }),
      event(13, "tool-completed", { tool: "get_model", callId: "a", ok: true }),
      event(14, "message-delta", { messageId: "m2", role: "assistant" }),
      event(15, "message-completed", { messageId: "m2", role: "assistant", content: "已完成" })
    ]));
    expect(rows.map((row) => row.kind)).toEqual(["message", "tool", "message"]);
    expect(rows[0]).toMatchObject({ message: { content: "先读取" } });
    expect(rows[2]).toMatchObject({ message: { content: "已完成" } });
  });

  it("全无事件时，将旧工具开始/完成投影配为一条调用", () => {    const rows = buildConversationTimeline(snapshot([], [], [{ ...turn(), tools: [
      { tool: "get_model", status: "started" }, { tool: "get_model", status: "failed" }
    ] }]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: { status: "failed" } });
  });

});
