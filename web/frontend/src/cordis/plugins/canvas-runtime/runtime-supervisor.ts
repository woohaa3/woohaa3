import { errorDetail, type RuntimeIssues } from "./runtime-issues.js";

export type RuntimeHealth = { updates: number; renders: number; appliedRevision: number; appliedGeneration?: number; renderedGeneration?: number; suspended?: boolean; drawCalls3d?: number | null };
export type RecoveryPhase = "running" | "recovering" | "degraded" | "disposed";
export function readRuntimeHealth(json: string): RuntimeHealth {
  const health = JSON.parse(json) as RuntimeHealth & { version?: string };
  if (health.version !== "woohaa-runtime-health-v1" || ![health.updates, health.renders, health.appliedRevision, health.appliedGeneration, health.renderedGeneration].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) throw new Error("Bevy 健康协议不匹配");
  return health;
}

/**
 * 内部故障码 → 可直接展示的触发原因。
 *
 * 展示层只给「暂停/重建」这类状态，用户无从判断发生了什么；把原因翻成一句话后，
 * 不用展开技术详情也能知道是卡死、上下文丢失还是表面脱离。未知码多为底层错误原文，
 * 原样保留，避免把真实信息吞掉。
 */
export function runtimeReasonText(reason: string): string {
  if (reason === "watchdog") return "30 秒内没有收到画面更新，渲染器疑似卡死";
  if (reason === "surface-detached") return "画布渲染表面已从页面脱离";
  if (reason === "renderer-reloaded") return "渲染器被重复加载";
  if (reason === "health") return "渲染器健康状态读取失败";
  if (reason === "native-viewport") return "桌面画布视口通信失败";
  if (reason === "Runtime disposed") return "画布页面已关闭，重建被取消";
  return reason;
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
    const rebuilt = reason.startsWith("重建失败：");
    const cause = runtimeReasonText(rebuilt ? reason.slice("重建失败：".length) : reason);
    this.record(reason === "watchdog" ? "watchdog" : "fault");
    if (!manual && !relocated && this.attempts.length >= 2) {
      this.phase = "degraded";
      this.options.issues.report({ key: "runtime:recovery", scope: "runtime", operation: "recovery",
        recoverable: false,
        message: `画布预览已停止自动恢复：连续两次重建失败（最后一次原因：${cause}）。编辑内容与待确认操作仍保留，点击「重建画布预览」可手动重试。`,
        detail: reason });
      return;
    }
    if (!relocated) { this.attempts.push(now); if (this.attempts.length > 2) this.attempts.shift(); }
    this.phase = "recovering";
    const attempt = Math.max(1, this.attempts.length);
    const progress = manual ? "正在按你的请求重建画布预览" : relocated ? "正在自动重建画布预览" : `正在自动重建画布预览（第 ${attempt}/2 次）`;
    this.options.issues.report({ key: "runtime:recovery", scope: "runtime", operation: "recovery",
      recoverable: false,
      message: rebuilt
        ? `画布预览重建失败（原因：${cause}），${manual ? "正在按你的请求重试" : `继续自动重试（第 ${attempt}/2 次）`}；编辑内容与待确认操作已保留。`
        : `画布预览已暂停（原因：${cause}），${progress}；编辑内容与待确认操作已保留。`,
      detail: reason });
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
