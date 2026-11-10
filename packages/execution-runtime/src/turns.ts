/**
 * 回合执行与事件 journal。
 *
 * 只负责一次执行的排队、事件游标、终态与取消；不解释角色、画布或媒体语义。
 * 状态写入 `turns.json`，事件写入 `events/<turnId>.jsonl`，daemon 重启后可读历史，
 * 但不会自动重跑中断的执行。
 */
import fs from "node:fs";
import path from "node:path";
import { hashKey } from "./endpoints.js";
import type {
  Executor,
  ExecutorHostPort,
  ExecutorOutcome,
  ExecutorProcessPort,
  RuntimeEvent,
  TurnError,
  TurnRunInput,
  TurnView
} from "./protocol.js";

type TurnRecord = TurnView & {
  events: RuntimeEvent[];
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};

const MAX_EVENTS = 2_000;

export type TurnStoreOptions = {
  stateDir: string;
  logger?: (event: Record<string, unknown>) => void;
};

export type TurnRuntimeDeps = {
  stateDir: string;
  workspaceKey: string;
  processes: ExecutorProcessPort;
  hostFor?: (input: TurnRunInput) => ExecutorHostPort | null;
};

export class TurnStore {
  private readonly journalDir: string;
  private readonly ledgerPath: string;
  private readonly pending = new Map<string, Promise<void>>();
  private readonly turns = new Map<string, TurnRecord>();

  constructor(options: TurnStoreOptions) {
    this.journalDir = path.join(options.stateDir, "turns");
    fs.mkdirSync(this.journalDir, { recursive: true, mode: 0o700 });
    this.ledgerPath = path.join(options.stateDir, "turns.json");
    this.load();
  }

  private load(): void {
    let stored: unknown = null;
    try { stored = JSON.parse(fs.readFileSync(this.ledgerPath, "utf8")); } catch { stored = null; }
    const views = Array.isArray((stored as { turns?: unknown })?.turns)
      ? ((stored as { turns: TurnView[] }).turns)
      : [];
    for (const view of views) {
      if (!view || typeof view.turnId !== "string") continue;
      const record: TurnRecord = {
        ...view,
        events: this.readEvents(view.turnId)
      };
      // 进程内执行不可能跨 daemon 重启续跑：中断状态按失败保留，不假装成功。
      if (record.status === "queued" || record.status === "running") {
        record.status = "failed";
        record.error = { code: "executor-restarted", message: "执行进程已重启，原回合中断；原记录保留，不自动重跑" };
        record.updatedAt = new Date().toISOString();
        this.appendEvent(record, "failed", record.error);
      }
      this.turns.set(record.turnId, record);
    }
    this.save();
  }

  private readEvents(turnId: string, limit = MAX_EVENTS): RuntimeEvent[] {
    try {
      const lines = fs.readFileSync(this.eventPath(turnId), "utf8").split(/\r?\n/).filter(Boolean);
      return lines.map((line) => JSON.parse(line) as RuntimeEvent).slice(-limit);
    } catch { return []; }
  }

  private eventPath(turnId: string): string {
    return path.join(this.journalDir, `${hashKey(turnId)}.jsonl`);
  }

