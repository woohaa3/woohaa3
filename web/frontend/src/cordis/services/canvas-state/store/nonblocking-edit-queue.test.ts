/**
 * 非阻塞编辑队列与 working projection 的集成测试
 * （change: 2026-11-06-nonblocking-canvas-edit-history，任务 2.2 / 2.3 / 3.2 / 5.2）。
 */
import { describe, expect, it } from "vitest";
import { applyCanvasCommands, createEmptyWoohaa3ServerCanvas, type CanvasCommand, type ServerCanvas } from "@woohaa3/contracts";
import type { CanvasSession, CanvasSessionStatus } from "../../../contracts.js";
import { WorkingProjectionStore } from "./working-projection.js";
import { createCanvasEditService } from "./canvas-edit-service.js";

const NOW = "2026-11-06T00:00:00.000Z";

type Handle = {
  resolve: (value: { state: "committed" | "rejected"; error: string | null; resultRevision?: number }) => void;
};

function readyStatus(phase: "synced" | "syncing" | "offline" = "synced"): CanvasSessionStatus {
  return {
    phase: "ready",
    error: null,
    hydrated: true,
    remote: {
      mode: phase === "offline" ? "offline" : "remote",
      phase,
      confirmedRevision: 0,
      pendingCount: 0,
      error: null,
      readOnly: false
    }
  };
}

