import { describe, expect, it, vi } from "vitest";
import { createLeasedTransport } from "./managed-runtime.js";

describe("managed Agent runtime leases", () => {
  it("resolves again for every turn and releases even if the transport throws", async () => {
    const release = vi.fn();
    const resolve = vi.fn(async () => ({ entry: "/runtime/codex", version: "0.161.0", source: "managed" as const, kind: "executable" as const, release }));
    const run = vi.fn(async () => { throw new Error("turn failed"); });
    const make = vi.fn(async () => ({ run }));
    const transport = createLeasedTransport({ resolve }, "codex", make);
    await expect(transport.run({} as never)).rejects.toThrow("turn failed");
    await expect(transport.run({} as never)).rejects.toThrow("turn failed");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(make).toHaveBeenCalledWith("/runtime/codex");
    expect(make).toHaveBeenCalledTimes(1);
  });
  it("missing components never construct a transport or trigger installation", async () => {
    const make = vi.fn();
    const resolve = vi.fn(async () => { throw new Error("请在运行时组件中安装 Codex"); });
    const transport = createLeasedTransport({ resolve }, "codex", make);
    await expect(transport.run({} as never)).rejects.toThrow("运行时组件");
    expect(make).not.toHaveBeenCalled();
  });
});

  it("reserves the DSH context before asynchronous component resolution", async () => {
    let ready!: (value: { entry: string; release: () => void }) => void;
    const pending = new Promise<{ entry: string; release: () => void }>((resolve) => { ready = resolve; });
    const resolve = vi.fn(() => pending);
    const transport = createLeasedTransport({ resolve }, "dsh", async () => ({ run: async () => ({ ok: true, assistantText: "ok", toolCalls: [], finishReason: "stop" }) }));
    const first = transport.run({ resourceKey: "same" } as never);
    expect(await transport.run({ resourceKey: "same" } as never)).toMatchObject({ ok: false, code: "capability-unsupported" });
    expect(resolve).toHaveBeenCalledTimes(1);
    ready({ entry: "/runtime/dsh", release() {} });
    expect(await first).toMatchObject({ ok: true });
  });
