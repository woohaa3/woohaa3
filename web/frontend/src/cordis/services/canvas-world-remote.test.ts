import { describe, expect, it, vi } from "vitest";
import { createCanvasRemote } from "./canvas-remote.js";

describe("world authoring remote", () => {
  it("maps context and camera history to the canvas HTTP routes", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const remote = createCanvasRemote({ canvasId: "canvas / 1", fetchImpl: fetchImpl as typeof fetch });
    await remote.revokeWorldToolContext({ canvasId: "canvas / 1", contextId: "ctx" });
    await remote.listWorldCameraHistory({ canvasId: "canvas / 1", cameraId: "camera / 1", limit: 5 });
    expect(fetchImpl.mock.calls[0][0]).toContain("canvas%20%2F%201/world-tool-context-revoke");
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)).toEqual({ contextId: "ctx" });
    expect(fetchImpl.mock.calls[1][0]).toContain("world-camera-history?cameraId=camera+%2F+1&limit=5");
    expect((fetchImpl.mock.calls[1][1] as RequestInit).method).toBe("GET");
  });

  it("preserves authority failures and reports cancellation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "version-conflict", message: "stale" }), { status: 409 }));
    const remote = createCanvasRemote({ canvasId: "c", fetchImpl: fetchImpl as typeof fetch });
    expect(await remote.restoreWorldCamera({ canvasId: "c", cameraId: "camera", completionKey: "key", expectedSettingsVersion: "v" })).toEqual({ ok: false, code: "version-conflict", message: "stale" });
    const controller = new AbortController();
    controller.abort();
    const cancelled = createCanvasRemote({ canvasId: "c", fetchImpl: (async () => { throw new Error("aborted"); }) as typeof fetch });
    expect(await cancelled.listWorldCameraHistory({ canvasId: "c", cameraId: "camera" }, controller.signal)).toMatchObject({ ok: false, code: "cancelled" });
    expect(await remote.revokeWorldToolContext({ canvasId: "other", contextId: "ctx" })).toMatchObject({ ok: false, code: "invalid-data" });
  });
});
