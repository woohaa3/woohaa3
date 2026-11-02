import { describe, expect, it } from "vitest";
import { createHostConnectivityService, createReleaseDiscoveryProbe, type HostProbeResult } from "./host-connectivity.js";

/** 手动推进的计时器：只记录待触发回调与延迟。 */
function manualTimers() {
  const pending: Array<{ callback: () => void; ms: number }> = [];
  return {
    pending,
    setTimer: (callback: () => void, ms: number) => {
      const entry = { callback, ms };
      pending.push(entry);
      return entry;
    },
    clearTimer: (handle: unknown) => {
      const index = pending.indexOf(handle as (typeof pending)[number]);
      if (index >= 0) pending.splice(index, 1);
    },
    async fire() {
      const entry = pending.shift();
      entry?.callback();
      // 让 probe 的 await 链跑完。
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      return entry?.ms;
    }
  };
}

function setup(results: HostProbeResult[], pinned: string | null = "r1") {
  const timers = manualTimers();
  let reopened = 0;
  const service = createHostConnectivityService({
    probe: async () => results.shift() ?? { reachable: false },
    pinnedReleaseId: () => pinned,
    reopenCanvas: (next) => {
      expect(next.releaseId).toBe("r2");
      reopened += 1;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  return { service, timers, reopened: () => reopened };
}

describe("HostConnectivity", () => {
  it("单次 HTTP 抖动不闪遮罩；连续失败且宿主探活失败才进入 reconnecting 并阻止提交", async () => {
    const { service } = setup([]);
    service.reportHttp(false);
    expect(service.getSnapshot().phase).toBe("online");
    service.reportHttp(true);
    service.reportHttp(false);
    expect(service.getSnapshot().phase).toBe("online");
    service.reportHttp(false);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(service.getSnapshot().phase).toBe("reconnecting");
    expect(service.blocksSubmissions()).toBe(true);
  });

  it("扩展接口连续返回 503、但宿主探活成功时不闪重连遮罩", async () => {
    // 真实场景：/api/oauth-agent/status、/api/canvases/:id/recording 等扩展接口轮询失败；
    // 它们不代表宿主不可达，不能把整页盖成「正在重新连接本机服务…」。
    const { service } = setup([{ reachable: true, releaseId: "r1" }]);
    service.reportHttp(false);
    service.reportHttp(false);
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(service.getSnapshot().phase).toBe("online");
    expect(service.blocksSubmissions()).toBe(false);
  });

  it("transport 断开直接进入重连；恢复后 releaseId 未变 → 撤除遮罩", async () => {
    const { service, timers } = setup([{ reachable: true, releaseId: "r1" }]);
    service.reportTransport("closed");
    expect(service.getSnapshot().phase).toBe("reconnecting");
    await timers.fire();
    expect(service.getSnapshot()).toEqual({ phase: "online", attempts: 0, nextReleaseId: null });
    expect(service.blocksSubmissions()).toBe(false);
  });

  it("恢复后 releaseId 变化 → restarted 非阻断提示，确认后只调用重开画布", async () => {
    const { service, timers, reopened } = setup([{ reachable: true, releaseId: "r2", href: "/extension-releases/r2.json" }]);
    service.expectRestart();
    await timers.fire();
    expect(service.getSnapshot()).toMatchObject({ phase: "restarted", nextReleaseId: "r2", nextReleaseHref: "/extension-releases/r2.json" });
    expect(service.blocksSubmissions()).toBe(false);
    await service.reopenCanvas();
    expect(reopened()).toBe(1);
    expect(service.getSnapshot().phase).toBe("online");
  });

  it("restarted 可暂不重开：收起提示，不调用重开", async () => {
    const { service, timers, reopened } = setup([{ reachable: true, releaseId: "r2" }]);
    service.expectRestart();
    await timers.fire();
    service.dismissRestarted();
    expect(service.getSnapshot().phase).toBe("online");
    expect(reopened()).toBe(0);
  });

  it("宿主长时间不可达：保持 reconnecting 并指数退避（上限 15s）", async () => {
    const { service, timers } = setup([]);
    service.expectRestart();
    const delays: Array<number | undefined> = [];
    for (let i = 0; i < 7; i += 1) {
      delays.push(timers.pending[0]?.ms);
      await timers.fire();
      expect(service.getSnapshot().phase).toBe("reconnecting");
    }
    expect(delays).toEqual([1000, 1000, 2000, 4000, 8000, 15000, 15000]);
    expect(service.getSnapshot().attempts).toBe(7);
  });

  it("无固定 release（本页没有发布目录）时恢复即在线，不误报更新", async () => {
    const { service, timers } = setup([{ reachable: true, releaseId: "r9" }], null);
    service.expectRestart();
    await timers.fire();
    expect(service.getSnapshot().phase).toBe("online");
  });

  it("宿主在线但发布目录切换（受管扩展升级）：offerRelease 走同一 restarted 提示，确认后重开画布", async () => {
    const { service, timers, reopened } = setup([]);
    service.offerRelease({ releaseId: "r1", href: "/extension-releases/r1.json" });
    expect(service.getSnapshot().phase).toBe("online");
    service.offerRelease({ releaseId: "r2", href: "/extension-releases/r2.json" });
    expect(service.getSnapshot()).toMatchObject({ phase: "restarted", nextReleaseId: "r2", nextReleaseHref: "/extension-releases/r2.json" });
    expect(service.blocksSubmissions()).toBe(false);
    await service.reopenCanvas();
    expect(reopened()).toBe(1);
    expect(service.getSnapshot().phase).toBe("online");
    // 重连中不打断：恢复后的探测给出最新 release。
    service.reportTransport("closed");
    service.offerRelease({ releaseId: "r2", href: "/extension-releases/r2.json" });
    expect(service.getSnapshot().phase).toBe("reconnecting");
    expect(timers.pending.length).toBe(1);
  });

  it("dispose 取消待触发探测", () => {
    const { service, timers } = setup([]);
    service.expectRestart();
    expect(timers.pending).toHaveLength(1);
    service.dispose();
    expect(timers.pending).toHaveLength(0);
  });
});

describe("createReleaseDiscoveryProbe", () => {
  const respond = (status: number, body?: unknown) =>
    (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("200 带 releaseId；404 可达但无目录；5xx 与网络失败视为不可达", async () => {
    expect(await createReleaseDiscoveryProbe(respond(200, { releaseId: "abc", href: "/x" }))()).toEqual({ reachable: true, releaseId: "abc", href: "/x" });
    expect(await createReleaseDiscoveryProbe(respond(404))()).toEqual({ reachable: true, releaseId: null });
    expect(await createReleaseDiscoveryProbe(respond(502))()).toEqual({ reachable: false });
    const failing = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    expect(await createReleaseDiscoveryProbe(failing)()).toEqual({ reachable: false });
  });
});
