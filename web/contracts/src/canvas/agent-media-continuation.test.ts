import { describe, expect, it } from "vitest";
import {
  applySkillMediaTransition,
  canTransitionSkillMediaState,
  decodeSkillStepUpdatedEvent,
  encodeSkillStepUpdatedEvent,
  isSafeSkillMediaText,
  type SkillStepUpdatedEvent
} from "./agent-media-continuation.js";

const event: SkillStepUpdatedEvent = {
  type: "skill-step-updated",
  canvasId: "canvas-1",
  nodeId: "node-1",
  skillRunId: "skill-1",
  stepId: "image-step",
  attempt: 2,
  promptRevision: 2,
  state: "running",
  current: true,
  superseded: false,
  runId: "run-2",
  progress: 40,
  at: "2026-10-28T00:00:00.000Z"
};

describe("Skill 媒体步骤状态转换", () => {
  it.each([
    ["queued", "running"],
    ["running", "cancel-requested"],
    ["cancel-requested", "cancelled"],
    ["queued", "superseded"]
  ] as const)("%s → %s 合法", (from, to) => {
    expect(canTransitionSkillMediaState(from, to)).toBe(true);
    expect(applySkillMediaTransition({ state: from }, to)).toEqual({ ok: true, state: to, changed: true });
  });

  it.each([
    ["succeeded", "running"],
    ["succeeded", "failed"],
    ["cancelled", "running"],
    ["superseded", "succeeded"],
    ["failed", "running"]
  ] as const)("终态 %s → %s 非法回退", (from, to) => {
    expect(canTransitionSkillMediaState(from, to)).toBe(false);
    expect(applySkillMediaTransition({ state: from }, to)).toMatchObject({ ok: false, code: "illegal-transition" });
  });

  it("重复设置同一状态是幂等 no-op", () => {
    expect(applySkillMediaTransition({ state: "running" }, "running")).toEqual({ ok: true, state: "running", changed: false });
  });

  it("cancel-requested 不是终态，仍可等到权威取消/失败/成功", () => {
    expect(canTransitionSkillMediaState("cancel-requested", "cancelled")).toBe(true);
    expect(canTransitionSkillMediaState("cancel-requested", "succeeded")).toBe(true);
    expect(canTransitionSkillMediaState("cancel-requested", "running")).toBe(false);
  });
});

describe("skill-step-updated 事件 codec", () => {
  it("编码后可严格解码并保留可选字段", () => {
    const encoded = encodeSkillStepUpdatedEvent(event);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(decodeSkillStepUpdatedEvent(encoded.payload)).toEqual({ ok: true, value: event });
  });

  it("旧 payload 缺少新可选字段仍可解码", () => {
    const legacy = {
      type: "skill-step-updated",
      canvasId: "canvas-1",
      nodeId: "node-1",
      skillRunId: "skill-1",
      stepId: "image-step",
      attempt: 1,
      promptRevision: 1,
      state: "queued",
      current: true,
      superseded: false,
      at: "2026-10-28T00:00:00.000Z"
    };
    expect(decodeSkillStepUpdatedEvent(legacy)).toMatchObject({ ok: true, value: { state: "queued", attempt: 1 } });
  });

  it.each([
    { error: "https://cos.example.com/a.png?signature=x" },
    { error: "generation-outputs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" },
    { error: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { error: "data:image/png;base64,AAAA" },
    { error: "blob:http://localhost/x" },
    { jobId: "https://internal.example/job" }
  ])("拒绝把秘密/内部 locator 带入事件：%j", (patch) => {
    const encoded = encodeSkillStepUpdatedEvent({ ...event, ...patch });
    expect(encoded).toMatchObject({ ok: false, code: "malformed-event" });
  });

  it("旧 payload 里的 unknown 状态归一为 failed", () => {
    expect(decodeSkillStepUpdatedEvent({ ...event, state: "unknown" }))
      .toMatchObject({ ok: true, value: { state: "failed" } });
  });

  it("拒绝未知字段与非法状态", () => {
    expect(decodeSkillStepUpdatedEvent({ ...event, prompt: "完整提示词" })).toMatchObject({ ok: false });
    expect(decodeSkillStepUpdatedEvent({ ...event, state: "paused" })).toMatchObject({ ok: false });
  });

  it("同源相对媒体引用本身不是秘密，但不得出现在事件 error 中", () => {
    expect(isSafeSkillMediaText("/api/media/opaque-token")).toBe(true);
    expect(isSafeSkillMediaText("https://cdn.example/a.png")).toBe(false);
  });
});
