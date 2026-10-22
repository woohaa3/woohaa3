import { expect, it, vi } from "vitest";
import { createCommandConfirmation } from "./interaction-command-confirmation.js";
import type { InteractionSample } from "./interaction-performance.js";

it("correlates out-of-order confirmations without counting unavailable callbacks as commits", async () => {
  vi.useFakeTimers();
  try {
    const samples: InteractionSample[] = [];
    let now = 0;
    let resolve!: (value: "committed") => void;
    let identity = "original";
    const observer = createCommandConfirmation(globalThis as unknown as Window, () => now,
      () => ({ pixelRatio: 2, identity: { js: identity, wasm: "w", mode: "dev" } }), sample => samples.push(sample));
    const first = observer.observe(new Promise<"committed">(done => { resolve = done; }), "move-submit");
    const second = observer.observe(undefined, "move-submit");
    now = 4;
    await Promise.resolve();
    expect(samples[0]).toMatchObject({ commandId: second, command: { outcome: "unavailable", waitMs: 4 }, handlerMs: 0, nextRafMs: null });
    identity = "new-build";
    now = 25;
    resolve("committed");
    await Promise.resolve();
    expect(samples[1]).toMatchObject({ commandId: first, command: { outcome: "committed", waitMs: 25 }, context: { identity: { js: "original" } } });
    observer.observe(new Promise(() => {}), "reparent-submit");
    now = 30_025;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(samples[2]?.command?.outcome).toBe("unavailable");
    observer.observe(new Promise(() => {}), "attach-submit");
    observer.dispose();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(samples).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
