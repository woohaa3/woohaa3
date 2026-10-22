/**
 * 核心层 · 画布远端归属的持久记录测试。
 *
 * 锁住四件事：重启后仍知道归属（读回）、删除画布才收回、坏文件不让宿主启动失败、
 * 写盘失败只记日志（记忆丢失退化成旧行为，不能把画布操作带崩）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvasStorageOwnership, resolveCanvasOwnershipPath } from "./canvas-storage-ownership.js";

function tempOwnershipFile(): { dir: string; filePath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-ownership-"));
  return { dir, filePath: path.join(dir, "ownership.json") };
}

describe("画布远端归属的持久记录", () => {
  it("文件不存在时为空，且不会顺手建文件", () => {
    const { dir, filePath } = tempOwnershipFile();
    try {
      const ownership = createCanvasStorageOwnership({ filePath });
      expect(ownership.store.initial()).toEqual([]);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remember 后新实例读回：宿主重启不会把远端画布忘成本地", async () => {
    const { dir, filePath } = tempOwnershipFile();
    try {
      const first = createCanvasStorageOwnership({ filePath });
      first.store.remember("canvas-1");
      first.store.remember("canvas-2");
      await first.close();

      const second = createCanvasStorageOwnership({ filePath });
      expect(second.store.initial()).toEqual(["canvas-1", "canvas-2"]);
      // 原子写：临时文件不留在目录里。
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forget 落盘：画布被删除后不再被当成远端", async () => {
    const { dir, filePath } = tempOwnershipFile();
    try {
      const first = createCanvasStorageOwnership({ filePath });
      first.store.remember("canvas-1");
      first.store.remember("canvas-2");
      first.store.forget("canvas-1");
      await first.close();

      const second = createCanvasStorageOwnership({ filePath });
      expect(second.store.initial()).toEqual(["canvas-2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重复确认把条目移到末尾：上限淘汰时先丢最久没确认的", async () => {
    const { dir, filePath } = tempOwnershipFile();
    try {
      const ownership = createCanvasStorageOwnership({ filePath });
      ownership.store.remember("canvas-1");
      ownership.store.remember("canvas-2");
      ownership.store.remember("canvas-1");
      await ownership.close();

      const reopened = createCanvasStorageOwnership({ filePath });
      expect(reopened.store.initial()).toEqual(["canvas-2", "canvas-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("超过上限淘汰最旧的，文件不会无限增长", async () => {
    const { dir, filePath } = tempOwnershipFile();
    try {
      const ownership = createCanvasStorageOwnership({ filePath, maxEntries: 2 });
      ownership.store.remember("canvas-1");
      ownership.store.remember("canvas-2");
      ownership.store.remember("canvas-3");
      await ownership.close();

      const reopened = createCanvasStorageOwnership({ filePath, maxEntries: 2 });
      expect(reopened.store.initial()).toEqual(["canvas-2", "canvas-3"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("坏文件按空处理并记日志，不让宿主启动失败", () => {
    const { dir, filePath } = tempOwnershipFile();
    try {
      writeFileSync(filePath, '{"version":1,"canvasIds":[', "utf8");
      const logs: Array<Record<string, unknown>> = [];
      const ownership = createCanvasStorageOwnership({ filePath, logger: (event) => logs.push(event) });
      expect(ownership.store.initial()).toEqual([]);
      expect(logs.map((event) => event.event)).toEqual(["canvas-ownership-read-failed"]);

      // 版本不符同样按空处理（以后换布局时不至于读到半懂的数据）。
      writeFileSync(filePath, JSON.stringify({ version: 99, canvasIds: ["canvas-1"] }), "utf8");
      const mismatched = createCanvasStorageOwnership({ filePath });
      expect(mismatched.store.initial()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("写盘失败只记日志：调用方不会因为记忆丢失而失败", async () => {
    const { dir } = tempOwnershipFile();
    try {
      // 把「文件路径」放在一个普通文件下面：mkdir/写入必然失败。
      const blocker = path.join(dir, "blocker");
      writeFileSync(blocker, "x", "utf8");
      const filePath = path.join(blocker, "nested", "ownership.json");
      const logs: Array<Record<string, unknown>> = [];
      const ownership = createCanvasStorageOwnership({ filePath, logger: (event) => logs.push(event) });
      expect(() => ownership.store.remember("canvas-1")).not.toThrow();
      await expect(ownership.close()).resolves.toBeUndefined();
      expect(logs.map((event) => event.event)).toContain("canvas-ownership-write-failed");
      // 内存里仍然记住了：本次进程内的路由是对的，只是重启后会丢。
      expect(ownership.store.initial()).toEqual(["canvas-1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("归属文件位置", () => {
  it("显式变量优先，其次跟着宿主其它 store，最后落 cwd 下的 .woohaa3/", () => {
    const fallback = resolveCanvasOwnershipPath({});
    expect(fallback.endsWith(path.join(".woohaa3", "canvas-storage-ownership.json"))).toBe(true);
    expect(resolveCanvasOwnershipPath({ WOOHAA3_CANVAS_OWNERSHIP_PATH: "/tmp/x/ownership.json" })).toBe("/tmp/x/ownership.json");
    expect(resolveCanvasOwnershipPath({ WOOHAA3_CANVAS_OWNERSHIP_PATH: "  " })).toBe(fallback);
    // 桌面包 / 发布包 / 测试都通过 APPLICATION_STORE_PATH 或 TASK_STORE_PATH 指定数据目录：
    // 归属记录跟着它走，不写进仓库 cwd。
    expect(
      resolveCanvasOwnershipPath({ WOOHAA3_APPLICATION_STORE_PATH: "/tmp/data/application.sqlite" })
    ).toBe(path.join("/tmp/data", "canvas-storage-ownership.json"));
    expect(
      resolveCanvasOwnershipPath({
        WOOHAA3_APPLICATION_STORE_PATH: "/tmp/app/application.sqlite",
        WOOHAA3_TASK_STORE_PATH: "/tmp/task/task.sqlite"
      })
    ).toBe(path.join("/tmp/app", "canvas-storage-ownership.json"));
    expect(
      resolveCanvasOwnershipPath({ WOOHAA3_TASK_STORE_PATH: "/tmp/task/task.sqlite" })
    ).toBe(path.join("/tmp/task", "canvas-storage-ownership.json"));
  });
});
