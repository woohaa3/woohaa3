import { describe, expect, it, vi } from "vitest";
import { createInteractionFrameLoop } from "./interaction-frame-loop.js";

function clock() {
  let id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const target = {
    requestAnimationFrame: (callback: FrameRequestCallback) => { pending.set(++id, callback); return id; },
    cancelAnimationFrame: (frame: number) => { pending.delete(frame); }
  };
  return { target, pending, advance() { const work = [...pending.values()]; pending.clear(); for (const callback of work) callback(0); } };
}

describe("永久帧调度外壳", () => {
  it("飞行推进和诊断通知持续失败也不阻止渲染与续帧", () => {
    const time = clock();
    const render = vi.fn();
    const loop = createInteractionFrameLoop({ target: time.target,
      advance: () => { throw new Error("fly"); }, render,
      report: () => { throw new Error("observer"); }, recovered: () => { throw new Error("observer"); } });
    loop.start(); loop.start();
    for (let index = 0; index < 3; index++) {
      expect(() => time.advance()).not.toThrow();
      expect(time.pending.size).toBe(1);
    }
    expect(render).toHaveBeenCalledTimes(3);
    loop.dispose();
    expect(time.pending.size).toBe(0);
    time.advance();
    expect(render).toHaveBeenCalledTimes(3);
  });
  it("render 抛错后 finally 续帧；帧中 dispose 不再登记", () => {
    const time = clock();
    let disposeDuringFrame = false;
    const loop = createInteractionFrameLoop({ target: time.target, advance: () => undefined,
      render: () => { if (disposeDuringFrame) loop.dispose(); throw "frame failure"; },
      report: vi.fn(), recovered: vi.fn() });
    loop.start(); time.advance();
    expect(time.pending.size).toBe(1);
    disposeDuringFrame = true; time.advance();
    expect(time.pending.size).toBe(0);
  });
});
