/**
 * Skill 步骤执行面板状态与操作
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 5.1 / 5.3）。
 *
 * 覆盖取消竞态（`cancel-requested` 仍可重复停止、不得显示为已取消）、终态恢复入口、
 * 旧尝试留在历史、请求身份唯一，以及 Pad/小尺寸电脑正常窗口下的静态展示。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SkillMediaAttemptView, SkillMediaState, SkillMediaStepView } from "@woohaa3/contracts";
import {
  SKILL_STEP_STATE_LABELS,
  createSkillRegenerateRequestId,
  resolveSkillStepActions,
  skillStepCurrentAttempt,
  skillStepHistory,
  skillStepIsActive,
  skillStepStatusText
} from "./skill-step-status-state.js";
import { SkillStepStatusView } from "./skill-step-status.js";

const attempt = (patch: Partial<SkillMediaAttemptView> & { attempt: number; runId: string }): SkillMediaAttemptView => ({
  skillRunId: "skill-run-1",
  stepId: "step-1",
  promptRevision: patch.attempt,
  requestId: `request-${patch.attempt}`,
  state: "running",
  current: false,
  superseded: false,
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:00Z",
  ...patch
});

const step = (state: SkillMediaState, patch: Partial<SkillMediaStepView> = {}): SkillMediaStepView => ({
  canvasId: "canvas-1",
  nodeId: "node-1",
  skillRunId: "skill-run-1",
  stepId: "step-1",
  currentAttempt: 1,
  currentRunId: "run-1",
  promptRevision: 1,
  attempts: [attempt({ attempt: 1, runId: "run-1", current: true, state })],
  createdAt: "2026-10-20T00:00:00Z",
  updatedAt: "2026-10-20T00:00:05Z",
  ...patch
});

describe("取消竞态与可用动作", () => {
  it("Provider 尚未确认时保持取消中：可重复停止，也可用新尝试继续", () => {
    const cancelling = step("cancel-requested");
    const actions = resolveSkillStepActions({ step: cancelling, writable: true, readOnly: false });
    expect(skillStepIsActive(cancelling)).toBe(true);
    expect(actions.canStop).toBe(true);
    expect(actions.canRegenerate).toBe(true);
    expect(actions.needsRecovery).toBe(false);
    expect(skillStepStatusText(cancelling)).toContain("取消中");
    expect(skillStepStatusText(cancelling)).not.toContain("已取消");
  });

  it("终态不可再停止；失败仍保留恢复入口", () => {
    expect(resolveSkillStepActions({ step: step("succeeded"), writable: true, readOnly: false })).toMatchObject({
      canStop: false,
      canRegenerate: true,
      needsRecovery: false
    });
    expect(resolveSkillStepActions({ step: step("failed"), writable: true, readOnly: false })).toMatchObject({
      canStop: false,
      needsRecovery: true
    });
  });

  it("只读会话不提供停止或重新生成", () => {
    expect(resolveSkillStepActions({ step: step("running"), writable: false, readOnly: false })).toEqual({
      canStop: false,
      canRegenerate: false,
      needsRecovery: false
    });
    expect(resolveSkillStepActions({ step: step("running"), writable: true, readOnly: true })).toEqual({
      canStop: false,
      canRegenerate: false,
      needsRecovery: false
    });
  });
});

describe("当前尝试与历史", () => {
  it("主状态只取当前尝试，旧尝试单独列出并标注接续关系", () => {
    const stepView = step("succeeded", {
      currentAttempt: 2,
      currentRunId: "run-2",
      promptRevision: 2,
      attempts: [
        attempt({ attempt: 1, runId: "run-1", state: "superseded", superseded: true, supersededByAttempt: 2, supersededByRunId: "run-2" }),
        attempt({ attempt: 2, runId: "run-2", current: true, state: "succeeded", promptRevision: 2 })
      ]
    });
    expect(skillStepCurrentAttempt(stepView)?.runId).toBe("run-2");
    expect(skillStepStatusText(stepView)).toContain("第 2 次");
    expect(skillStepHistory(stepView)).toEqual([
      { attempt: 1, state: "superseded", runId: "run-1", label: "已被后续尝试替代", supersededByRunId: "run-2" }
    ]);
  });

  it("每个状态都有稳定文案", () => {
    for (const state of Object.keys(SKILL_STEP_STATE_LABELS) as SkillMediaState[]) {
      expect(skillStepStatusText(step(state))).toContain(SKILL_STEP_STATE_LABELS[state]);
    }
  });

  it("重新生成请求身份每次独立，可安全重试", () => {
    const first = createSkillRegenerateRequestId();
    const second = createSkillRegenerateRequestId();
    expect(first).not.toBe(second);
    expect(first.startsWith("skill-regen-")).toBe(true);
  });
});

describe("面板静态展示", () => {
  it("取消中显示等待确认说明和停止按钮", () => {
    const html = renderToStaticMarkup(
      <SkillStepStatusView
        step={step("cancel-requested")}
        writable
        readOnly={false}
        busy=""
        error=""
        onStop={() => undefined}
        onRegenerate={() => undefined}
      />
    );
    expect(html).toContain('data-state="cancel-requested"');
    expect(html).toContain("停止请求已发出，正在等待确认");
    expect(html).toContain("停止");
    expect(html).toContain("改词重新生成");
    expect(html).not.toContain("已取消");
  });

  it("失败时提供恢复生成，忙时按钮禁用", () => {
    const failed = renderToStaticMarkup(
      <SkillStepStatusView
        step={step("failed")}
        writable
        readOnly={false}
        busy=""
        error=""
        onStop={() => undefined}
        onRegenerate={() => undefined}
      />
    );
    expect(failed).toContain("恢复生成");
    expect(failed).toContain("使用最新提示词恢复生成");
    const busy = renderToStaticMarkup(
      <SkillStepStatusView
        step={step("running")}
        writable
        readOnly={false}
        busy="regenerate"
        error=""
        onStop={() => undefined}
        onRegenerate={() => undefined}
      />
    );
    expect(busy).toContain("正在重新生成");
    expect(busy).toContain("disabled");
  });

  it("Pad/小尺寸电脑正常窗口下仍完整展示状态与历史", () => {
    const original = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    try {
      const html = renderToStaticMarkup(
        <SkillStepStatusView
          step={step("succeeded", {
            currentAttempt: 2,
            currentRunId: "run-2",
            promptRevision: 2,
            latestSuccessfulRunId: "run-2",
            attempts: [
              attempt({ attempt: 1, runId: "run-1", state: "superseded", superseded: true, supersededByAttempt: 2, supersededByRunId: "run-2" }),
              attempt({ attempt: 2, runId: "run-2", current: true, state: "succeeded", promptRevision: 2 })
            ]
          })}
          writable
          readOnly={false}
          busy=""
          error=""
          onStop={() => undefined}
          onRegenerate={() => undefined}
        />
      );
      expect(html).toContain("第 2 次 · 已完成");
      expect(html).toContain("提示词版本 r2");
      expect(html).toContain("最近成功运行 run-2");
      expect(html).toContain("<summary>技术详情</summary>");
      expect(html).toContain("历史尝试（1）");
      expect(html).toContain("第 1 次 · 已被后续尝试替代");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
    }
  });

  it("错误信息可见且不吞掉状态", () => {
    const onStop = vi.fn();
    const html = renderToStaticMarkup(
      <SkillStepStatusView
        step={step("running")}
        writable
        readOnly={false}
        busy=""
        error="停止请求未确认"
        onStop={onStop}
        onRegenerate={() => undefined}
      />
    );
    expect(html).toContain("停止请求未确认");
    expect(html).toContain("第 1 次 · 生成中");
  });
});
