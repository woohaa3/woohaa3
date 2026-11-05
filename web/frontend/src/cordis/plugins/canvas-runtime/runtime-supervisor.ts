import { errorDetail, type RuntimeIssues } from "./runtime-issues.js";

export type RuntimeHealth = { updates: number; renders: number; appliedRevision: number; appliedGeneration?: number; renderedGeneration?: number; suspended?: boolean; drawCalls3d?: number | null };
export type RecoveryPhase = "running" | "recovering" | "degraded" | "disposed";
export function readRuntimeHealth(json: string): RuntimeHealth {
  const health = JSON.parse(json) as RuntimeHealth & { version?: string };
  if (health.version !== "woohaa-runtime-health-v1" || ![health.updates, health.renders, health.appliedRevision, health.appliedGeneration, health.renderedGeneration].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) throw new Error("Bevy 健康协议不匹配");
  return health;
}

type EventRecord = { at: number; event: string; duration?: number };

/** Bounded, payload-free diagnostics and recovery policy, separate from editing state. */
export class RuntimeSupervisor {
  phase: RecoveryPhase = "running";
  private readonly history: EventRecord[] = [];
  private readonly attempts: number[] = [];
  private readonly observed = new Map<string, string>();
  private visible = true;
  private readonly counts: Record<string, number> = {};
  private pendingGeneration: number | null = null;
  private pending: number | null = null;
  private health: RuntimeHealth = { updates: 0, renders: 0, appliedRevision: 0 };
  private progressAt = 0;
  private acceptedRenders = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private readonly unsubscribe: () => void;
  constructor(private readonly options: {
    issues: RuntimeIssues; recover(): Promise<void>; invalidate(): void;
    now?: () => number; timeout?: number;
  }) {
    this.unsubscribe = options.issues.subscribe(() => {
      const issues = options.issues.getSnapshot();
      const keys = new Set(issues.map(issue => issue.key));
      for (const key of this.observed.keys()) if (!keys.has(key)) this.observed.delete(key);
      for (const issue of issues) {
        const signature = JSON.stringify(issue);
        if (this.observed.get(issue.key) !== signature) { this.observed.set(issue.key, signature); this.record(`issue-${issue.scope}`); }
      }
      const fatal = issues.find(issue => !issue.recoverable);
      if (fatal) this.fail(fatal.operation);
    });
  }
  private now() { return this.options.now?.() ?? performance.now(); }
  record(event: string, duration?: number) {
    event = event.slice(0, 80);
    if (!(event in this.counts) && Object.keys(this.counts).length >= 32) event = "other";
    this.counts[event] = (this.counts[event] ?? 0) + 1;
    this.history.push({ at: this.now(), event: event.slice(0, 80), ...(duration === undefined ? {} : { duration }) });
    if (this.history.length > 64) this.history.shift();
  }
  snapshot() { return { isolatedResources: new Set(this.options.issues.getSnapshot().filter(issue => issue.scope === "texture").map(issue => issue.nodeId ?? issue.key)).size, phase: this.phase, health: { ...this.health }, pendingRevision: this.pending, pendingGeneration: this.pendingGeneration,
    counts: { ...this.counts }, history: this.history.map(event => ({ ...event })) }; }
  accepted(revision: number, generation?: number) {
    if (this.pending === null) { this.progressAt = this.now(); this.acceptedRenders = this.health.renders; }
    this.pending = revision; this.pendingGeneration = generation ?? null;
  }
  sample(health: RuntimeHealth, visible: boolean) {
    if (this.phase !== "running") return;
    if (visible !== this.visible) { this.progressAt = this.now(); this.visible = visible; }
    // Pending canvas generations cannot advance while another native surface owns
    // presentation. Preserve them, and grant a fresh timeout when work resumes.
    if (health.suspended || this.health.suspended) this.progressAt = this.now();
    if (!visible || health.suspended) { this.progressAt = this.now(); this.health = health; return; }
    if (health.updates !== this.health.updates && health.renders !== this.health.renders && (this.pendingGeneration === null || health.renderedGeneration !== this.health.renderedGeneration)) this.progressAt = this.now();
    this.health = health;
    if (this.pending !== null && health.appliedRevision >= this.pending && health.renders !== this.acceptedRenders && (this.pendingGeneration === null || ((health.appliedGeneration ?? 0) >= this.pendingGeneration && (health.renderedGeneration ?? 0) >= this.pendingGeneration))) { this.pending = null; this.pendingGeneration = null; }
    if (this.pending !== null && this.now() - this.progressAt > (this.options.timeout ?? 30000)) this.fail("watchdog");
  }
  fail(reason: string, manual = false) {
    if (this.phase === "disposed" || this.phase === "recovering") return;
    if (this.phase === "degraded" && !manual) return;
    const now = this.now();
    while (this.attempts.length && now - this.attempts[0]! > 60000) this.attempts.shift();
    const relocated = reason === "surface-detached";
    this.record(reason === "watchdog" ? "watchdog" : "fault");
    if (!manual && !relocated && this.attempts.length >= 2) {
      this.phase = "degraded";
      this.options.issues.report({ key: "runtime:recovery", scope: "runtime", operation: "recovery",
        recoverable: false, message: "渲染器连续恢复失败，已停止自动重试。编辑现场仍保留，可手动重建预览。", detail: reason });
      return;
    }
    if (!relocated) { this.attempts.push(now); if (this.attempts.length > 2) this.attempts.shift(); }
    this.phase = "recovering";
    this.options.issues.report({ key: "runtime:recovery", scope: "runtime", operation: "recovery",
      recoverable: false, message: "正在重建画布预览，编辑现场已保留。", detail: reason });
    const epoch = ++this.epoch;
    this.timer = setTimeout(() => { this.timer = null; void this.recover(epoch, now); }, manual ? 0 : 250 * Math.max(1, this.attempts.length));
  }
  private async recover(epoch: number, started: number) {
    try {
      await this.options.recover();
      if (this.epoch !== epoch || this.phase === "disposed") return;
      this.phase = "running"; this.pending = null; this.pendingGeneration = null; this.progressAt = this.now();
      this.options.issues.clearRuntimeFatal();
      this.record("recovered", this.now() - started);
      try { this.options.invalidate(); } catch { this.record("observer-failed"); }
    } catch (error) {
      if (this.epoch !== epoch || this.phase === "disposed") return;
      this.record("recovery-failed", this.now() - started);
      this.phase = "running";
      this.fail(`重建失败：${errorDetail(error)}`);
    }
  }
  retry() { this.fail("manual", true); }
  dispose() { this.phase = "disposed"; this.epoch++; if (this.timer !== null) clearTimeout(this.timer); this.unsubscribe(); }
}
