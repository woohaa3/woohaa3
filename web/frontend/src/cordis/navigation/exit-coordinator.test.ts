import { describe, expect, it, vi } from "vitest";
import { FocusExitCoordinator } from "./exit-coordinator.js";

describe("shared focus exit settlement", () => {
  it("clean viewing still animates; simultaneous returns settle once", async () => {
    const coordinator = new FocusExitCoordinator();
    const save = vi.fn(async () => ({ ok: true as const }));
    const animate = vi.fn(async () => undefined);
    coordinator.register({ id: "image", hasUnsavedChanges: () => false, prepare: save, afterPrepare: animate });
    const first = coordinator.prepare();
    expect(coordinator.prepare()).toBe(first);
    expect((await first).ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(1);
  });
  it("failed saves retain the scene and do not start the return animation", async () => {
    const coordinator = new FocusExitCoordinator();
    const animate = vi.fn(async () => undefined);
    coordinator.register({ id: "model", hasUnsavedChanges: () => true, prepare: async () => { throw new Error("网络断开"); }, afterPrepare: animate });
    expect(await coordinator.prepare()).toMatchObject({ ok: false, reason: "网络断开" });
    expect(animate).not.toHaveBeenCalled();
  });
  it("an empty exit does not prevent later sessions from saving", async () => {
    const coordinator = new FocusExitCoordinator();
    await coordinator.prepare();
    const save = vi.fn(async () => ({ ok: true as const }));
    coordinator.register({ id: "next", hasUnsavedChanges: () => true, prepare: save });
    expect((await coordinator.prepare()).ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
