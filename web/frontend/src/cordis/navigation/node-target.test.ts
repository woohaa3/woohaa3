/**
 * 打开画布时的一次性节点目标（change: task-monitor-canvas-roundtrip）。
 *
 * 覆盖：节点已存在只定位一次；节点/渲染宿主迟到时等待重试；次数上限后停止；
 * 清理后不再定位；从 Canvas scope 取服务并消费 `nodeId` 目标。
 */
import { describe, expect, it } from "vitest";
import { attachOpenedNodeTarget, locateOpenedNode, type CanvasNodeTargetCanvas } from "./node-target.js";

function canvasOf(ids: readonly string[]): CanvasNodeTargetCanvas {
  return { document: { nodes: ids.map((id) => ({ id })) } };
}

describe("locateOpenedNode", () => {
  it("节点已存在且定位成功：只定位一次，不再安排重试", () => {
    const located: string[] = [];
    const scheduled: Array<() => void> = [];
    const cleanup = locateOpenedNode("n1", {
      getCanvas: () => canvasOf(["n1"]),
      locate: (id) => {
        located.push(id);
        return { ok: true };
      },
      schedule: (task) => {
        scheduled.push(task);
        return () => undefined;
      }
    });
    expect(located).toEqual(["n1"]);
    expect(scheduled).toHaveLength(0);
    cleanup();
  });

  it("画布数据迟到：store 变化后定位一次并解除订阅", () => {
    let listener: (() => void) | null = null;
    let current = canvasOf([]);
    const located: string[][] = [];
    const scheduled: Array<() => void> = [];
    locateOpenedNode("n1", {
      getCanvas: () => current,
      subscribe: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      locate: (id) => {
        located.push([id]);
        return { ok: true };
      },
      schedule: (task) => {
        scheduled.push(task);
        return () => undefined;
      }
    });
    // 首次尝试节点不存在：等待重试，不做无意义的定位。
    expect(located).toHaveLength(0);
    expect(scheduled).toHaveLength(1);

    current = canvasOf(["n1"]);
    (listener as (() => void) | null)?.();
    expect(located).toEqual([["n1"]]);
    // 成功后释放订阅，后续 store 变化不再重复定位。
    expect(listener).toBeNull();
  });

  it("渲染宿主暂未就绪（定位失败）时按时重试，成功后停止", () => {
    let ready = false;
    const scheduled: Array<() => void> = [];
    const cleanup = locateOpenedNode("n1", {
      getCanvas: () => canvasOf(["n1"]),
      locate: () => (ready ? { ok: true } : { ok: false, reason: "画布尚未就绪" }),
      schedule: (task) => {
        scheduled.push(task);
        return () => undefined;
      }
    });
    expect(scheduled).toHaveLength(1);
    ready = true;
    scheduled.shift()?.();
    // 成功一次即结束：不再排下一次重试。
    expect(scheduled).toHaveLength(0);
    cleanup();
  });

  it("节点始终不在画布上：达到次数上限后静默停止", () => {
    let locateCalls = 0;
    const scheduled: Array<() => void> = [];
    locateOpenedNode("missing", {
      getCanvas: () => canvasOf([]),
      locate: () => {
        locateCalls += 1;
        return { ok: true };
      },
      maxAttempts: 3,
      schedule: (task) => {
        scheduled.push(task);
        return () => undefined;
      }
    });
    expect(locateCalls).toBe(0);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    // 第三次尝试后到达上限，不再安排重试。
    expect(scheduled).toHaveLength(0);
    expect(locateCalls).toBe(0);
  });

  it("清理后不再定位（迟到的定时任务也不会生效）", () => {
    const scheduled: Array<() => void> = [];
    const located: string[] = [];
    const cleanup = locateOpenedNode("n1", {
      getCanvas: () => canvasOf([]),
      locate: (id) => {
        located.push(id);
        return { ok: true };
      },
      schedule: (task) => {
        scheduled.push(task);
        return () => undefined;
      }
    });
    cleanup();
    scheduled.forEach((task) => task());
    expect(located).toHaveLength(0);
  });
});

describe("attachOpenedNodeTarget", () => {
  it("从 Canvas scope 取 canvasState/canvasLocate，节点到达后定位并释放订阅", () => {
    const listeners = new Set<() => void>();
    let current = canvasOf([]);
    const located: string[][] = [];
    const ctx = {
      get(key: string) {
        if (key === "canvasState") {
          return {
            getCanvas: () => current,
            subscribe: (listener: () => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            }
          };
        }
        if (key === "canvasLocate") {
          return {
            locateNodes: (ids: readonly string[]) => {
              located.push([...ids]);
              return { ok: true };
            }
          };
        }
        return undefined;
      }
    };
    const cleanup = attachOpenedNodeTarget(ctx as never, "n1", { retryDelayMs: 60_000 });
    current = canvasOf(["n1"]);
    for (const listener of [...listeners]) listener();
    expect(located).toEqual([["n1"]]);
    expect(listeners.size).toBe(0);
    cleanup();
  });

  it("恢复页/准备态没有 canvasState 时退化为 no-op", () => {
    const cleanup = attachOpenedNodeTarget({ get: () => undefined } as never, "n1");
    expect(typeof cleanup).toBe("function");
    cleanup();
  });
});
