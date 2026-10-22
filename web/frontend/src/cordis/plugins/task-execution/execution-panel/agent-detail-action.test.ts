/**
 * Agent 详情入口按状态映射单测
 * （change: 2026-10-12-add-agent-conversation-panel，任务 5.2/6.1 / design D6 状态入口表）。
 *
 * 覆盖：无会话不制造空记录；idle 有既往会话为低强调；运行/终态为明显的具名动作；摘要准确。
 */
import { describe, expect, it } from "vitest";
import type { ConversationTurnStatus } from "@woohaa3/contracts";
import { resolveAgentDetailAction } from "./agent-detail-action.js";

describe("resolveAgentDetailAction", () => {
  it("尚无会话时返回 null（不制造空对话记录）", () => {
    expect(resolveAgentDetailAction({ status: "idle", hasConversation: false })).toBeNull();
  });

  it("idle 且有既往会话：低强调「对话详情」", () => {
    const action = resolveAgentDetailAction({ status: "idle", hasConversation: true });
    expect(action).not.toBeNull();
    expect(action!.label).toBe("对话详情");
    expect(action!.emphasis).toBe("low");
  });

  it("运行中/排队/提交中：明显的「查看执行与对话」，摘要为真实阶段", () => {
    for (const [status, summary] of [
      ["queued", "排队中"],
      ["running", "执行中"],
      ["committing", "提交中"]
    ] as Array<[ConversationTurnStatus, string]>) {
      const action = resolveAgentDetailAction({ status, hasConversation: true });
      expect(action).toEqual({ label: "查看执行与对话", summary, emphasis: "strong" });
    }
  });

  it("失败/完成/部分完成/unknown/cancelled 使用各自具名动作与摘要", () => {
    expect(resolveAgentDetailAction({ status: "failed", hasConversation: true })).toEqual({
      label: "查看原因与对话",
      summary: "生成失败",
      emphasis: "strong"
    });
    expect(resolveAgentDetailAction({ status: "succeeded", hasConversation: true })).toEqual({
      label: "查看结果与对话",
      summary: "已完成",
      emphasis: "strong"
    });
    expect(resolveAgentDetailAction({ status: "partial", hasConversation: true })!.label).toBe("查看未完成项与对话");
    expect(resolveAgentDetailAction({ status: "unknown", hasConversation: true })!.label).toBe("查看执行状态与对话");
    expect(resolveAgentDetailAction({ status: "cancelled", hasConversation: true })!.label).toBe("查看已执行内容");
  });

  it("所有可见入口都带非空具名文案（不依赖图标/颜色）", () => {
    const statuses: ConversationTurnStatus[] = ["queued", "running", "committing", "succeeded", "partial", "failed", "unknown", "cancelled"];
    for (const status of statuses) {
      const action = resolveAgentDetailAction({ status, hasConversation: true });
      expect(action!.label.trim().length).toBeGreaterThan(0);
      expect(action!.summary.trim().length).toBeGreaterThan(0);
    }
  });
});
