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
    /** 按到期先后触发最早的一个（探测看门狗与退避可能同时在队列里）。 */
    async fire() {
      let index = 0;
      for (let i = 1; i < pending.length; i += 1) {
        if ((pending[i]?.ms ?? 0) < (pending[index]?.ms ?? 0)) index = i;
      }
      const entry = pending.splice(index, 1)[0];
      entry?.callback();
      // 让 probe 的 await 链（含看门狗竞速）跑完。
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      return entry?.ms;
    }
  };
}

/** 可控探测：结果按队列返回，`hang()` 挂住的那次用来模拟重启窗口里被吊住的请求。 */
function controllableProbe() {
  const queue: Array<Promise<HostProbeResult>> = [];
  return {
    succeed(next: HostProbeResult = { reachable: true, releaseId: "r1" }) {
      queue.push(Promise.resolve(next));
    },
    hang() {
      let settle!: (result: HostProbeResult) => void;
      queue.push(new Promise<HostProbeResult>((resolve) => {
        settle = resolve;
      }));
      return settle;
    },
    probe: async (): Promise<HostProbeResult> => (await queue.shift()) ?? { reachable: false }
  };
}

/** 让探测的 await 链（含看门狗竞速）跑完。 */
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function harness(probe: () => Promise<HostProbeResult>, pinned: string | null = "r1") {
  const timers = manualTimers();
  let reopened = 0;
  const service = createHostConnectivityService({
    probe,
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

function setup(results: HostProbeResult[], pinned: string | null = "r1") {
  const { service, timers, reopened } = harness(async () => results.shift() ?? { reachable: false }, pinned);
  return { service, timers, reopened };
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

  it("退避到点撞上在飞探测时不丢拍：循环保持心跳，探测落地后仍能撤除遮罩", async () => {
    // 回归：退出安全模式。HTTP 侧探活占住 probing 且结果按代次作废，若到点的退避被
    // `if (probing) return` 吃掉，定时器已清空 → 再没有任何通路撤除 reconnecting，
    // 页面永远停在「正在重新连接本机服务…」，只有强制刷新（模块状态重置）才恢复。
    const probe = controllableProbe();
    const { service, timers } = harness(probe.probe);

    // HTTP 侧探活先挂住，占住 probing（真实场景：轮询失败触发的 verifyReachability）。
    const settle = probe.hang();
    service.reportHttp(false);
    service.reportHttp(false);
    await flush();
    expect(service.getSnapshot().phase).toBe("online");

    // 这一拍进入重连；退避到期时 probing 仍被上面那次探活占着。
    service.reportTransport("closed");
    await timers.fire();
    expect(service.getSnapshot().phase).toBe("reconnecting");
    // 关键：被挡下的那一拍必须重新排上退避，而不是留下空循环。
    expect(timers.pending.filter((entry) => entry.ms <= 1_000)).toHaveLength(1);

    // 那次探活终于返回（结果按代次作废），循环从这一拍继续。
    settle({ reachable: false });
    await flush();
    probe.succeed({ reachable: true, releaseId: "r1" });
    await timers.fire();
    expect(service.getSnapshot().phase).toBe("online");
  });

  it("探测被吊住也按不可达处理：看门狗超时后照常退避，恢复时仍撤除遮罩", async () => {
    const probe = controllableProbe();
    const { service, timers } = harness(probe.probe);
    service.expectRestart();
    probe.hang();
    await timers.fire();
    // 探测挂住：队列里只剩看门狗，probing 不会被永久占住。
    expect(service.getSnapshot().phase).toBe("reconnecting");
    expect(timers.pending.map((entry) => entry.ms)).toEqual([5_000]);
    await timers.fire();
    // 超时按不可达 → 重新排上退避。
    expect(timers.pending.map((entry) => entry.ms)).toEqual([1_000]);
    expect(service.getSnapshot().phase).toBe("reconnecting");
    probe.succeed({ reachable: true, releaseId: "r1" });
    await timers.fire();
    expect(service.getSnapshot().phase).toBe("online");
  });

  it("重连期间同源请求成功会打断长退避，恢复不必等满 15s", async () => {
    const { service, timers } = setup([]);
    service.expectRestart();
    // 退避已累积到 15s：用户正对着遮罩。
    for (let i = 0; i < 6; i += 1) await timers.fire();
    expect(timers.pending.map((entry) => entry.ms)).toEqual([15_000]);
    // 宿主已经在应答（同源轮询成功），立刻探活收尾。
    service.reportHttp(true);
    expect(timers.pending.map((entry) => entry.ms)).toEqual([0]);
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
