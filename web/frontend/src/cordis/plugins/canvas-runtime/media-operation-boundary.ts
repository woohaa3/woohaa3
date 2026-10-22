import type { BevyRuntime } from "./bevy-runtime.js";
import { errorDetail } from "./runtime-issues.js";

/** Covers decoding/rasterization and async callbacks, including injected runtimes. */
export class MediaOperationBoundary {
  private readonly failed = new Map<string, { source: unknown; retry: number; nodeId: string }>();
  constructor(private readonly runtime: BevyRuntime) {}
  run<T>(key: string, source: unknown, nodeId: string, invoke: () => T): T | null {
    const retry = this.runtime.retryVersion?.() ?? 0;
    const failure = this.failed.get(key);
    if (failure && failure.source === source && failure.retry === retry) return null;
    try {
      const value = invoke();
      if (value === false) { this.failed.set(key, { source, retry, nodeId }); return value; }
      this.failed.delete(key);
      this.runtime.clearRuntimeIssue?.(`media:${key}`);
      return value;
    } catch (error) {
      this.failed.set(key, { source, retry, nodeId });
      this.runtime.reportRuntimeIssue?.({ key: `media:${key}`, scope: "texture", operation: key,
        nodeId, message: "媒体预览处理失败，可以重试或更换素材。", detail: errorDetail(error),
        recoverable: true });
      return null;
    }
  }
  retainNodes(nodeIds: ReadonlySet<string>): void {
    for (const [key, failure] of this.failed) if (!nodeIds.has(failure.nodeId)) this.clear(key);
  }
  clear(key: string): void {
    this.failed.delete(key);
    this.runtime.clearRuntimeIssue?.(`media:${key}`);
  }
}
