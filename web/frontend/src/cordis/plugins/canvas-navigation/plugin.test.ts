import { expect, it, vi } from "vitest";
import { startFrontendRuntime } from "../../kernel.js";
import { DialogService } from "../../services/dialogs/service.js";
import { CanvasNavigationStore } from "../../navigation/store.js";
import { FocusExitCoordinator } from "../../navigation/exit-coordinator.js";
import { canvasNavigationExtension } from "./plugin.js";

it("当前目标助手保留脏编辑会话，其他目标和弹窗仍受退出门禁保护", async () => {
  const dialogs = new DialogService();
  for (const id of ["agent-assistant", "other"]) dialogs.registerDialog(id, { definition: { validatePayload: payload => ({ ok: true, payload }) } });
  const navigation = new CanvasNavigationStore();
  navigation.setFocusAdapter({ apply: () => ({ ok: true }), isFocused: () => true });
  navigation.enterNodeFocus({ nodeId: "node", kind: "model" });
  const focusExit = new FocusExitCoordinator();
  const prepare = vi.fn(async () => ({ ok: true as const }));
  focusExit.register({ id: "model", hasUnsavedChanges: () => true, prepare });
  const runtime = await startFrontendRuntime({ installPlatform: ctx => {
    ctx.provide("dialogs" as never, dialogs as never);
    ctx.provide("inputScopes" as never, { addScope: () => () => {} } as never);
  }, plugins: [{ id: "canvas-navigation", required: true, plugin: canvasNavigationExtension({ navigation, focusExit }) }] });
  try {
    expect(dialogs.open({ dialogId: "other", payload: {} }).ok).toBe(false);
    expect(dialogs.open({ dialogId: "agent-assistant", payload: { nodeId: "other-node" } }).ok).toBe(false);
    expect(dialogs.open({ dialogId: "agent-assistant", payload: { nodeId: "node" } }).ok).toBe(true);
    expect(navigation.getSnapshot().mode).toMatchObject({ type: "node-focus", nodeId: "node" });
    expect(focusExit.hasUnsavedChanges()).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    dialogs.close();
    navigation.exitNodeFocus();
    navigation.registerPanel({ type: "node-execution", owner: "task-execution", render: () => null });
    navigation.openPanel({ type: "node-execution", nodeId: "node" });
    expect(dialogs.open({ dialogId: "agent-assistant", payload: { nodeId: "node" } }).ok).toBe(true);
    expect(navigation.getSnapshot().panel).toMatchObject({ type: "node-execution", nodeId: "node" });
  } finally { await runtime.dispose(); }
});

it("仅可信同画布图片 owner 可保留 dirty 会话，普通、跨目标和伪造 payload 均被拒绝", async () => {
  const dialogs = new DialogService();
  const navigation = new CanvasNavigationStore();
  navigation.setFocusAdapter({ apply: () => ({ ok: true }), isFocused: () => true });
  navigation.enterNodeFocus({ nodeId: "image", kind: "image" });
  const focusExit = new FocusExitCoordinator();
  const prepare = vi.fn(async () => ({ ok: true as const }));
  focusExit.register({ id: "image", hasUnsavedChanges: () => true, prepare });
  let owner: import("../../services/dialogs/types.js").DialogEditingOwner | null = { canvasId: "canvas", nodeId: "image", sessionId: "session" };
  dialogs.registerDialog("internal", { definition: { editingOwner: () => owner, validatePayload: payload => ({ ok: true, payload }) } });
  dialogs.registerDialog("ordinary", { definition: { validatePayload: payload => ({ ok: true, payload }) } });
  const runtime = await startFrontendRuntime({ installPlatform: ctx => {
    ctx.provide("dialogs" as never, dialogs as never);
    ctx.provide("canvasScope" as never, { canvasId: () => "canvas" } as never);
    ctx.provide("inputScopes" as never, { addScope: () => () => {} } as never);
  }, plugins: [{ id: "canvas-navigation", required: true, plugin: canvasNavigationExtension({ navigation, focusExit }) }] });
  try {
    expect(dialogs.open({ dialogId: "ordinary", payload: {editingOwner:owner} }).ok).toBe(false);
    expect(dialogs.open({ dialogId: "internal" }).ok).toBe(true);
    expect(navigation.getSnapshot().mode).toMatchObject({ nodeId:"image", owner:"direct" });
    expect(prepare).not.toHaveBeenCalled(); expect(focusExit.hasUnsavedChanges()).toBe(true);
    dialogs.close();
    for (const invalid of [null, {canvasId:"other",nodeId:"image",sessionId:"session"}, {canvasId:"canvas",nodeId:"other",sessionId:"session"}, {canvasId:"canvas",nodeId:"image",sessionId:""}]) {
      owner = invalid;
      expect(dialogs.open({ dialogId: "internal" }).ok).toBe(false);
      expect(dialogs.top()).toBeNull();
    }
  } finally { await runtime.dispose(); }
});
