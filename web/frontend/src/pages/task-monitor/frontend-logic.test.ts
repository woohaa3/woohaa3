/**
 * task-monitor 前端纯逻辑测试
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 8.4/8.5 / design D11）。
 *
 * 只测无 React/DOM 依赖的纯函数：查询编解码往返、actor/耗时展示不猜测（未知显示「未知」、
 * 终态冻结、在途按时钟偏差保护递增）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPEN_TASK_INSPECTION_ACTION, TASKS_INSPECT_ACTION } from "@woohaa3/contracts";
import { installTaskMonitorAction } from "./entry.js";
import { pageQueryFromTaskMonitor, taskMonitorQueryFromPage } from "./route.js";
import { actorLabel, effectiveTotalMs, formatDuration, shortcutRange, sourceLabel } from "./format.js";

describe("内置任务监控宿主接线", () => {
  // Bug 回归：page-scope plugin 曾把完整的 `applicationRemote` 服务直接交给 remote，
  // 但 `createTaskMonitorRemote` 期望的是 transport 的 `request` 方法，导致生产页面
  // 调用 `e.remote.request is not a function`，监控永远停在加载态。
  it("route 从 applicationRemote.transport 构造 remote（接线正确）", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(here, "route.tsx"), "utf8");
    expect(source).toContain("ctx.applicationRemote.transport");
    expect(source).not.toMatch(/createTaskMonitorRemote\(\{\s*remote:\s*ctx\.applicationRemote\s*\}\)/);
  });
});

describe("task-monitor 查询编解码", () => {
  it("页面查询 → 领域查询 → 页面查询往返稳定", () => {
    const pageQuery = { state: "failed", providerId: "litellm", canvasId: "c1", nodeId: "n1", taskKey: "t1" };
    const decoded = taskMonitorQueryFromPage(pageQuery);
    expect(decoded.query).toMatchObject({ state: "failed", providerId: "litellm", canvasId: "c1", nodeId: "n1" });
    expect(decoded.taskKey).toBe("t1");
    const reencoded = pageQueryFromTaskMonitor({ query: decoded.query, ...(decoded.taskKey ? { taskKey: decoded.taskKey } : {}) });
    expect(reencoded).toMatchObject({ state: "failed", providerId: "litellm", canvasId: "c1", nodeId: "n1", taskKey: "t1" });
  });

  it("未知状态值解码为稳定空查询（不抛错、不伪造）", () => {
    const decoded = taskMonitorQueryFromPage({ state: "bogus" });
    expect(decoded).toEqual({ query: {}, opaqueCursor: false });
  });

  it("游标出现在查询时标记 opaqueCursor（深层链接）", () => {
    const decoded = taskMonitorQueryFromPage({ cursor: "abc" });
    expect(decoded.opaqueCursor).toBe(true);
    expect(decoded.query.cursor).toBe("abc");
  });
});

describe("旧 /task-history 深链接查询参数迁移（任务 9.1）", () => {
  it("旧 tab=active 迁移为多状态筛选", () => {
    const decoded = taskMonitorQueryFromPage({ tab: "active" });
    expect(decoded.query.states).toEqual(["queued", "pending", "running"]);
    expect(decoded.query.state).toBeUndefined();
  });

  it("旧 tab=succeeded/failed/cancelled 迁移为单一 state", () => {
    expect(taskMonitorQueryFromPage({ tab: "succeeded" }).query.state).toBe("succeeded");
    expect(taskMonitorQueryFromPage({ tab: "failed" }).query.state).toBe("failed");
    expect(taskMonitorQueryFromPage({ tab: "cancelled" }).query.state).toBe("cancelled");
  });

  it("旧 tab=all / 未知 tab 不产生状态筛选", () => {
    expect(taskMonitorQueryFromPage({ tab: "all" }).query).toEqual({});
    expect(taskMonitorQueryFromPage({ tab: "bogus" }).query).toEqual({});
  });

  it("显式 state/states 优先于旧 tab", () => {
    expect(taskMonitorQueryFromPage({ tab: "failed", state: "succeeded" }).query.state).toBe("succeeded");
    expect(taskMonitorQueryFromPage({ tab: "active", states: "queued" }).query.states).toEqual(["queued"]);
  });

  it("旧 tab 迁移保留其余白名单参数（canvasId/nodeId）", () => {
    const decoded = taskMonitorQueryFromPage({ tab: "active", canvasId: "c1", nodeId: "n1" });
    expect(decoded.query).toMatchObject({ canvasId: "c1", nodeId: "n1" });
    expect(decoded.query.states).toEqual(["queued", "pending", "running"]);
  });
});

describe("task-monitor 展示辅助", () => {
  it("actor 缺失/未知显示「未知」，不反填查看者", () => {
    expect(actorLabel(undefined)).toBe("未知");
    expect(actorLabel({ subject: "alice", unknown: true })).toBe("未知");
    expect(actorLabel({ subject: "alice", displayName: "Alice" })).toBe("Alice");
  });

  it("source 未知显示「未知来源」", () => {
    expect(sourceLabel("canvas")).toBe("画布");
    expect(sourceLabel("extension")).toBe("插件");
    expect(sourceLabel(undefined)).toBe("未知来源");
  });

  it("耗时为负数/缺失显示「未知」", () => {
    expect(formatDuration(undefined)).toBe("未知");
    expect(formatDuration(-1)).toBe("未知");
    expect(formatDuration(1500)).toBe("1.5s");
  });

  it("在途耗时按 observedAt 递增，终态冻结", () => {
    const timing = { observedAt: "2026-10-13T00:00:00.000Z", totalMs: 1000 };
    const observedMs = Date.parse("2026-10-13T00:00:00.000Z");
    expect(effectiveTotalMs(timing, "running", observedMs + 5000)).toBe(6000);
    // 终态冻结。
    expect(effectiveTotalMs(timing, "succeeded", observedMs + 5000)).toBe(1000);
  });

  it("时间快捷项给出绝对 [from, to]（UTC ISO）", () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const range = shortcutRange({ id: "last-24h", label: "最近 24 小时", hours: 24 }, now);
    expect(range.to).toBe("2026-10-13T12:00:00.000Z");
    expect(range.from).toBe("2026-10-12T12:00:00.000Z");
  });
});

describe("openTaskInspection 动作与 tasks.inspect 门控（任务 8.6）", () => {
  type SiteAccess = { hasAction: (action: string) => boolean };

  function mountSitePlugin(siteAccess?: SiteAccess) {
    const provided = new Map<string, unknown>();
    const toolbar: Array<{ id: string; onActivate: () => void }> = [];
    const navigations: unknown[] = [];
    const ctx = {
      get: (key: string) => (key === "siteAccessCapability" ? siteAccess : undefined),
      provide: (key: string, value: unknown) => {
        provided.set(key, value);
      },
      slots: {
        register: (_slot: string, contribution: { id: string; onActivate: () => void }) => {
          toolbar.push(contribution);
          return () => {
            const index = toolbar.indexOf(contribution);
            if (index >= 0) toolbar.splice(index, 1);
          };
        }
      },
      appRouter: { navigate: (to: unknown) => void navigations.push(to) },
      effect: () => undefined
    };
    installTaskMonitorAction(ctx as never);
    return {
      provided,
      toolbar,
      navigations,
      open: (input?: { canvasId?: string; nodeId?: string }) =>
        (provided.get(OPEN_TASK_INSPECTION_ACTION) as { open: (i?: { canvasId?: string; nodeId?: string }) => void }).open(input),
      available: () =>
        (provided.get(OPEN_TASK_INSPECTION_ACTION) as { available: () => boolean }).available()
    };
  }

  it("无 site-access 能力时动作不可用，且 open 不导航", () => {
    const mounted = mountSitePlugin();
    expect(mounted.available()).toBe(false);
    mounted.open({ canvasId: "c1" });
    expect(mounted.navigations).toHaveLength(0);
  });

  it("具备 tasks.inspect 时提供可用动作（导航到监控页）", () => {
    const mounted = mountSitePlugin({ hasAction: (action) => action === TASKS_INSPECT_ACTION });
    expect(mounted.available()).toBe(true);
    mounted.open();
    expect(mounted.navigations).toHaveLength(1);
    expect(mounted.navigations[0]).toMatchObject({ page: "task-monitor" });
  });

  it("画布工具栏不注册任务监控按钮", () => {
    const mounted = mountSitePlugin({ hasAction: () => true });
    expect(mounted.toolbar).toHaveLength(0);
  });
});
