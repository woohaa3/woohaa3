/**
 * 宿主启动期的私有目录清扫
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 5.4 / design D8）。
 *
 * 与 Rust supervisor 的 `sweep_work_root` 同语义：只删除**过期**的任务私有目录，
 * 保留仍可能被活着的 worker 使用的目录，也不跨 worktree 清扫。
 *
 * 判定只看 mtime 与阈值：不读目录内容、不跟随符号链接、不递归到任务目录内部之外。
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type RecordingSweepOptions = {
  /** 工作根目录（每个 attempt 一个子目录）。 */
  workRoot: string;
  /** 超过这个年龄（毫秒）才删除。 */
  olderThanMs: number;
  /** 注入时钟（默认 `Date.now()`）。 */
  now?: () => number;
  logger?: (event: Record<string, unknown>) => void;
};

/** 最多删除多少个目录（防止一次清扫拖住启动）。 */
const MAX_SWEEP_ENTRIES = 256;

/**
 * 清扫过期目录，返回删除数量。
 *
 * 根目录不存在时返回 0（首次启动）；单个目录删除失败只记日志，不影响启动。
 */
export function sweepRecordingWorkRoot(options: RecordingSweepOptions): number {
  const log = options.logger ?? (() => undefined);
  const now = (options.now ?? Date.now)();
  let entries;
  try {
    entries = readdirSync(options.workRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries.slice(0, MAX_SWEEP_ENTRIES)) {
    if (!entry.isDirectory()) continue;
    const path = join(options.workRoot, entry.name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    if (now - stats.mtimeMs <= options.olderThanMs) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      log({
        event: "recording-sweep-failed",
        name: entry.name,
        message: error instanceof Error ? error.message : "unknown"
      });
    }
  }
  return removed;
}
