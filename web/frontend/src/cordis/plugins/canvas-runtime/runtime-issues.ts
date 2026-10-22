/** Runtime-owned, bounded diagnostics. Reporting must never interrupt rendering. */
export type RuntimeIssue = {
  key: string;
  scope: "frame" | "texture" | "runtime";
  operation: string;
  nodeId?: string;
  message: string;
  detail: string;
  recoverable: boolean;
  retainedPreview?: boolean;
};

export function errorDetail(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); }
  catch { return "无法读取错误详情"; }
}

export class RuntimeIssues {
  private readonly entries = new Map<string, RuntimeIssue>();
  private snapshot: readonly RuntimeIssue[] = [];
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): readonly RuntimeIssue[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  report = (issue: RuntimeIssue): void => {
    issue = { ...issue, detail: issue.detail.slice(0, 4000) };
    if (JSON.stringify(this.entries.get(issue.key)) === JSON.stringify(issue)) return;
    if (!this.entries.has(issue.key) && this.entries.size >= 64) {
      const victim = [...this.entries.values()].find(entry => entry.recoverable);
      if (victim) this.entries.delete(victim.key);
      else return;
    }
    this.entries.set(issue.key, { ...issue, detail: issue.detail.slice(0, 4000) });
    this.publish();
  };
  clear = (key: string): void => {
    if (this.entries.get(key)?.recoverable && this.entries.delete(key)) this.publish();
  };
  clearRecoverable = (): void => {
    let changed = false;
    for (const [key, issue] of this.entries) if (issue.recoverable) changed = this.entries.delete(key) || changed;
    if (changed) this.publish();
  };
  /** Only a verified replacement runtime can acknowledge fatal runtime issues. */
  clearRuntimeFatal = (): void => {
    let changed = false;
    for (const [key, issue] of this.entries) if (issue.scope === "runtime") changed = this.entries.delete(key) || changed;
    if (changed) this.publish();
  };
  private publish(): void {
    this.snapshot = [...this.entries.values()];
    for (const listener of this.listeners) {
      try { listener(); } catch { /* Diagnostic observers cannot break the runtime. */ }
    }
  }
}
