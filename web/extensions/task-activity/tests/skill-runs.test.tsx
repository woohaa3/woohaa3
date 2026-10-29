// @vitest-environment jsdom
/**
 * Skill 媒体步骤在统一活动面板中的行为
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 5.2 / 5.3）。
 *
 * 覆盖：当前尝试投影（`cancel-requested` 不是已取消）、旧尝试只在详情里核对、迟到旧结果
 * 不改写当前行、轮询重放与用户移除后不复活、详情「核对状态」按步骤身份回填权威快照。
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UiProvider } from "@woohaa3/frontend/extension-api";
import type { SkillMediaAttemptView, SkillMediaStepView } from "@woohaa3/contracts";
import {
  ACTIVITY_EXIT_DURATION_MS,
  ACTIVITY_TERMINAL_LINGER_MS,
  TaskActivityStore
} from "../src/frontend/store.js";
import { TaskActivityFeed } from "../src/frontend/feed.js";
import { adaptSkillRow, skillRowKey } from "../src/frontend/adapt-skill-row.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const attempt = (patch: Partial<SkillMediaAttemptView> & { attempt: number; runId: string }): SkillMediaAttemptView => ({
  skillRunId: "skill-run-1",
  stepId: "step-1",
  promptRevision: patch.attempt,
  requestId: `request-${patch.attempt}`,
  state: "succeeded",
  current: false,
  superseded: false,
  createdAt: `2026-10-20T00:00:0${patch.attempt}Z`,
  updatedAt: `2026-10-20T00:00:0${patch.attempt}Z`,
  ...patch
});

const step = (patch: Partial<SkillMediaStepView> = {}): SkillMediaStepView => {
  const attempts = patch.attempts ?? [attempt({ attempt: 1, runId: "run-1", current: true, state: "running" })];
  return {
    canvasId: "canvas-1",
    nodeId: "node-1",
    skillRunId: "skill-run-1",
    stepId: "step-1",
    currentAttempt: attempts[attempts.length - 1]!.attempt,
    currentRunId: attempts[attempts.length - 1]!.runId,
    promptRevision: attempts[attempts.length - 1]!.promptRevision,
    attempts,
    createdAt: "2026-10-20T00:00:00Z",
    updatedAt: "2026-10-20T00:00:05Z",
    ...patch
  };
};

it("主行只投影当前尝试：取消中仍是进行中，已替代只在历史里出现", () => {
  const running = adaptSkillRow(step());
  expect(running.kind).toBe("skill");
  expect(running.active).toBe(true);
  expect(running.status).toBe("生成中");
  expect(running.key).toBe("skill:skill-run-1:step-1");

  const cancelling = adaptSkillRow(step({ attempts: [attempt({ attempt: 1, runId: "run-1", current: true, state: "cancel-requested" })] }));
  // Provider 尚未确认：不得显示为已取消，停止/替代仍按进行中处理。
  expect(cancelling.active).toBe(true);
  expect(cancelling.status).toBe("取消中");
  expect(cancelling.tone).toBe("active");

  const superseded = adaptSkillRow(step({
    attempts: [
      attempt({ attempt: 1, runId: "run-1", state: "superseded", superseded: true, supersededByAttempt: 2, supersededByRunId: "run-2" }),
      attempt({ attempt: 2, runId: "run-2", current: true, state: "running", promptRevision: 2 })
    ],
    currentAttempt: 2,
    currentRunId: "run-2",
    promptRevision: 2
  }));
  expect(superseded.active).toBe(true);
  expect(superseded.status).toBe("生成中");
  expect(superseded.secondary).toContain("第 2 次");
});

it("旧尝试的迟到成功不改写当前行，历史仍保留可核对", () => {
  const store = new TaskActivityStore();
  try {
    // 当前尝试 2 已成功；尝试 1 的迟到回调只作为它自己的历史事实到达。
    const settled = step({
      attempts: [
        attempt({ attempt: 1, runId: "run-1", state: "superseded", superseded: true, supersededByAttempt: 2, supersededByRunId: "run-2", prompt: "旧提示词" }),
        attempt({ attempt: 2, runId: "run-2", current: true, state: "succeeded", promptRevision: 2, prompt: "新提示词" })
      ],
      currentAttempt: 2,
      currentRunId: "run-2",
      promptRevision: 2,
      latestSuccessfulRunId: "run-2"
    });
    store.replaceSkillSteps([settled]);
    const row = store.getSnapshot().rows.find((entry) => entry.kind === "skill")!;
    expect(row.state).toBe("succeeded");
    expect(row.active).toBe(false);
    expect(row.source.kind).toBe("skill");
    if (row.source.kind === "skill") {
      // 当前结果指向运行 2；运行 1 只作为替代历史存在。
      expect(row.source.step.currentRunId).toBe("run-2");
      expect(row.source.step.attempts[0]!.state).toBe("superseded");
      expect(row.source.step.attempts[0]!.prompt).toBe("旧提示词");
    }

    // 乱序轮询到旧快照（运行 1 当时还在运行）不得回退当前结果。
    store.replaceSkillSteps([step({
      attempts: [attempt({ attempt: 1, runId: "run-1", current: true, state: "running" })],
      currentAttempt: 1,
      updatedAt: "2026-10-20T00:00:04Z"
    })]);
    expect(store.getSnapshot().rows[0]!.state).toBe("succeeded");
    expect(store.getSnapshot().rows[0]!.active).toBe(false);
  } finally {
    store.dispose();
  }
});

it("终态 Skill 记录按统一期限移除，轮询不得复活；重新生成后重新计时", () => {
  vi.useFakeTimers();
  const store = new TaskActivityStore();
  try {
    const settled = step({ attempts: [attempt({ attempt: 1, runId: "run-1", current: true, state: "succeeded" })] });
    store.replaceSkillSteps([settled]);
    expect(store.getSnapshot().unread).toBe(1);
    expect(store.getSnapshot().rows).toHaveLength(1);
    vi.advanceTimersByTime(ACTIVITY_TERMINAL_LINGER_MS);
    expect(store.getSnapshot().exitingKeys).toEqual(["skill:skill-run-1:step-1"]);
    vi.advanceTimersByTime(ACTIVITY_EXIT_DURATION_MS);
    expect(store.getSnapshot().rows).toHaveLength(0);

    // 轮询重放同一终态快照：dismiss 标记生效，不复活。
    store.replaceSkillSteps([settled]);
    expect(store.getSnapshot().rows).toHaveLength(0);

    // 用户重新生成：同一步骤重新 active，清除移除标记并重新计时。
    store.replaceSkillSteps([step({
      attempts: [
        attempt({ attempt: 1, runId: "run-1", state: "superseded", superseded: true, supersededByAttempt: 2, supersededByRunId: "run-2" }),
        attempt({ attempt: 2, runId: "run-2", current: true, state: "running", promptRevision: 2 })
      ],
      currentAttempt: 2,
      currentRunId: "run-2",
      promptRevision: 2
    })]);
    expect(store.getSnapshot().rows).toHaveLength(1);
    expect(store.getSnapshot().rows[0]!.active).toBe(true);
    vi.advanceTimersByTime(ACTIVITY_TERMINAL_LINGER_MS * 2);
    expect(store.getSnapshot().rows).toHaveLength(1);
  } finally {
    store.dispose();
    vi.useRealTimers();
  }
});

it("详情展开旧尝试历史；失败记录不再提供核对入口", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const store = new TaskActivityStore();
  const refresh = vi.fn().mockResolvedValue(undefined);
  try {
    store.configure({ locateNode: () => undefined, skill: { refresh, resolveTitle: () => "主图节点" } });
    const current = step({
      attempts: [
        attempt({ attempt: 1, runId: "run-1", state: "superseded", superseded: true, supersededByAttempt: 2, supersededByRunId: "run-2", prompt: "旧提示词" }),
        attempt({ attempt: 2, runId: "run-2", current: true, state: "running", promptRevision: 2, prompt: "新提示词" })
      ],
      currentAttempt: 2,
      currentRunId: "run-2",
      promptRevision: 2
    });
    act(() => {
      store.replaceSkillSteps([current]);
      root.render(<UiProvider><TaskActivityFeed store={store} resolveMediaUrl={key => key} /></UiProvider>);
    });
    expect(container.querySelector('[data-kind="skill"]')?.textContent).toContain("主图节点");
    act(() => container.querySelector<HTMLButtonElement>('[data-kind="skill"] .task-activity-feed__primary')!.click());
    const detail = container.querySelector(".task-activity-feed__pop--group")!;
    expect(detail.textContent).toContain("第 1 次 · 已替代");
    expect(detail.textContent).toContain("由 run-2 替代");
    expect(detail.textContent).toContain("旧提示词");
    expect(detail.textContent).toContain("第 2 次 · 生成中");
    expect(detail.textContent).not.toContain("核对状态");
    expect(refresh).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    store.dispose();
    container.remove();
  }
});

it("同一 Skill 步骤身份稳定，重复快照不新增行", () => {
  const first = step({ attempts: [attempt({ attempt: 1, runId: "run-1", current: true, state: "running" })] });
  const second = step({ attempts: [attempt({ attempt: 1, runId: "run-1", current: true, state: "running" })], updatedAt: "2026-10-20T00:00:09Z" });
  expect(skillRowKey(first)).toBe(skillRowKey(second));
  const store = new TaskActivityStore();
  try {
    store.replaceSkillSteps([first]);
    store.replaceSkillSteps([second]);
    expect(store.getSnapshot().rows).toHaveLength(1);
    expect(store.getSnapshot().skills).toHaveLength(1);
  } finally {
    store.dispose();
  }
});
