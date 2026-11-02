/**
 * 图片读取 / 解码两级闸门的逻辑门禁。
 *
 * 这里锁定的是**调度不变式**，不是硬件时间：读取名额（在飞网络数）与解码名额（CPU/内存）
 * 分开计费，解码按输出档位加权，大档维持 2 个并行。真实吞吐必须在真实设备上采集，见
 * change 的 verification.md。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_DECODE_RESERVATION_BYTES, IMAGE_FETCH_RESERVATION_BYTES } from "@woohaa3/contracts";
import { CanvasResourceCoordinator } from "./coordinator.js";
import {
  DEFAULT_RESIDENCY_POLICY,
  byteBudget,
  concurrencyLimit,
  imageDecodeBudget,
  imageDecodeReservation
} from "./policy.js";
import { registerImageCoordinator, prepareImageResource } from "../image-worker/client.js";
import { registerNativeImagePort, type NativeImagePort } from "../image-worker/native-port.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

type Gate = Map<string, () => void>;
function holder(coordinator: CanvasResourceCoordinator, started: string[], gates: Gate) {
  return (channel: "image" | "image-fetch", key: string, bytes: number) => coordinator.admit<void>({
    channel, key, purpose: "visible", bytes, abortable: false,
    run: () => new Promise<void>((resolve) => { started.push(`${channel}:${key}`); gates.set(key, resolve); })
  });
}
const finishAll = async (gates: Gate) => {
  for (let round = 0; round < 12; round++) {
    const waiting = [...gates.values()];
    if (!waiting.length) return;
    gates.clear();
    for (const gate of waiting) gate();
    await settle();
  }
};

describe("图片解码按档位加权", () => {
  it("小档半份预留、大档整份；同一预算下 4 个小档或 2 个大档", () => {
    expect(imageDecodeReservation(128)).toBe(IMAGE_DECODE_RESERVATION_BYTES / 2);
    expect(imageDecodeReservation(512)).toBe(IMAGE_DECODE_RESERVATION_BYTES / 2);
    expect(imageDecodeReservation(1024)).toBe(IMAGE_DECODE_RESERVATION_BYTES);
    const budget = imageDecodeBudget(DEFAULT_RESIDENCY_POLICY);
    expect(budget / imageDecodeReservation(1024)).toBe(2);
    expect(budget / imageDecodeReservation(256)).toBe(4);
  });

  it("实例硬顶与读取闸门是独立数值，读取预算不含解码 scratch", () => {
    expect(concurrencyLimit(DEFAULT_RESIDENCY_POLICY, "image")).toBe(4);
    expect(concurrencyLimit(DEFAULT_RESIDENCY_POLICY, "image-fetch")).toBe(6);
    expect(byteBudget(DEFAULT_RESIDENCY_POLICY, "image"))
      .toBe(2 * IMAGE_DECODE_RESERVATION_BYTES);
    expect(byteBudget(DEFAULT_RESIDENCY_POLICY, "image-fetch"))
      .toBe(6 * IMAGE_FETCH_RESERVATION_BYTES);
  });

  it("大档仍只并行 2 个：预算先于实例上限绑定", async () => {
    const coordinator = new CanvasResourceCoordinator();
    const started: string[] = [];
    const gates: Gate = new Map();
    const hold = holder(coordinator, started, gates);
    const jobs = ["l1", "l2", "l3"].map((key) => hold("image", key, imageDecodeReservation(1024)));
    await settle();
    expect(started).toEqual(["image:l1", "image:l2"]);
    expect(coordinator.channelSnapshot("image")).toMatchObject({ inFlight: 2, pending: 1 });

    gates.get("l1")!();
    await settle();
    // 一个名额归还后第 3 个大档才进入；实例上限 4 不会放大整份预留。
    expect(started).toEqual(["image:l1", "image:l2", "image:l3"]);
    await finishAll(gates);
    await Promise.all(jobs);
    coordinator.dispose();
  });

  it("小档能跑满实例上限 4 个，第 5 个仍然排队", async () => {
    const coordinator = new CanvasResourceCoordinator();
    const started: string[] = [];
    const gates: Gate = new Map();
    const hold = holder(coordinator, started, gates);
    const jobs = ["s1", "s2", "s3", "s4", "s5"].map((key) => hold("image", key, imageDecodeReservation(256)));
    await settle();
    expect(started).toEqual(["image:s1", "image:s2", "image:s3", "image:s4"]);
    expect(coordinator.channelSnapshot("image")).toMatchObject({ inFlight: 4, pending: 1 });
    await finishAll(gates);
    await Promise.all(jobs);
    coordinator.dispose();
  });

  it("读取名额满额时解码照常开始，解码满额时读取照常开始", async () => {
    const coordinator = new CanvasResourceCoordinator();
    const started: string[] = [];
    const gates: Gate = new Map();
    const hold = holder(coordinator, started, gates);
    const reads = Array.from({ length: 6 }, (_, index) =>
      hold("image-fetch", `r${index}`, IMAGE_FETCH_RESERVATION_BYTES));
    await settle();
    expect(started.filter((entry) => entry.startsWith("image-fetch:"))).toHaveLength(6);

    // 读取通道已经满额：解码不必等网络名额。
    const decodes = ["d0", "d1", "d2", "d3"].map((key) => hold("image", key, imageDecodeReservation(256)));
    await settle();
    expect(started.filter((entry) => entry.startsWith("image:"))).toEqual([
      "image:d0", "image:d1", "image:d2", "image:d3"
    ]);
    expect(coordinator.channelSnapshot("image")).toMatchObject({ inFlight: 4 });
    // 反向：解码满额不阻塞新的读取（读取与解码是两条独立通道）。
    gates.get("r0")!();
    await settle();
    const extraRead = hold("image-fetch", "r6", IMAGE_FETCH_RESERVATION_BYTES);
    await settle();
    expect(started).toContain("image-fetch:r6");
    expect(coordinator.channelSnapshot("image")).toMatchObject({ inFlight: 4 });

    await finishAll(gates);
    await Promise.all([...reads, ...decodes, extraRead]);
    coordinator.dispose();
  });
});

describe("页面侧两段流水线", () => {
  let unregisterCoordinator: (() => void) | undefined;
  let unregisterPort: (() => void) | undefined;
  afterEach(() => { unregisterCoordinator?.(); unregisterPort?.(); vi.unstubAllGlobals(); });

  it("读取阶段只占 image-fetch，字节落地后才占 image", async () => {
    vi.stubGlobal("location", new URL("http://localhost/dev/test/"));
    const coordinator = new CanvasResourceCoordinator();
    unregisterCoordinator = registerImageCoordinator(coordinator);

    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let chunk = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-length" ? "4" : null) },
      body: {
        getReader: () => ({
          read: async () => {
            if (chunk++ === 0) { await readGate; return { value: new Uint8Array([1, 2, 3, 4]), done: false }; }
            return { value: undefined, done: true };
          },
          cancel: async () => undefined
        })
      }
    })));

    let releaseDecode!: () => void;
    const decodeGate = new Promise<void>((resolve) => { releaseDecode = resolve; });
    const port: NativeImagePort = {
      prepare: vi.fn(),
      prepareBytes: vi.fn(async () => {
        await decodeGate;
        return { width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, pixels: new Uint8Array(4) };
      }),
      apply: vi.fn(),
      release: vi.fn()
    };
    unregisterPort = registerNativeImagePort(port);

    const prepared = prepareImageResource("/media/p.png?canvas=a", 256);
    await settle();
    // 只在等 RTT：读取名额占 1，解码名额必须是 0，否则 3000 张图会被 RTT 串行化。
    expect(coordinator.channelSnapshot("image-fetch")).toMatchObject({ inFlight: 1 });
    expect(coordinator.channelSnapshot("image")).toMatchObject({ inFlight: 0 });
    expect(port.prepareBytes).not.toHaveBeenCalled();

    releaseRead();
    await settle();
    // 字节落地：读取名额立即归还，解码名额此刻才申请。
    expect(coordinator.channelSnapshot("image-fetch")).toMatchObject({ inFlight: 0 });
    expect(coordinator.channelSnapshot("image")).toMatchObject({ inFlight: 1 });
    expect(port.prepareBytes).toHaveBeenCalledOnce();

    releaseDecode();
    const result = await prepared;
    expect(coordinator.channelSnapshot("image")).toMatchObject({ inFlight: 0 });
    expect(result.width).toBe(1);
    coordinator.dispose();
  });

  it("取消准入键立即归还读取名额（解码不可抢占，取消后 draining）", async () => {
    vi.stubGlobal("location", new URL("http://localhost/dev/test/"));
    const coordinator = new CanvasResourceCoordinator();
    unregisterCoordinator = registerImageCoordinator(coordinator);
    // 读取永不返回，直到被 abort：验证取消走的是「立即归还读取名额」而不是等 RTT。
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));

    const prepared = prepareImageResource("/media/slow.png?canvas=a", 256, undefined, { key: "content#7" });
    await settle();
    expect(coordinator.channelSnapshot("image-fetch")).toMatchObject({ inFlight: 1 });
    expect(coordinator.channelSnapshot("image")).toMatchObject({ inFlight: 0 });

    coordinator.cancel("content#7");
    await expect(prepared).rejects.toThrow("image-cancelled");
    expect(coordinator.channelSnapshot("image-fetch")).toMatchObject({ inFlight: 0 });
    coordinator.dispose();
  });
});
