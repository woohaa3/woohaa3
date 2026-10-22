import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function setup() {
  vi.useFakeTimers();
  vi.resetModules();
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const { recordStartupFrame } = await import("./startup-trace.js");
  const record = (generation: number) => recordStartupFrame("host-frame", { nodeId: "node", generation, totalMs: 1 });
  const report = (index = 0) => JSON.parse(log.mock.calls[index][0].slice("[shot-startup] host-batch ".length));
  return { log, record, report };
}
describe("startup frame batching", () => {
  it("does not print while collecting and never rearms a completed session", async () => {
    const { log, record, report } = await setup();
    record(1);
    vi.advanceTimersByTime(1000); record(1);
    expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(report().samples).toHaveLength(1);
    expect(report().parts).toBe(2);
    expect(report(1).part).toBe(2);
    expect(report().reason).toBe("window-complete");
    record(1); vi.advanceTimersByTime(3000);
    expect(log).toHaveBeenCalledTimes(2);
  });
  it("flushes a replaced session without mixing generations", async () => {
    const { log, record, report } = await setup();
    record(1); record(2);
    expect(report().reason).toBe("session-replaced");
    expect(report().samples[0].generation).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(log).toHaveBeenCalledTimes(2);
    expect(report(1).samples[0].generation).toBe(2);
  });
  it("bounds retained samples even when timer execution is delayed", async () => {
    const { log, record, report } = await setup();
    for (let i = 0; i < 300; i++) record(1);
    expect(report().reason).toBe("sample-limit");
    expect(report().samples).toHaveLength(1);
    expect(report().parts).toBe(240);
    expect(report(239).part).toBe(240);
    for (const [line] of log.mock.calls) expect(line.length).toBeLessThan(2000);
    vi.advanceTimersByTime(3000);
    expect(log).toHaveBeenCalledTimes(240);
  });
});
