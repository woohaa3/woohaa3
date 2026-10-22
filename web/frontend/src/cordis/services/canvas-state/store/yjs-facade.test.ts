/**
 * Store Y.Doc facade 与命令生命周期测试（任务 6.4 / 6.5 / 6.7）。
 *
 * 覆盖：result 先到 / update 先到两种顺序都只在 derived 覆盖后 committed、
 * 拒绝路径、本地瞬时状态不产生命令、静态搜索确认无 synced Y.Doc 直接写入。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CommandLifecycleRegistry,
  TRANSIENT_ONLY_FIELDS,
  createTransientCanvasState,
  type CommandLifecycleEvent } from "./yjs-facade.js";

// 测试位于 src/store/，上跳一级得到 src/，再上跳得到包根。
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

function registryWith(derivedRevision: { value: number }) {
  const events: CommandLifecycleEvent[] = [];
  const registry = new CommandLifecycleRegistry({
    derivedRevision: () => derivedRevision.value,
    onChange: (event) => events.push(event),
    generateCommandId: () => `cmd-${events.length + 1}`
  });
  return { registry, events, derivedRevision };
}

describe("命令生命周期（任务 6.5 / 6.6）", () => {
  it("result 先到：accepted 后等 derived 覆盖才 committed", async () => {
    const derived = { value: 5 };
    const { registry, events } = registryWith(derived);
    const handle = registry.begin(5);

    registry.applyResult({ commandId: handle.commandId, status: "accepted", revision: 6 });
    // derived 仍是 5 < 6 → 尚未 committed。
    expect(handle.state).toBe("accepted");
    expect(handle.resultRevision).toBe(6);

    derived.value = 6;
    registry.onDerivedRevisionChanged();
    expect(handle.state).toBe("committed");
    await expect(handle.settled).resolves.toMatchObject({ state: "committed" });
    expect(events.map((event) => event.state)).toEqual(["pending", "accepted", "committed"]);
  });

  it("update 先到：derived 已前进时 accepted 立刻 committed", () => {
    const derived = { value: 6 };
    const { registry } = registryWith(derived);
    const handle = registry.begin(5);
    registry.applyResult({ commandId: handle.commandId, status: "accepted", revision: 6 });
    expect(handle.state).toBe("committed");
  });

  it("rejected 直接结算并保留原因", async () => {
    const derived = { value: 5 };
    const { registry } = registryWith(derived);
    const handle = registry.begin(5);
    registry.applyResult({ commandId: handle.commandId, status: "rejected", error: "invalid-edge-endpoint" });
    expect(handle.state).toBe("rejected");
    expect(handle.error).toBe("invalid-edge-endpoint");
    await expect(handle.settled).resolves.toMatchObject({ state: "rejected" });
  });

  it("failed（暂时存储失败）也结算为 rejected，可重试", () => {
    const derived = { value: 5 };
    const { registry } = registryWith(derived);
    const handle = registry.begin(5);
    registry.applyResult({ commandId: handle.commandId, status: "failed", error: "storage-failed" });
    expect(handle.state).toBe("rejected");
  });

  it("duplicate 按 accepted 处理（幂等重试）", () => {
    const derived = { value: 7 };
    const { registry } = registryWith(derived);
    const handle = registry.begin(5);
    registry.applyResult({ commandId: handle.commandId, status: "duplicate", revision: 6 });
    expect(handle.state).toBe("committed");
  });

  it("未知 commandId 的 result 被忽略（不抛错）", () => {
    const derived = { value: 1 };
    const { registry } = registryWith(derived);
    expect(() => registry.applyResult({ commandId: "unknown", status: "accepted" })).not.toThrow();
  });

  it("begin 复用调用方 commandId（与 wire 一致）", () => {
    const derived = { value: 0 };
    const { registry, events } = registryWith(derived);
    const handle = registry.begin(0, "caller-id");
    expect(handle.commandId).toBe("caller-id");
    expect(registry.get("caller-id")).toBe(handle);
    expect(events[0].commandId).toBe("caller-id");
  });

  it("observed（update-first）在 result 到达且 derived 覆盖后 committed", () => {
    const derived = { value: 0 };
    const { registry, events } = registryWith(derived);
    const handle = registry.begin(0, "cmd-observed");
    // working projection 观察到效果（Yjs update 先到）→ observed。
    derived.value = 1;
    registry.observe("cmd-observed");
    expect(handle.state).toBe("observed");
    // result 到达：保留 observed，derived 已覆盖 → committed。
    registry.applyResult({ commandId: "cmd-observed", status: "accepted", revision: 1 });
    expect(handle.state).toBe("committed");
    expect(events.map((event) => event.state)).toContain("observed");
  });

  it("pendingCount 只统计未结算命令，prune 清理已结算记录", () => {
    const derived = { value: 10 };
    const { registry } = registryWith(derived);
    const a = registry.begin(10);
    const b = registry.begin(10);
    registry.applyResult({ commandId: a.commandId, status: "accepted", revision: 11 });
    registry.applyResult({ commandId: b.commandId, status: "rejected", error: "x" });
    derived.value = 11;
    registry.onDerivedRevisionChanged();
    expect(registry.pendingCount).toBe(0);
    registry.prune();
    expect(registry.get(a.commandId)).toBeUndefined();
    expect(registry.get(b.commandId)).toBeUndefined();
  });
});

describe("本地瞬时状态（任务 6.7）", () => {
  it("selection / dragPreview / drafts 初始为空且不在命令路径上", () => {
    const transient = createTransientCanvasState();
    expect(transient.selectedNodeId).toBeNull();
    expect(transient.dragPreview).toEqual({});
    expect(transient.drafts).toEqual({});
    expect(TRANSIENT_ONLY_FIELDS).toEqual(["selectedNodeId", "dragPreview", "drafts"]);
  });

  it("瞬时状态不参与 revision（类型层面独立）", () => {
    const transient = createTransientCanvasState();
    transient.selectedNodeId = "n1";
    transient.dragPreview["n1"] = { x: 10, y: 20 };
    transient.drafts["n1"] = { panelPrompt: "草稿" };
    // 没有任何 revision 概念：对象里没有 revision/命令字段。
    expect(Object.keys(transient).sort()).toEqual(["drafts", "dragPreview", "selectedNodeId"]);
  });
});

describe("Yjs 模式下无离线 outbox（任务 6.8）", () => {
  it("断线进入只读，且重连只发送 state vector（step1）", () => {
    // 该行为由 ReadonlyCanvasProvider 保证：出站只有 step1 与 COMMAND，没有 outbox 概念。
    // 这里断言 facade 层不提供任何「离线队列」入口（类型层面）。
    const registry = new CommandLifecycleRegistry({
      derivedRevision: () => 0,
      generateCommandId: () => "cmd-1"
    });
    // pending 命令在断线时不会自动重放：只有显式 applyResult 才会推进。
    const handle = registry.begin(0);
    expect(handle.state).toBe("pending");
    expect(registry.pendingCount).toBe(1);
    // 没有任何「replay/flush outbox」方法。
    expect((registry as unknown as Record<string, unknown>).flush).toBeUndefined();
    expect((registry as unknown as Record<string, unknown>).replay).toBeUndefined();
  });
});

describe("静态边界：无 synced Y.Doc 直接写入（任务 6.5）", () => {  // 递归收集 src 下的生产源码（排除测试）。
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(SRC_DIR);

  it("canvas-state 生产源码不 import yjs（保持中立边界）", () => {
    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return /from\s+["']yjs["']/.test(source);
    });
    expect(offenders.map((file) => path.relative(SRC_DIR, file))).toEqual([]);
  });

  it("canvas-state 生产源码不出现 Y.Doc 直接写 API（transact/getMap/set）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      // 去注释后再扫描：文档里提到「cache transaction」不是实现。
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/\bgetMap\(|\bdoc\.transact\(|Y\.applyUpdate\b/.test(source)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
