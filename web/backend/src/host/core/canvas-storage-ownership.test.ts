/**
 * 核心层 · 画布远端归属的持久记录测试。
 *
 * 锁住四件事：重启后仍知道归属（读回）、删除画布才收回、坏文件不让宿主启动失败、
 * 写盘失败只记日志（记忆丢失退化成旧行为，不能把画布操作带崩）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("画布级地址覆盖落盘并在重启后读回；forget 一并清掉", async () => {
    const { dir, filePath } = tempOwnershipFile();
    try {
      const first = createCanvasStorageOwnership({ filePath });
      first.store.remember("c1");
      first.store.remember("c2");
      first.store.rememberExposure?.("c1", "edge");
      // 空串是「这张画布明确不对外」，必须与「没有覆盖」区分开落盘。
      first.store.rememberExposure?.("c2", "");
      await first.flush();
      expect(first.store.exposures?.()).toEqual({ c1: "edge", c2: "" });

      const reopened = createCanvasStorageOwnership({ filePath });
      expect(reopened.store.exposures?.()).toEqual({ c1: "edge", c2: "" });

      reopened.store.forget("c1");
      await reopened.flush();
      expect(reopened.store.exposures?.()).toEqual({ c2: "" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("旧版文件（只有 canvasIds）按「无覆盖」读入，并在下次写入时升级为当前版本", async () => {
    const { dir, filePath } = tempOwnershipFile();
    try {
      writeFileSync(filePath, JSON.stringify({ version: 1, canvasIds: ["c1"] }));
      const ownership = createCanvasStorageOwnership({ filePath });
      expect(ownership.store.initial()).toEqual(["c1"]);
      expect(ownership.store.exposures?.()).toEqual({});

      ownership.store.rememberExposure?.("c1", "edge");
      await ownership.flush();
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { version: number; exposures: unknown };
      expect(parsed.version).toBe(2);
      expect(parsed.exposures).toEqual({ c1: "edge" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未归属的画布不接受地址覆盖：覆盖只在归属成立后才有意义", () => {
    const { dir, filePath } = tempOwnershipFile();
    try {
      const ownership = createCanvasStorageOwnership({ filePath });
      ownership.store.rememberExposure?.("ghost", "edge");
      expect(ownership.store.exposures?.()).toEqual({});
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
    // 期望值用 path.resolve 拼：Windows 上分隔符是反斜杠。
    // 期望值按实现的同一套 path 语义拼：Windows 上分隔符是反斜杠。
    // 实现里是 `path.resolve(cwd, configured)`，期望值必须用同一套语义（Windows 上会带盘符）。
    expect(resolveCanvasOwnershipPath({ WOOHAA3_CANVAS_OWNERSHIP_PATH: "/tmp/x/ownership.json" })).toBe(path.resolve("/tmp/x/ownership.json"));
    expect(resolveCanvasOwnershipPath({ WOOHAA3_CANVAS_OWNERSHIP_PATH: "  " })).toBe(fallback);
    // 桌面包 / 发布包 / 测试都通过 APPLICATION_STORE_PATH 或 TASK_STORE_PATH 指定数据目录：
    // 归属记录跟着它走，不写进仓库 cwd。
    expect(
      resolveCanvasOwnershipPath({ WOOHAA3_APPLICATION_STORE_PATH: "/tmp/data/application.sqlite" })
    ).toBe(path.join(path.dirname(path.resolve("/tmp/data/application.sqlite")), "canvas-storage-ownership.json"));
    expect(
      resolveCanvasOwnershipPath({
        WOOHAA3_APPLICATION_STORE_PATH: "/tmp/app/application.sqlite",
        WOOHAA3_TASK_STORE_PATH: "/tmp/task/task.sqlite"
      })
    ).toBe(path.join(path.dirname(path.resolve("/tmp/app/application.sqlite")), "canvas-storage-ownership.json"));
    expect(
      resolveCanvasOwnershipPath({ WOOHAA3_TASK_STORE_PATH: "/tmp/task/task.sqlite" })
    ).toBe(path.join(path.dirname(path.resolve("/tmp/task/task.sqlite")), "canvas-storage-ownership.json"));
  });
});
