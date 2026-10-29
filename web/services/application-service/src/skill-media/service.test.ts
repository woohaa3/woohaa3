import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentNodeOutputView, AgentRunView } from "@woohaa3/contracts";
import { SqliteSkillMediaStore } from "./store.js";
import { createSkillMediaService } from "./service.js";
import type { SkillMediaCanvasPort } from "./ports.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type CanvasState = { view?: AgentRunView; output?: AgentNodeOutputView };
function harness() {
  const dir = mkdtempSync(join(tmpdir(), "woohaa-skill-service-"));
  dirs.push(dir);
  const path = join(dir, "application.sqlite");
  const store = new SqliteSkillMediaStore({ path });
  const calls: string[] = [];
  const states = new Map<string, CanvasState>();
  let cancelResult: Awaited<ReturnType<SkillMediaCanvasPort["cancel"]>> = {
    ok: true, canvasId: "canvas", nodeId: "node", runId: "run", state: "cancel-requested"
  };
  let onCancel: (() => void) | null = null;
  const canvas: SkillMediaCanvasPort = {
    async run(input) {
      calls.push(`run:${input.runId ?? ""}:${input.skill.attempt}`);
      return { ok: true, canvasId: input.canvasId, nodeId: input.nodeId, runId: input.runId, jobId: `job-${input.skill.attempt}`, state: "accepted" };
    },
    async cancel(input) {
      calls.push(`cancel:${input.runId}`);
      onCancel?.();
      return { ...cancelResult, runId: input.runId };
    },
    async status(input) {
      calls.push(`status:${input.runId}`);
      return { ok: true, view: states.get(input.runId)?.view ?? running(input.runId) };
    },
    async output(input) {
      calls.push(`output:${input.runId}`);
      return { ok: true, nodeId: input.nodeId, runId: input.runId, view: states.get(input.runId)?.output ?? { available: false, reason: "no-output", message: "无" } };
    }
  };
  const service = createSkillMediaService({
    store,
    canvas,
    authorize: async () => ({ ok: true }),
    now: () => "2026-10-28T00:00:00.000Z",
    pollMs: 1,
    deriveRunId: ({ requestId }) => `run-${requestId}`
  });
  return { store, path, service, calls, states, canvas, setCancelResult: (value: typeof cancelResult) => { cancelResult = value; }, setOnCancel: (fn: () => void) => { onCancel = fn; } };
}

function running(runId: string): AgentRunView {
  return { protocolVersion: 1, canvasId: "canvas", nodeId: "node", runId, jobId: `job-${runId}`, phase: "running", stale: false };
}
function succeeded(runId: string): AgentRunView {
  return { protocolVersion: 1, canvasId: "canvas", nodeId: "node", runId, jobId: `job-${runId}`, phase: "terminal", state: "succeeded", stale: false };
}
function imageOutput(runId: string): AgentNodeOutputView {
  return {
    available: true,
    output: {
      kind: "image", runId, url: `/api/media/${runId}`, contentType: "image/png", size: 12,
      provenance: { canvasId: "canvas", nodeId: "node", runId, jobId: `job-${runId}` }
    }
  };
}

const scope = { owner: "user", canvasId: "canvas" };
const step = { ...scope, skillRunId: "skill", stepId: "image-step" };

