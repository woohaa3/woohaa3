/**
 * 画布重命名提交器测试
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 4.3 / 4.4）。
 */
import { describe, expect, it, vi } from "vitest";
import { submitCanvasRename } from "./rename.js";
import type { CanvasSession } from "../../contract/session.js";
import type { CommandHandle } from "../../services/canvas-state/index.js";

function fakeSession(options: {
  writable?: boolean;
  submit?: (commands: readonly unknown[], commandId: string) =>
    | { ok: true; handle: CommandHandle }
    | { ok: false; reason: string; code?: string };
}): { session: CanvasSession; calls: Array<{ commands: readonly unknown[]; commandId: string }> } {
  const calls: Array<{ commands: readonly unknown[]; commandId: string }> = [];
  const session = {
    getStatus: () => ({ phase: "ready", error: null, hydrated: true, remote: { mode: "remote", phase: "synced", confirmedRevision: 0, pendingCount: 0, error: null } }),
    subscribe: () => () => undefined,
    retry: async () => undefined,
    requestHydrate: () => undefined,
    commandLifecycle: () => null,
    submitCommands: (commands: readonly unknown[], commandId: string) => {
      calls.push({ commands, commandId });
      if (options.submit) return options.submit(commands, commandId);
      return { ok: true as const, handle: handle("committed") };
    },
    isWritable: () => options.writable ?? true,
    shutdown: () => undefined
  } as unknown as CanvasSession;
  return { session, calls };
}

function handle(state: CommandHandle["state"], error: string | null = null): CommandHandle {
  const base: CommandHandle = {
    commandId: "c",
    state,
    baseRevision: 0,
    resultRevision: null,
    error,
    settled: Promise.resolve(null as unknown as CommandHandle)
  };
  base.settled = Promise.resolve(base);
  return base;
}

describe("submitCanvasRename", () => {
  it("committed 时提交单条 canvas.setTitle 并返回成功", async () => {
    const { session, calls } = fakeSession({});
    const result = await submitCanvasRename({ session, title: "  新标题  ", commandId: "cmd-1" });
    expect(result).toEqual({ ok: true, title: "新标题" });
    expect(calls[0]).toEqual({ commands: [{ type: "canvas.setTitle", title: "新标题" }], commandId: "cmd-1" });
  });

  it("空标题在发送前被拒绝", async () => {
    const { session, calls } = fakeSession({});
    const result = await submitCanvasRename({ session, title: "   " });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("offline-readonly 不提交", async () => {
    const { session, calls } = fakeSession({ writable: false });
    const result = await submitCanvasRename({ session, title: "x" });
    expect(result).toMatchObject({ ok: false, code: "offline-readonly" });
    expect(calls).toHaveLength(0);
  });

  it("rejected 返回安全错误", async () => {
    const { session } = fakeSession({
      submit: () => ({ ok: true, handle: handle("rejected", "标题非法") })
    });
    const result = await submitCanvasRename({ session, title: "x" });
    expect(result).toMatchObject({ ok: false, code: "rejected", error: "标题非法" });
  });

  it("submitCommands 失败时透传 code", async () => {
    const { session } = fakeSession({
      submit: () => ({ ok: false, reason: "画布尚未连接", code: "not-connected" })
    });
    const result = await submitCanvasRename({ session, title: "x" });
    expect(result).toMatchObject({ ok: false, code: "not-connected" });
  });
});

void vi;