function makeSession() {
  let canonical: ServerCanvas = createEmptyWoohaa3ServerCanvas("c", NOW);
  const projection = new WorkingProjectionStore();
  projection.applyCanonical(canonical);
  const submitted: { commandId: string; commands: readonly CanvasCommand[] }[] = [];
  const handles = new Map<string, Handle>();
  const listeners = new Set<(status: CanvasSessionStatus) => void>();
  let status = readyStatus();
  const emit = () => { for (const listener of listeners) listener(status); };

  const session = {
    getStatus: () => status,
    subscribe: (listener: (value: CanvasSessionStatus) => void) => {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    isWritable: () => status.remote.phase === "synced" && !status.remote.readOnly,
    commandLifecycle: () => null,
    submitCommands: (commands: readonly CanvasCommand[], commandId: string) => {
      const appended = projection.appendBatch({
        commandId,
        commands,
        baseRevision: canonical.revision,
        submittedAt: NOW
      });
      if (!appended.ok) return { ok: false as const, reason: appended.message, code: appended.code };
      submitted.push({ commandId, commands });
      let resolve!: Handle["resolve"];
      const settled = new Promise<{ state: "committed" | "rejected"; error: string | null; resultRevision?: number }>((done) => { resolve = done; });
      handles.set(commandId, { resolve });
      return { ok: true as const, handle: { commandId, settled } };
    }
  } as unknown as CanvasSession;

  return {
    session,
    projection,
    submitted,
    get canonical() { return canonical; },
    setConnection: (next: "synced" | "offline" | "syncing") => {
      status = readyStatus(next);
      emit();
    },
    /** canonical 已包含该命令效果（服务端提交成功，回执可能丢失）。 */
    commitCanonical: (commandId: string) => {
      const entry = submitted.find((item) => item.commandId === commandId);
      if (!entry) throw new Error(`unknown command ${commandId}`);
      const applied = applyCanvasCommands(canonical, entry.commands, { now: NOW });
      if (!applied.ok) throw new Error(applied.rejection.message);
      canonical = applied.canvas;
      projection.applyCanonical(canonical);
    },
    resolve: async (commandId: string, outcome: "committed" | "rejected", error: string | null = null, resultRevision?: number) => {
      handles.get(commandId)?.resolve({ state: outcome, error, resultRevision });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
    rejectWorking: (commandId: string) => {
      projection.applyResult({ commandId, status: "rejected", error: "被拒绝" });
    }
  };
}

const CREATE: CanvasCommand[] = [{ type: "node.add", node: { id: "n1", type: "image", position: { x: 0, y: 0 } } }];
const MOVE: CanvasCommand[] = [{ type: "node.update", nodeId: "n1", position: { x: 50, y: 20 } }];

describe("非阻塞编辑队列与 working projection", () => {
  it("uses the accepted revision to place a late-settling local edit before a newer external receipt", async () => {
    const harness = makeSession();
    const edit = createCanvasEditService({ session: harness.session, getCanvas: () => harness.canonical, getWorkingCanvas: () => harness.projection.workingCanvas });
    expect((await edit.record(CREATE, 'local')).ok).toBe(true);
    edit.recordExternal({ id: 'later', label: 'later', revision: 30, undo: async () => ({ ok: true }), redo: async () => ({ ok: true }) });
    await harness.resolve(harness.submitted[0]!.commandId, 'committed', null, 20);
    expect(edit.getSnapshot().undoLabel).toBe('later');
  });
  it("创建节点后立即移动：基于 workingCanvas 规划并保持发送顺序", async () => {
    const harness = makeSession();
    const edit = createCanvasEditService({
      session: harness.session,
      getCanvas: () => harness.canonical,
      getWorkingCanvas: () => harness.projection.workingCanvas
    });
    const created = await edit.record(CREATE, "创建作品");
    const moved = await edit.record(MOVE, "移动作品");
    expect(created.ok).toBe(true);
    expect(moved.ok).toBe(true);
    expect(harness.submitted).toHaveLength(1);
    expect(harness.projection.workingCanvas?.document.nodes.map(node => node.id)).toEqual(["n1"]);

    await harness.resolve(harness.submitted[0]!.commandId, "committed");
    expect(harness.submitted).toHaveLength(2);
    const moveCommand = harness.submitted[1]!.commands[0];
    expect(moveCommand).toMatchObject({ type: "edit.apply" });
    if (moveCommand.type !== "edit.apply") return;
    expect(moveCommand.operations[0]).toMatchObject({ kind: "node-update", nodeId: "n1", position: { x: 50, y: 20 } });
    await harness.resolve(harness.submitted[1]!.commandId, "committed");
    expect(edit.getSnapshot().canUndo).toBe(true);
  });

  it("创建后立即撤销：反向 edit 基于入队后的 workingCanvas 规划", async () => {
    const harness = makeSession();
    const edit = createCanvasEditService({
      session: harness.session,
      getCanvas: () => harness.canonical,
      getWorkingCanvas: () => harness.projection.workingCanvas
    });
    expect((await edit.record(CREATE, "创建作品")).ok).toBe(true);
    await harness.resolve(harness.submitted[0]!.commandId, "committed");
    expect(edit.getSnapshot().canUndo).toBe(true);

    expect((await edit.undo()).ok).toBe(true);
    expect(harness.submitted).toHaveLength(2);
    const inverse = harness.submitted[1]!.commands[0];
    expect(inverse.type).toBe("edit.apply");
    if (inverse.type !== "edit.apply") return;
    expect(inverse.operations[0]).toMatchObject({ kind: "node-remove", nodeIds: ["n1"] });
    await harness.resolve(harness.submitted[1]!.commandId, "committed");
    expect(edit.getSnapshot().canRedo).toBe(true);
  });

  it("前序创建被拒绝：回滚 working effect，后续依赖记录进入 conflict 且不再发送", async () => {
    const harness = makeSession();
    const edit = createCanvasEditService({
      session: harness.session,
      getCanvas: () => harness.canonical,
      getWorkingCanvas: () => harness.projection.workingCanvas
    });
    expect((await edit.record(CREATE, "创建作品")).ok).toBe(true);
    expect((await edit.record(MOVE, "移动作品")).ok).toBe(true);
    expect(harness.projection.workingCanvas?.document.nodes.map(node => node.id)).toEqual(["n1"]);

    const createCommandId = harness.submitted[0]!.commandId;
    harness.rejectWorking(createCommandId);
    await harness.resolve(createCommandId, "rejected", "创建被拒绝");

    expect(harness.submitted).toHaveLength(1);
    expect(harness.projection.workingCanvas?.document.nodes).toHaveLength(0);
    const pending = edit.getSnapshot().pending;
    expect(pending.map(entry => entry.state)).toEqual(["conflict", "conflict"]);
    expect(pending[1]?.error).toBeTruthy();
    expect(edit.getSnapshot().canUndo).toBe(false);
  });

  it("断线重连：已提交但回执丢失时按 canonical 对账，不生成第二条命令", async () => {
    const harness = makeSession();
    const edit = createCanvasEditService({
      session: harness.session,
      getCanvas: () => harness.canonical,
      getWorkingCanvas: () => harness.projection.workingCanvas
    });
    expect((await edit.record(CREATE, "创建作品")).ok).toBe(true);
    const commandId = harness.submitted[0]!.commandId;

    harness.setConnection("offline");
    expect(edit.getSnapshot().pending[0]?.state).toBe("unknown");

    harness.commitCanonical(commandId);
    harness.setConnection("synced");
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(harness.submitted).toHaveLength(1);
    expect(edit.getSnapshot().size).toBe(1);
    expect(edit.getSnapshot().pending).toHaveLength(0);
  });

  it("断线重连：确实未提交时沿用原 commandId 与相同 payload 重发", async () => {
    const harness = makeSession();
    const edit = createCanvasEditService({
      session: harness.session,
      getCanvas: () => harness.canonical,
      getWorkingCanvas: () => harness.projection.workingCanvas
    });
    expect((await edit.record(CREATE, "创建作品")).ok).toBe(true);
    const commandId = harness.submitted[0]!.commandId;

    harness.setConnection("offline");
    expect(edit.getSnapshot().pending[0]?.state).toBe("unknown");
    harness.setConnection("synced");
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(harness.submitted).toHaveLength(2);
    expect(harness.submitted[1]!.commandId).toBe(commandId);
    expect(harness.submitted[1]!.commands).toEqual(harness.submitted[0]!.commands);
    await harness.resolve(commandId, "committed");
    expect(edit.getSnapshot().size).toBe(1);
  });
});