async function beginFirst(h: ReturnType<typeof harness>, prompt = "一只猫") {
  const result = await h.service.begin({ ...step, nodeId: "node", requestId: "req-1", runId: "run-1", prompt });
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe("Skill 步骤应用服务", () => {
  it("首次尝试返回 attempt=1、promptRevision 与 runId", async () => {
    const h = harness();
    const result = await beginFirst(h);
    expect(result.step).toMatchObject({ currentAttempt: 1, currentRunId: "run-1", promptRevision: 1 });
    expect(result.step.attempts[0]).toMatchObject({ attempt: 1, runId: "run-1", state: "queued", current: true, prompt: "一只猫" });
  });

  it("相同 requestId 幂等；换提示词或换步骤拒绝", async () => {
    const h = harness();
    await beginFirst(h);
    const retry = await h.service.begin({ ...step, nodeId: "node", requestId: "req-1", runId: "run-1", prompt: "一只猫" });
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    expect(h.store.listAttempts(step)).toHaveLength(1);
    const conflict = await h.service.begin({ ...step, nodeId: "node", requestId: "req-1", runId: "run-1", prompt: "一只狗" });
    expect(conflict).toMatchObject({ ok: false, code: "request-id-reused" });
    const otherStep = await h.service.begin({ ...scope, skillRunId: "skill-2", stepId: "video-step", nodeId: "node", requestId: "req-1", runId: "run-x" });
    expect(otherStep).toMatchObject({ ok: false, code: "request-id-reused" });
  });

  it("跨 owner 读取被拒绝", async () => {
    const h = harness();
    await beginFirst(h);
    const result = await h.service.snapshot({ owner: "other", canvasId: "canvas", skillRunId: "skill", stepId: "image-step" });
    expect(result).toMatchObject({ ok: false, code: "skill-step-not-found" });
  });

  it("替代事务先落盘再取消旧 run、启动新 run", async () => {
    const h = harness();
    await beginFirst(h);
    h.setOnCancel(() => {
      const persisted = h.store.getStep(step)!;
      expect(persisted.currentAttempt).toBe(2);
      expect(persisted.currentRunId).toBe("run-2");
    });
    // replace 的 deriveRunId 返回 run-<requestId>
    const result = await h.service.replace({ ...step, requestId: "req-2", prompt: "一只橘猫" });
    expect(result).toMatchObject({ ok: true, runId: "run-req-2" });
    expect(h.calls.slice(0, 2)).toEqual(["cancel:run-1", "run:run-req-2:2"]);
    const view = await h.service.snapshot(step);
    expect(view.ok && view.step.attempts.map((entry) => entry.state)).toEqual(["cancel-requested", "queued"]);
    expect(view.ok && view.step.attempts[0]).toMatchObject({ superseded: true, supersededByRunId: "run-req-2" });
    expect(view.ok && view.step.promptRevision).toBe(2);
  });

  it("取消失败不回滚新 attempt，并保持旧尝试 cancel-requested", async () => {
    const h = harness();
    await beginFirst(h);
    h.setCancelResult({ ok: false, code: "task-unavailable", message: "cancel down" });
    const result = await h.service.replace({ ...step, requestId: "req-2", prompt: "一只黑猫" });
    expect(result.ok).toBe(true);
    const view = await h.service.snapshot(step);
    expect(view.ok && view.step.currentAttempt).toBe(2);
    expect(view.ok && view.step.attempts[0]).toMatchObject({ state: "cancel-requested", superseded: true });
  });

  it("旧 run 迟到成功只写历史，不覆盖当前尝试", async () => {
    const h = harness();
    await beginFirst(h);
    h.states.set("run-1", { view: running("run-1") });
    h.states.set("run-2", { view: running("run-req-2") });
    await h.service.replace({ ...step, requestId: "req-2", prompt: "一只橘猫" });
    h.service.settleFromRun({ canvasId: "canvas", nodeId: "node", runId: "run-1", state: "succeeded", mediaKind: "image" });
    // 旧尝试仍保持「取消中 + 已替代」，不得因迟到成功变成当前成功或刷新 latestSuccessfulRunId。
    const mid = await h.service.snapshot(step);
    expect(mid.ok && mid.step.attempts[0]).toMatchObject({ state: "cancel-requested", superseded: true, mediaKind: "image" });
    expect(mid.ok && mid.step.latestSuccessfulRunId).toBeUndefined();
    const pending = await h.service.latestOutput(step);
    expect(pending.ok && pending.view).toMatchObject({ available: false, reason: "running", fallbackAvailable: false });
    h.service.settleFromRun({ canvasId: "canvas", nodeId: "node", runId: "run-req-2", state: "succeeded", mediaKind: "image" });
    h.states.set("run-req-2", { output: imageOutput("run-req-2") });
    const output = await h.service.latestOutput(step);
    expect(output.ok && output.view).toMatchObject({ available: true, current: true, runId: "run-req-2" });
  });

  it("当前失败时只有显式 allowFallback 才返回旧成功版本", async () => {
    const h = harness();
    await beginFirst(h);
    h.service.settleFromRun({ canvasId: "canvas", nodeId: "node", runId: "run-1", state: "succeeded", mediaKind: "image" });
    h.states.set("run-1", { output: imageOutput("run-1") });
    h.states.set("run-req-2", { view: { ...running("run-req-2"), phase: "terminal", state: "failed" } });
    await h.service.replace({ ...step, requestId: "req-2", prompt: "一只橘猫" });
    h.service.settleFromRun({ canvasId: "canvas", nodeId: "node", runId: "run-req-2", state: "failed", error: "provider failed" });
    const plain = await h.service.latestOutput(step);
    expect(plain.ok && plain.view).toMatchObject({ available: false, reason: "failed", fallbackAvailable: true });
    const fallback = await h.service.latestOutput({ ...step, allowFallback: true });
    expect(fallback.ok && fallback.view).toMatchObject({ available: true, current: false, fallback: { runId: "run-1" } });
  });

  it("核对窗口结束仍无法证明时撤销 Provider 运行并失败，不视为成功", async () => {
    const h = harness();
    await beginFirst(h);
    h.states.set("run-1", { view: { ...running("run-1"), stale: true } });
    const output = await h.service.latestOutput(step);
    expect(output.ok && output.view).toMatchObject({ available: false, reason: "failed" });
    expect(h.calls).toContain("cancel:run-1");
    expect(h.store.getAttempt({ ...step, attempt: 1 })).toMatchObject({ state: "failed" });
    expect(h.store.getAttempt({ ...step, attempt: 1 })?.error).toContain("result-unconfirmed");
  });

  it("终态缺少权威状态时同样撤销并失败", async () => {
    const h = harness();
    await beginFirst(h);
    h.states.set("run-1", { view: { ...running("run-1"), phase: "terminal" } as AgentRunView });
    const snapshot = await h.service.snapshot(step);
    expect(snapshot.ok && snapshot.step.attempts[0]).toMatchObject({ state: "failed" });
    expect(h.calls).toContain("cancel:run-1");
  });

  it("等待期间用户重生成时跟随新 run", async () => {
    const h = harness();
    await beginFirst(h);
    h.states.set("run-1", { view: running("run-1") });
    h.states.set("run-req-2", { view: running("run-req-2") });
    const pending = h.service.wait({ ...step, waitMs: 2_000, followLatest: true });
    while (!h.calls.includes("status:run-1")) await new Promise((resolve) => setTimeout(resolve, 1));
    await h.service.replace({ ...step, requestId: "req-2", prompt: "一只橘猫" });
    h.states.set("run-req-2", { view: succeeded("run-req-2"), output: imageOutput("run-req-2") });
    const result = await pending;
    expect(result.ok && result.view).toMatchObject({ phase: "succeeded", followed: true, replacedRunIds: ["run-1"], runId: "run-req-2" });
    expect(h.calls.some((call) => call.startsWith("output:run-req-2"))).toBe(true);
  });

  it("等待超时/取消不取消媒体生成，也不重发 run", async () => {
    const h = harness();
    await beginFirst(h);
    h.states.set("run-1", { view: running("run-1") });
    const timedOut = await h.service.wait({ ...step, waitMs: 1, followLatest: true });
    expect(timedOut.ok && timedOut.view.phase).toBe("timeout");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await h.service.wait({ ...step, waitMs: 1_000, signal: controller.signal });
    expect(cancelled.ok && cancelled.view).toMatchObject({ phase: "running", cancelled: true });
    expect(h.calls.filter((call) => call.startsWith("cancel:"))).toHaveLength(0);
    expect(h.calls.filter((call) => call.startsWith("run:"))).toHaveLength(0);
  });

  it("事件有序、重复游标 no-op、无法证明连续性时 resetRequired，且不携带 prompt", async () => {
    const h = harness();
    await beginFirst(h);
    const first = await h.service.events({ ...step, after: 0 });
    expect(first.ok && first.page.events.map((entry) => entry.state)).toEqual(["queued"]);
    const cursor = first.ok ? first.page.cursor : 0;
    const duplicate = await h.service.events({ ...step, after: cursor });
    expect(duplicate.ok && duplicate.page.events).toEqual([]);
    const reset = await h.service.events({ ...step, after: cursor + 10 });
    expect(reset.ok && reset.page.resetRequired).toBe(true);
    const payload = JSON.stringify(first.ok ? first.page.events : []);
    expect(payload).not.toContain("一只猫");
    expect(payload).not.toContain("sha256-");
  });

  it("事件游标缺口（已清理的早期事件）返回 resetRequired", async () => {
    const h = harness();
    // 其它步骤先占用序列，使本步骤最早 sequence 大于 2。
    await h.service.begin({ ...scope, skillRunId: "other", stepId: "other", nodeId: "other-node", requestId: "other-1", runId: "other-run-1" });
    await h.service.begin({ ...scope, skillRunId: "other", stepId: "other", nodeId: "other-node", requestId: "other-2", runId: "other-run-2" });
    await beginFirst(h);
    const result = await h.service.events({ ...step, after: 1 });
    expect(result.ok && result.page.resetRequired).toBe(true);
  });

  it("用户停止：Provider 未确认时保持 cancel-requested", async () => {
    const h = harness();
    await beginFirst(h);
    const pending = h.service.begin({ ...step, nodeId: "node", requestId: "req-2", runId: "run-2" });
    expect((await pending).ok).toBe(true);
    // 上面 begin 创建了第二个 attempt（不影响本用例：current 是 run-2）
    h.states.set("run-2", { view: running("run-2") });
    const result = await h.service.cancel({ ...step });
    expect(result.ok && result.state).toBe("cancel-requested");
    const view = await h.service.snapshot(step);
    expect(view.ok && view.step.attempts.at(-1)?.state).toBe("cancel-requested");
  });

  it("组作用域不匹配的步骤不返回", async () => {
    const h = harness();
    await h.service.begin({ ...step, nodeId: "node", requestId: "req-1", runId: "run-1", rootGroupId: "group-a", scopeEpoch: 1 });
    const result = await h.service.snapshot({ ...step, rootGroupId: "group-b", scopeEpoch: 2 });
    expect(result).toMatchObject({ ok: false, code: "skill-step-not-found" });
  });

  it("服务重启后从持久事实恢复，不重新提交 run", async () => {
    const h = harness();
    await beginFirst(h);
    const reopened = new SqliteSkillMediaStore({ path: h.path });
    // 通过同一文件重新构造 service（这里以新 store 读取同一数据库）。
    const reopenedService = createSkillMediaService({ store: reopened, canvas: h.canvas, deriveRunId: ({ requestId }) => `run-${requestId}` });
    const result = await reopenedService.snapshot(step);
    expect(result.ok && result.step.currentRunId).toBe("run-1");
    expect(h.calls.filter((call) => call.startsWith("run:"))).toHaveLength(0);
    reopened.close();
  });
});
