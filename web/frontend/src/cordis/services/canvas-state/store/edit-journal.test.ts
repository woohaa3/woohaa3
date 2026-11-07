/**
 * Edit Journal 测试
 * （change: 2026-10-09-improve-canvas-workflow，任务 1.5；
 *  change: 2026-11-06-nonblocking-canvas-edit-history，任务 5.1）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  EditJournal,
  EDIT_JOURNAL_MAX_BYTES,
  EDIT_JOURNAL_MAX_ENTRIES,
  EDIT_JOURNAL_MAX_PENDING_ENTRIES,
  type JournalPlannedEdit,
  type JournalSettleOutcome
} from "./edit-journal.js";

const NOOP_EDIT: JournalPlannedEdit = { preconditions: [], operations: [] };
const COMMITTED: JournalSettleOutcome = { ok: true, committed: true };
const NO_CHANGE: JournalSettleOutcome = { ok: true, committed: false };
const REJECTED: JournalSettleOutcome = { ok: false, reason: "被拒绝" };

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function makeJournal(overrides: Partial<ConstructorParameters<typeof EditJournal>[0]> = {}) {
  const submitted: { commandId: string; edit: JournalPlannedEdit }[] = [];
  const settlements: { resolve: (value: JournalSettleOutcome) => void }[] = [];
  let writable = true;
  let id = 0;
  const journal = new EditJournal({
    isWritable: () => writable,
    hasNetChange: () => true,
    submitGuarded: (input) => {
      submitted.push(input);
      let resolve!: (value: JournalSettleOutcome) => void;
      const settled = new Promise<JournalSettleOutcome>((done) => { resolve = done; });
      settlements.push({ resolve });
      return { ok: true, settled };
    },
    generateCommandId: () => `id-${++id}`,
    ...overrides
  });
  return {
    journal,
    submitted,
    settlements,
    setWritable: (value: boolean) => { writable = value; },
    settle: async (index: number, outcome: JournalSettleOutcome) => {
      settlements[index]!.resolve(outcome);
      await tick();
    },
    settleLatest: async (outcome: JournalSettleOutcome) => {
      settlements[settlements.length - 1]!.resolve(outcome);
      await tick();
    }
  };
}

const handlers = { apply: async () => ({ ok: true as const }) };

describe("Edit Journal 非阻塞队列", () => {
  it("连续两次入队均立即成功，发送顺序与提交顺序一致", async () => {
    const harness = makeJournal();
    const first = await harness.journal.recordAndSubmit({ label: "A", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    const second = await harness.journal.recordAndSubmit({ label: "B", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(harness.submitted).toHaveLength(1);
    expect(harness.journal.snapshot().pending.map(entry => entry.label)).toEqual(["A", "B"]);

    await harness.settle(0, COMMITTED);
    expect(harness.submitted).toHaveLength(2);
    expect(harness.submitted.map(item => item.commandId)).toEqual([
      "edit-forward:id-1",
      "edit-forward:id-2"
    ]);
    await harness.settle(1, COMMITTED);
    expect(harness.journal.size).toBe(2);
    expect(harness.journal.snapshot().undoLabel).toBe("B");
  });

  it("只有 committed 且有净变化的记录进入正式撤销栈", async () => {
    const harness = makeJournal();
    await harness.journal.recordAndSubmit({ label: "已确认", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(0, COMMITTED);
    expect(harness.journal.size).toBe(1);

    await harness.journal.recordAndSubmit({ label: "未确认", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    expect(harness.journal.snapshot().entries.map(entry => entry.label)).toEqual(["已确认"]);
    await harness.settle(1, NO_CHANGE);
    expect(harness.journal.size).toBe(1);
    expect(harness.journal.snapshot().pending).toHaveLength(0);
  });

  it("pending/unknown 只显示等待状态，不参与已确认历史", async () => {
    const harness = makeJournal();
    const recorded = await harness.journal.recordAndSubmit({ label: "等待", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    expect(recorded.ok).toBe(true);
    expect(harness.journal.size).toBe(0);
    expect(harness.journal.snapshot().canUndo).toBe(true);
    expect(harness.journal.snapshot().undoLabel).toBe("等待");
    expect(harness.journal.snapshot().pending[0]?.state).toBe("pending");
  });

  it("accepted 但本地 revision 尚未覆盖（committed:false）不算可撤销", async () => {
    const harness = makeJournal();
    const recorded = await harness.journal.recordAndSubmit({ label: "未确认", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(0, NO_CHANGE);
    expect(recorded.ok).toBe(true);
    expect(harness.journal.size).toBe(0);
    expect(harness.journal.snapshot().pending).toHaveLength(0);
  });

  it("rejected/no-op 不入栈，且 rejected 保留可跳过的冲突记录", async () => {
    const harness = makeJournal();
    await harness.journal.recordAndSubmit({ label: "A", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(0, COMMITTED);

    await harness.journal.recordAndSubmit({ label: "no-op", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(1, NO_CHANGE);
    expect(harness.journal.size).toBe(1);

    const rejected = await harness.journal.recordAndSubmit({ label: "rejected", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(2, REJECTED);
    expect(harness.journal.size).toBe(1);
    expect(harness.journal.snapshot().pending[0]).toMatchObject({ label: "rejected", state: "conflict" });
    if (rejected.ok) expect(harness.journal.skipConflict(rejected.entry.id)).toBe(true);
    expect(harness.journal.snapshot().pending).toHaveLength(0);
  });
});

describe("Edit Journal 容量与超大动作", () => {
  it("pending 队列达到 32 条后拒绝新动作，且不丢弃已有记录", async () => {    const harness = makeJournal();
    for (let i = 0; i < EDIT_JOURNAL_MAX_PENDING_ENTRIES; i += 1) {
      expect((await harness.journal.recordAndSubmit({ label: `${i}`, forward: NOOP_EDIT, inverse: NOOP_EDIT })).ok).toBe(true);
    }
    const overflow = await harness.journal.recordAndSubmit({ label: "overflow", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    expect(overflow).toMatchObject({ ok: false, code: "journal-full" });
    expect(harness.journal.pendingSize).toBe(EDIT_JOURNAL_MAX_PENDING_ENTRIES);
    harness.journal.clear();
  });

  it("pending 字节数独立于正式历史，超过 4 MiB 时结构化拒绝", async () => {
    const harness = makeJournal();
    const large: JournalPlannedEdit = {
      preconditions: [],
      operations: [{ kind: "node-data-set", nodeId: "n1", value: { title: "x".repeat(2_200_000) } }]
    };
    expect((await harness.journal.recordAndSubmit({ label: "large-1", forward: large, inverse: NOOP_EDIT })).ok).toBe(true);
    const second = await harness.journal.recordAndSubmit({ label: "large-2", forward: large, inverse: NOOP_EDIT });
    expect(second).toMatchObject({ ok: false, code: "journal-full" });
    harness.journal.clear();
  });

  it("pending 上限可通过依赖配置（默认值之外）", async () => {
    const harness = makeJournal({ maxPendingEntries: 1 });
    expect((await harness.journal.recordAndSubmit({ label: "first", forward: NOOP_EDIT, inverse: NOOP_EDIT })).ok).toBe(true);
    expect(await harness.journal.recordAndSubmit({ label: "second", forward: NOOP_EDIT, inverse: NOOP_EDIT })).toMatchObject({ ok: false, code: "journal-full" });
    harness.journal.clear();
  });

  it("超过 100 条移除最旧已结算记录", async () => {
    const harness = makeJournal();
    for (let i = 0; i < EDIT_JOURNAL_MAX_ENTRIES + 5; i += 1) {
      await harness.journal.recordAndSubmit({ label: `记录 ${i}`, forward: NOOP_EDIT, inverse: NOOP_EDIT });
      await harness.settleLatest(COMMITTED);
    }
    expect(harness.journal.size).toBe(EDIT_JOURNAL_MAX_ENTRIES);
    expect(harness.journal.snapshot().undoLabel).toBe(`记录 ${EDIT_JOURNAL_MAX_ENTRIES + 4}`);
  });

  it("单次载荷超过 16 MiB 在提交前拒绝，不宣称成功", async () => {
    const harness = makeJournal();
    const huge: JournalPlannedEdit = {
      preconditions: [],
      operations: [{ kind: "node-data-set", nodeId: "n1", value: { title: "x".repeat(EDIT_JOURNAL_MAX_BYTES + 1) } }]
    };
    const result = await harness.journal.recordAndSubmit({ label: "超大", forward: huge, inverse: NOOP_EDIT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("分批");
    expect(harness.submitted).toHaveLength(0);
    expect(harness.journal.size).toBe(0);
  });
});

describe("Edit Journal 断线、unknown 与重连对账", () => {
  it("断线把在途记录标为 unknown，不伪造 committed/rejected，并拒绝新的持久化动作", async () => {
    const harness = makeJournal();
    await harness.journal.recordAndSubmit({ label: "断线", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await tick();
    harness.setWritable(false);
    harness.journal.notifyConnection("interrupted");
    expect(harness.journal.snapshot().pending[0]?.state).toBe("unknown");
    expect(harness.journal.size).toBe(0);
    const blocked = await harness.journal.recordAndSubmit({ label: "断线后", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    expect(blocked.ok).toBe(false);
    await harness.journal.flush();
    harness.journal.clear();
  });

  it("重连后已提交但回执丢失：按 canonical 后置条件转 committed，不重发", async () => {
    const harness = makeJournal({ isEffectObserved: () => true });
    await harness.journal.recordAndSubmit({ label: "已生效", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await tick();
    harness.journal.notifyConnection("interrupted");
    harness.journal.notifyConnection("ready");
    await tick();
    expect(harness.submitted).toHaveLength(1);
    expect(harness.journal.size).toBe(1);
    expect(harness.journal.snapshot().pending).toHaveLength(0);
  });

  it("重连后确实未提交：沿用原 commandId 与相同 payload 重发", async () => {
    const harness = makeJournal({ isEffectObserved: () => false });
    await harness.journal.recordAndSubmit({ label: "未生效", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await tick();
    harness.journal.notifyConnection("interrupted");
    harness.journal.notifyConnection("ready");
    await tick();
    expect(harness.submitted).toHaveLength(2);
    expect(harness.submitted[1]!.commandId).toBe(harness.submitted[0]!.commandId);
    expect(harness.submitted[1]!.edit).toEqual(harness.submitted[0]!.edit);
    await harness.settleLatest(COMMITTED);
    expect(harness.journal.size).toBe(1);
  });

  it("迟到 rejected：回滚记录并阻断依赖同一实体的后续记录", async () => {
    const harness = makeJournal();
    const create: JournalPlannedEdit = {
      preconditions: [],
      operations: [{ kind: "node-add", node: { id: "n1", type: "image" } }]
    };
    const move: JournalPlannedEdit = {
      preconditions: [],
      operations: [{ kind: "node-update", nodeId: "n1", position: { x: 10, y: 10 } }]
    };
    await harness.journal.recordAndSubmit({ label: "创建", forward: create, inverse: NOOP_EDIT });
    await tick();
    await harness.journal.recordAndSubmit({ label: "移动", forward: move, inverse: NOOP_EDIT });
    await harness.settle(0, REJECTED);
    expect(harness.submitted).toHaveLength(1);
    const pending = harness.journal.snapshot().pending;
    expect(pending.map(entry => entry.label)).toEqual(["创建", "移动"]);
    expect(pending.every(entry => entry.state === "conflict")).toBe(true);
    expect(pending[1]?.error).toBeTruthy();
  });

  it("结算 watchdog 超时后记录仍为 unknown，队列不被永久占用", async () => {
    const probe = vi.fn();
    const harness = makeJournal({ settlementHintMs: 40, onSettlementTimeout: probe });
    await harness.journal.recordAndSubmit({ label: "慢响应", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(harness.journal.snapshot().pending[0]?.state).toBe("unknown");
    expect(harness.journal.snapshot().pending[0]?.slow).toBe(true);
    expect(probe).toHaveBeenCalled();
    await harness.journal.flush();
    const next = await harness.journal.recordAndSubmit({ label: "后续", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    expect(next.ok).toBe(true);
    harness.journal.clear();
  });
});

describe("Edit Journal 撤销/重做与 redo 语义", () => {
  it("pending 记录撤销：反向动作排在正向之后，确认后才移动指针", async () => {
    const harness = makeJournal();
    const recorded = await harness.journal.recordAndSubmit({ label: "移动", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    expect(recorded.ok).toBe(true);
    await tick();
    expect(harness.submitted).toHaveLength(1);

    const undone = await harness.journal.undo(handlers);
    expect(undone.ok).toBe(true);
    await tick();
    expect(harness.submitted).toHaveLength(1);
    expect(harness.journal.snapshot().canUndo).toBe(false);

    await harness.settle(0, COMMITTED);
    expect(harness.submitted).toHaveLength(2);
    expect(harness.journal.size).toBe(1);
    expect(harness.journal.snapshot().canRedo).toBe(false);

    await harness.settle(1, COMMITTED);
    expect(harness.journal.snapshot().canRedo).toBe(true);
    expect(harness.journal.snapshot().redoLabel).toBe("移动");
  });

  it("forward 被拒绝时 pending inverse 直接 dropped，不发送", async () => {
    const harness = makeJournal();
    await harness.journal.recordAndSubmit({ label: "创建", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await tick();
    expect((await harness.journal.undo(handlers)).ok).toBe(true);
    await harness.settle(0, REJECTED);
    expect(harness.submitted).toHaveLength(1);
    expect(harness.journal.snapshot().pending[0]).toMatchObject({ state: "conflict" });
    expect(harness.journal.snapshot().canUndo).toBe(false);
  });

  it("撤销 committed 记录：成功后移动指针，失败保持指针", async () => {
    const harness = makeJournal();
    await harness.journal.recordAndSubmit({ label: "A", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(0, COMMITTED);
    await harness.journal.recordAndSubmit({ label: "B", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(1, COMMITTED);
    expect(harness.journal.snapshot().undoLabel).toBe("B");

    expect((await harness.journal.undo(handlers)).ok).toBe(true);
    await tick();
    expect(harness.journal.snapshot().canUndo).toBe(false);
    await harness.settle(2, COMMITTED);
    expect(harness.journal.snapshot().canRedo).toBe(true);
    expect(harness.journal.snapshot().redoLabel).toBe("B");

    expect((await harness.journal.redo(handlers)).ok).toBe(true);
    await tick();
    await harness.settle(3, REJECTED);
    expect(harness.journal.snapshot().canRedo).toBe(true);
    expect(harness.journal.snapshot().blockedReason).toContain("跳过");
  });

  it("新净修改清空 redo；失败/no-op 不清空", async () => {
    const harness = makeJournal();
    await harness.journal.recordAndSubmit({ label: "A", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(0, COMMITTED);
    await harness.journal.recordAndSubmit({ label: "B", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(1, COMMITTED);
    await harness.journal.undo(handlers);
    await tick();
    await harness.settle(2, COMMITTED);
    expect(harness.journal.snapshot().canRedo).toBe(true);

    await harness.journal.recordAndSubmit({ label: "C", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(3, COMMITTED);
    expect(harness.journal.snapshot().canRedo).toBe(false);
  });

  it("冲突条目不自动跳过；显式跳过后后续记录可以继续 drain", async () => {
    const harness = makeJournal();
    const first = await harness.journal.recordAndSubmit({ label: "冲突", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.settle(0, REJECTED);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(harness.journal.snapshot().canUndo).toBe(false);
    expect(harness.journal.snapshot().blockedReason).toContain("跳过");
    expect(harness.journal.skipConflict(first.entry.id)).toBe(true);

    const next = await harness.journal.recordAndSubmit({ label: "后续", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    expect(next.ok).toBe(true);
    await harness.settleLatest(COMMITTED);
    expect(harness.journal.snapshot().undoLabel).toBe("后续");
  });
});

describe("Edit Journal 本地参数条目", () => {
  it("参数条目可直接撤销，不提交画布命令", async () => {
    const harness = makeJournal();
    harness.journal.recordParameter({ label: "撤销参数修改", nodeId: "n1", modelKey: "m1", before: { steps: 10 }, after: { steps: 20 } });
    expect(harness.journal.size).toBe(1);
    const applied: Record<string, unknown>[] = [];
    const result = await harness.journal.undo({
      apply: async (entry) => {
        if (entry.kind === "parameter") applied.push(entry.before);
        return { ok: true };
      }
    });
    expect(result.ok).toBe(true);
    expect(applied).toEqual([{ steps: 10 }]);
    expect(harness.submitted).toHaveLength(0);
  });
});

describe("Edit Journal 会话清理", () => {
  it("clear 清空全部记录与等待队列", async () => {
    const harness = makeJournal();
    await harness.journal.recordAndSubmit({ label: "A", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    harness.journal.clear();
    expect(harness.journal.size).toBe(0);
    expect(harness.journal.pendingSize).toBe(0);
    expect(harness.journal.snapshot().canUndo).toBe(false);
    expect(harness.journal.snapshot().canRedo).toBe(false);
  });
});

describe("Edit Journal 外部权威动作", () => {
  it("verified external entries share the same cursor and move only after confirmed replay", async () => {
    const harness = makeJournal();
    const undo = vi.fn(async () => ({ ok: true as const }));
    const redo = vi.fn(async () => ({ ok: true as const }));
    expect(harness.journal.recordExternal({ id: "scene-area:op", label: "搬动场景", undo, redo }).ok).toBe(true);
    expect(harness.journal.recordExternal({ id: "scene-area:op", label: "搬动场景", undo, redo }).ok).toBe(true);
    expect(harness.journal.size).toBe(1);
    const externalHandlers = {
      apply: async (entry: ReturnType<typeof harness.journal.snapshot>["entries"][number], direction: -1 | 1) =>
        entry.kind === "external" ? (direction === -1 ? entry.undo() : entry.redo()) : { ok: false as const, reason: "unexpected entry" }
    };
    expect((await harness.journal.undo(externalHandlers)).ok).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(harness.journal.snapshot()).toMatchObject({ canUndo: false, canRedo: true });
    expect((await harness.journal.redo(externalHandlers)).ok).toBe(true);
    expect(redo).toHaveBeenCalledTimes(1);
    expect(harness.journal.snapshot()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it("keeps the cursor when the authority replay is version-conflicted", async () => {
    const harness = makeJournal();
    harness.journal.recordExternal({
      id: "world-camera:op",
      label: "调整镜头设置",
      undo: async () => ({ ok: false as const, reason: "版本冲突" }),
      redo: async () => ({ ok: true as const })
    });
    const externalHandlers = {
      apply: async (entry: ReturnType<typeof harness.journal.snapshot>["entries"][number], direction: -1 | 1) =>
        entry.kind === "external" ? (direction === -1 ? entry.undo() : entry.redo()) : { ok: false as const, reason: "unexpected entry" }
    };
    expect((await harness.journal.undo(externalHandlers)).ok).toBe(false);
    expect(harness.journal.snapshot()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it("releases trimmed plans and rejects authoritative duplicate receipts", async () => {
    const harness = makeJournal();
    const run = async () => ({ ok: true as const, label: "conversion", forward: NOOP_EDIT, inverse: NOOP_EDIT });
    await harness.journal.adoptExternal("old", run);
    for (let i = 0; i < EDIT_JOURNAL_MAX_ENTRIES; i += 1) {
      await harness.journal.recordAndSubmit({ label: `${i}`, forward: NOOP_EDIT, inverse: NOOP_EDIT });
      await harness.settleLatest(COMMITTED);
    }
    expect(harness.journal.snapshot().entries.some(entry => entry.id === "old")).toBe(false);
    expect((await harness.journal.adoptExternal("old", async () => ({ ...await run(), allowNew: false }))).ok).toBe(false);
  });
});
