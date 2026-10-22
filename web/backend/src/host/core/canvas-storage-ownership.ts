/**
 * 核心层 · canvas-storage-ownership：画布「字节归属远端存储」的持久记录。
 *
 * 为什么需要落盘：归属是**字节被写进哪个后端**的事实，不是「此刻连没连上」。只放在内存里
 * 时，宿主重启后到 room attach 之前（启动期的终态对账、画布页还没打开、room 被空闲回收）
 * 没有答案，宿主存储会回落主存储，把托管存储里确实存在的对象报成不存在——已经生成成功的
 * 远端任务因此被固化成失败终态。
 *
 * 落点与会话无关：它记录的是本机见过的画布归属，不属于某个账号或某个部署；换账号后同一张
 * 画布的字节仍在原后端，所以不按会话隔离，登出也不清空。
 *
 * 口径：
 * - 读盘是**同步**的：第一次存储路由之前就要有答案（文件只有几百个 id，不做异步预热）。
 * - 写入是异步原子写（临时文件 + rename）且串行化；失败只记日志——记忆丢失退化成旧行为，
 *   不能让画布操作失败。
 * - 条目按最近一次确认排序并有上限：被挤掉的最旧条目会在下次解析到远端配置时重新写回。
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SyncCanvasOwnershipStore } from "@woohaa3/canvas-service";

/** 文件位置覆盖（桌面形态把数据目录当作 cwd，缺省即可；测试与运维可用它换位置）。 */
export const CANVAS_OWNERSHIP_PATH_ENV = "WOOHAA3_CANVAS_OWNERSHIP_PATH";

/** 文件名：三种落点共用一个名字，排障时好找。 */
export const CANVAS_OWNERSHIP_FILE_NAME = "canvas-storage-ownership.json";

/** 相对进程 cwd 的缺省位置，与 storage.local / 日志的 .woohaa3/ 同区。 */
export const DEFAULT_CANVAS_OWNERSHIP_PATH = ".woohaa3/canvas-storage-ownership.json";

/** 条目上限：真实画布数量级远小于它；超限按「最近一次确认」淘汰最旧的。 */
const MAX_ENTRIES = 2_000;

/** 文件布局版本；读不懂的版本按空处理（不阻塞启动，下次解析会重新写回）。 */
const FILE_VERSION = 1;

/**
 * 落点优先级：显式环境变量 → 宿主其它持久状态所在目录 → cwd 下的 .woohaa3/。
 *
 * 跟着 `WOOHAA3_APPLICATION_STORE_PATH` / `WOOHAA3_TASK_STORE_PATH` 走的原因：桌面包与发布包
 * 把这些 store 放在自己的数据目录（`<data>/stores/`），测试放在临时目录。若固定写 cwd，测试会
 * 把夹具画布 id 写进开发机的真实归属记录里，开发机的归属文件也会长在仓库里。
 */
export function resolveCanvasOwnershipPath(env: Record<string, string | undefined>): string {
  const configured = env[CANVAS_OWNERSHIP_PATH_ENV]?.trim();
  if (configured && configured !== "") return path.resolve(process.cwd(), configured);
  const store = env.WOOHAA3_APPLICATION_STORE_PATH?.trim() || env.WOOHAA3_TASK_STORE_PATH?.trim();
  if (store && store !== "") {
    return path.join(path.dirname(path.resolve(process.cwd(), store)), CANVAS_OWNERSHIP_FILE_NAME);
  }
  return path.resolve(process.cwd(), DEFAULT_CANVAS_OWNERSHIP_PATH);
}

export type CanvasStorageOwnership = {
  /** 交给 `createCanvasService({ upstreamOwnership })` 的记录端口。 */
  store: SyncCanvasOwnershipStore;
  /** 等已排队的写盘落地（测试与关闭时用）。 */
  flush(): Promise<void>;
  close(): Promise<void>;
};

export function createCanvasStorageOwnership(options: {
  filePath: string;
  logger?: (event: Record<string, unknown>) => void;
  /** 条目上限覆盖；只在测试里收紧用，生产用 {@link MAX_ENTRIES}。 */
  maxEntries?: number;
}): CanvasStorageOwnership {
  const log = options.logger ?? (() => undefined);
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  /** 插入顺序即「最近一次确认」顺序：命中已有条目时移到末尾。 */
  const owned = new Map<string, true>(readInitial());
  /** 串行写队列：并发 remember 不会互相覆盖临时文件。 */
  let queued: Promise<void> = Promise.resolve();

  function readInitial(): Array<[string, true]> {
    let raw: string;
    try {
      raw = readFileSync(options.filePath, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") {
        log({ event: "canvas-ownership-read-failed", reason: error instanceof Error ? error.name : "unknown" });
      }
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; canvasIds?: unknown };
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.canvasIds)) {
        log({ event: "canvas-ownership-read-failed", reason: "unsupported-format" });
        return [];
      }
      const entries: Array<[string, true]> = [];
      const seen = new Set<string>();
      for (const value of parsed.canvasIds) {
        if (typeof value !== "string") continue;
        const canvasId = value.trim();
        if (canvasId === "" || seen.has(canvasId)) continue;
        seen.add(canvasId);
        entries.push([canvasId, true]);
      }
      return entries.slice(-maxEntries);
    } catch (error) {
      log({ event: "canvas-ownership-read-failed", reason: error instanceof Error ? error.name : "unknown" });
      return [];
    }
  }

  const schedule = (): void => {
    queued = queued.then(write).catch(() => undefined);
  };

  async function write(): Promise<void> {
    // 写之前再收一次：并发 remember 期间集合可能已经超过上限。
    while (owned.size > maxEntries) {
      const oldest = owned.keys().next();
      if (oldest.done) break;
      owned.delete(oldest.value);
    }
    const payload = JSON.stringify({ version: FILE_VERSION, canvasIds: [...owned.keys()] }, null, 2);
    const tmp = `${options.filePath}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(options.filePath), { recursive: true });
      await writeFile(tmp, payload, "utf8");
      // rename 是原子的：崩溃时要么是旧文件，要么是新文件，不会读到半个 JSON。
      await rename(tmp, options.filePath);
    } catch (error) {
      log({ event: "canvas-ownership-write-failed", reason: error instanceof Error ? error.name : "unknown" });
    }
  }

  const store: SyncCanvasOwnershipStore = {
    initial: () => [...owned.keys()],
    remember(canvasId) {
      const trimmed = canvasId.trim();
      if (trimmed === "") return;
      const exists = owned.delete(trimmed);
      owned.set(trimmed, true);
      // 已在末尾的重复确认不写盘：链路每次重连都会 remember 一次，没必要每次都落一份。
      if (exists) return;
      schedule();
    },
    forget(canvasId) {
      if (!owned.delete(canvasId.trim())) return;
      schedule();
    }
  };

  const flush = (): Promise<void> => queued;
  return { store, flush, close: flush };
}
