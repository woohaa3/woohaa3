/**
 * 同步状态展示模型单测
 * （change: 2026-09-28-move-sync-status-to-corner-panel；
 *   2026-09-29-move-mcp-guide-to-bottom-hint：气泡不再承载 MCP 指引；
 *   2026-10-21-recover-canvas-connection-explicitly：断线区分来源并给出显式重连动作）。
 */
import { describe, expect, it } from "vitest";
import { syncStatusView, type SyncStatusInput } from "./sync-status.js";

function input(patch: Partial<SyncStatusInput> = {}): SyncStatusInput {
  return {
    mode: "remote",
    phase: "synced",
    pendingCount: 0,
    error: null,
    revision: 3,
    ...patch
  };
}

describe("syncStatusView", () => {
  it("稳态：ok、pinned=false、detail 含 revision、无动作", () => {
    const view = syncStatusView(input());
    expect(view.tone).toBe("ok");
    expect(view.pinned).toBe(false);
    expect(view.detail).toContain("revision 3");
    expect(view.action).toBeUndefined();
  });

  it("有待保存：warning、pinned=true、label 含待保存项数、无动作", () => {
    const view = syncStatusView(input({ pendingCount: 2 }));
    expect(view.tone).toBe("warning");
    expect(view.pinned).toBe(true);
    expect(view.label).toContain("2");
    expect(view.label).toContain("待保存");
    expect(view.action).toBeUndefined();
  });

  it("断线（会话被关闭，缺省来源）：danger、pinned=true、稳定文案并带重连动作", () => {
    for (const patch of [
      { mode: "offline" as const },
      { phase: "offline" as const },
      { mode: "offline" as const, offlineReason: "session-closed" as const }
    ]) {
      const view = syncStatusView(input(patch));
      expect(view.tone).toBe("danger");
      expect(view.pinned).toBe(true);
      expect(view.label).toBe("画布连接已断开，只读");
      expect(view.detail).toContain("只读");
      expect(view.action).toEqual({ kind: "reconnect", label: "重新连接", busy: false });
    }
  });

  it("断线（浏览器断网）：文案区分为网络断开，同样带重连动作", () => {
    const view = syncStatusView(input({ mode: "offline", offlineReason: "browser-offline" }));
    expect(view.tone).toBe("danger");
    expect(view.pinned).toBe(true);
    expect(view.label).toBe("网络已断开，画布只读");
    expect(view.detail).toBe("网络已断开，画布只读。");
    expect(view.action).toEqual({ kind: "reconnect", label: "重新连接", busy: false });
  });

  it("重建中优先于断线：warning、文案为正在重连、动作置灰", () => {
    const view = syncStatusView(input({ mode: "offline", reconnecting: true }));
    expect(view.tone).toBe("warning");
    expect(view.pinned).toBe(true);
    expect(view.label).toBe("正在重新连接…");
    expect(view.action).toEqual({ kind: "reconnect", label: "重新连接", busy: true });
  });

  it("同步错误：danger、pinned=true、携带错误信息并带重连动作", () => {
    const view = syncStatusView(input({ error: "连接失败" }));
    expect(view.tone).toBe("danger");
    expect(view.pinned).toBe(true);
    expect(view.detail).toContain("连接失败");
    expect(view.action).toEqual({ kind: "reconnect", label: "重新连接", busy: false });
  });

  it("同步不可用（disabled）：danger、pinned=true、无动作", () => {
    const view = syncStatusView(input({ mode: "disabled" }));
    expect(view.tone).toBe("danger");
    expect(view.pinned).toBe(true);
    expect(view.action).toBeUndefined();
  });

  it("同步中：warning、pinned=true、无动作", () => {
    const view = syncStatusView(input({ phase: "syncing" }));
    expect(view.tone).toBe("warning");
    expect(view.pinned).toBe(true);
    expect(view.action).toBeUndefined();
  });

  it("断线优先于待保存", () => {
    const view = syncStatusView(input({ mode: "offline", pendingCount: 3 }));
    expect(view.label).toBe("画布连接已断开，只读");
    expect(view.action?.busy).toBe(false);
  });

  it("气泡只承载同步信息，不含 MCP 指引（已移到页面级底部提示）", () => {
    for (const patch of [
      {},
      { pendingCount: 2 },
      { mode: "offline" as const },
      { mode: "offline" as const, offlineReason: "browser-offline" as const, reconnecting: true },
      { error: "连接失败" },
      { phase: "syncing" as const }
    ]) {
      const view = syncStatusView(input(patch));
      expect(view.detail).not.toContain("MCP");
      expect(view.detail).not.toContain("/mcp/model-canvas");
    }
  });
});