  private appendEvent(record: TurnRecord, type: string, payload?: unknown): RuntimeEvent {
    const event: RuntimeEvent = {
      cursor: record.cursor + 1,
      turnId: record.turnId,
      type,
      ...(payload !== undefined ? { payload } : {}),
      at: new Date().toISOString()
    };
    record.cursor = event.cursor;
    record.events.push(event);
    if (record.events.length > MAX_EVENTS) record.events.shift();
    fs.appendFileSync(this.eventPath(record.turnId), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  }

  private save(): void {
    const temporary = `${this.ledgerPath}.${process.pid}.tmp`;
    const turns = [...this.turns.values()].map(({ events: _events, controller: _controller, timer: _timer, ...view }) => view);
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, turns }), { mode: 0o600 });
    fs.renameSync(temporary, this.ledgerPath);
  }

  private view(record: TurnRecord): TurnView {
    const { events: _events, controller: _controller, timer: _timer, ...view } = record;
    return view;
  }

  get(turnId: string): TurnView | null {
    const record = this.turns.get(turnId);
    return record ? this.view(record) : null;
  }

  list(): TurnView[] {
    return [...this.turns.values()].map((record) => this.view(record));
  }

  events(turnId: string, since = 0): { events: RuntimeEvent[]; cursor: number } {
    const record = this.turns.get(turnId);
    if (record) {
      const events = since < (record.events[0]?.cursor ?? 0) - 1
        ? this.readEvents(turnId, Number.MAX_SAFE_INTEGER)
        : record.events;
      return { events: events.filter((event) => event.cursor > since), cursor: record.cursor };
    }
    // 账本丢失后仍尽量从 journal 读取；终态 cursor 不会倒退。
    const events = this.readEvents(turnId).filter((event) => event.cursor > since);
    return { events, cursor: events.at(-1)?.cursor ?? since };
  }

  private findExecutor(executors: readonly Executor[], id: string | undefined, defaultId: string | undefined): Executor {
    const resolved = id ?? defaultId ?? executors[0]?.id;
    if (!resolved) throw new Error("没有可用的执行器");
    const executor = executors.find((candidate) => candidate.id === resolved);
    if (!executor) throw new Error(`未知执行器：${resolved}`);
    return executor;
  }

  /**
   * 提交一次执行；相同 turnId/requestId 幂等。
   *
   * 返回时回合已登记为 queued/running，执行在后台继续；调用方用 `turn.events` 跟随。
   */
  run(
    input: TurnRunInput,
    executors: readonly Executor[],
    defaultExecutor: string | undefined,
    deps: TurnRuntimeDeps
  ): TurnView {
    if (!input || typeof input.turnId !== "string" || input.turnId.trim() === "") throw new Error("缺少 turnId");
    if (typeof input.requestId !== "string" || input.requestId.trim() === "") throw new Error("缺少 requestId");
    if (input.kind !== "agent" && input.kind !== "generation") throw new Error("kind 必须是 agent 或 generation");
    const existing = this.turns.get(input.turnId);
    if (existing) {
      if (existing.requestId !== input.requestId) throw new Error("turnId 已用于不同 requestId");
      return this.view(existing);
    }
    const executor = this.findExecutor(executors, input.executor, defaultExecutor);
    if (executor.kind !== "any" && executor.kind !== input.kind) {
      throw new Error(`执行器 ${executor.id} 不支持 ${input.kind} 回合`);
    }
    const timestamp = new Date().toISOString();
    const record: TurnRecord = {
      turnId: input.turnId,
      requestId: input.requestId,
      kind: input.kind,
      executor: executor.id,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      cursor: 0,
      ...(input.prepared ? { preparedHash: input.prepared.preparedHash } : {}),
      events: []
    };
    this.turns.set(record.turnId, record);
    this.appendEvent(record, "accepted", {
      requestId: record.requestId,
      kind: record.kind,
      executor: record.executor,
      ...(record.preparedHash ? { preparedHash: record.preparedHash } : {})
    });
    this.save();
    this.execute(record, input, executor, deps);
    return this.view(record);
  }

  private execute(record: TurnRecord, input: TurnRunInput, executor: Executor, deps: TurnRuntimeDeps): void {
    const controller = new AbortController();
    record.controller = controller;
    record.status = "running";
    record.updatedAt = new Date().toISOString();
    this.save();
    if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
      record.timer = setTimeout(() => {
        if (record.status !== "running") return;
        withError(record, { code: "turn-timeout", message: `执行超过 ${input.timeoutMs}ms，已取消` });
        controller.abort();
      }, input.timeoutMs);
      record.timer.unref?.();
    }
    const operation = (async () => {
      let outcome: ExecutorOutcome;
      try {
        outcome = await executor.run(input, {
          signal: controller.signal,
          turnId: record.turnId,
          requestId: record.requestId,
          stateDir: deps.stateDir,
          workspaceKey: deps.workspaceKey,
          processes: deps.processes,
          host: deps.hostFor?.(input) ?? null,
          emit: (type, payload) => {
            if (record.status !== "running" && record.status !== "queued") return;
            this.appendEvent(record, type, payload);
            this.save();
          }
        });
      } catch (error) {
        outcome = controller.signal.aborted
          ? { status: "cancelled", error: { code: "cancelled", message: "执行已取消" } }
          : { status: "failed", error: { code: "executor-error", message: error instanceof Error ? error.message : String(error) } };
      } finally {
        if (record.timer) clearTimeout(record.timer);
        record.controller = undefined;
        record.timer = undefined;
      }
      // 取消/超时可能已先结算；迟到的执行结果不得改写终态。
      if (record.status === "cancelled" || record.status === "failed") {
        if (outcome.result !== undefined) record.result = outcome.result;
        this.save();
        return;
      }
      record.status = outcome.status;
      record.updatedAt = new Date().toISOString();
      const outcomeError = "error" in outcome ? outcome.error : undefined;
      if (outcomeError) record.error = outcomeError;
      if (outcome.result !== undefined) record.result = outcome.result;
      this.appendEvent(record, outcome.status === "succeeded" ? "completed" : outcome.status, {
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcomeError ? { error: outcomeError } : {})
      });
      this.save();
    })();
    this.pending.set(record.turnId, operation);
    void operation.finally(() => this.pending.delete(record.turnId)).catch(() => undefined);
  }

  async drain(turnId: string): Promise<void> { await this.pending.get(turnId); }

  cancel(turnId: string): TurnView | null {
    const record = this.turns.get(turnId);
    if (!record) return null;
    if (record.status === "queued" || record.status === "running") {
      withError(record, { code: "cancelled", message: "用户取消" });
      record.controller?.abort();
      this.appendEvent(record, "cancelling", { reason: "user" });
      this.save();
    }
    return this.view(record);
  }

  /** daemon 关闭时明确结算在途回合，避免留下“永远 running”。 */
  cancelAll(): void {
    for (const record of this.turns.values()) this.cancel(record.turnId);
  }
}

function withError(record: TurnRecord, error: TurnError): void {
  record.status = "cancelled";
  record.error = error;
  record.updatedAt = new Date().toISOString();
}
