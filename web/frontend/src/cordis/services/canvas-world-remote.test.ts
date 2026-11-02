import { describe, expect, it, vi } from "vitest";
import { createCanvasRemote } from "./canvas-remote.js";

describe("world authoring remote", () => {
  it("maps context and camera history to the canvas HTTP routes", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(String(input).includes("history") ? { ok: true, canvasId: "canvas / 1", cameraId: "camera / 1", entries: [] } : { ok: true }), { status: 200 }));
    const remote = createCanvasRemote({ canvasId: "canvas / 1", fetchImpl: fetchImpl as typeof fetch });
    await remote.revokeWorldToolContext({ canvasId: "canvas / 1", contextId: "ctx" });
    await remote.listWorldCameraHistory({ canvasId: "canvas / 1", cameraId: "camera / 1", limit: 5 });
    expect(fetchImpl.mock.calls[0][0]).toContain("canvas%20%2F%201/world-tool-context-revoke");
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)).toEqual({ contextId: "ctx" });
    expect(fetchImpl.mock.calls[1][0]).toContain("world-camera-history?cameraId=camera+%2F+1&limit=5");
    expect((fetchImpl.mock.calls[1][1] as RequestInit).method).toBe("GET");
  });

  it("maps every authority route and rejects malformed successes", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const remote = createCanvasRemote({ canvasId: "c", fetchImpl: fetchImpl as typeof fetch });
    const calls = [
      () => remote.prepareSceneArea({ canvasId: "c", areaId: "a" }),
      () => remote.executeSceneArea({ canvasId: "c", request: {} } as never),
      () => remote.historySceneArea("undo", { canvasId: "c", operationId: "op" }),
      () => remote.historySceneArea("redo", { canvasId: "c", operationId: "op" }),
      () => remote.issueWorldToolContext({ canvasId: "c" } as never),
      () => remote.saveWorldCamera({ canvasId: "c" } as never),
      () => remote.restoreWorldCamera({ canvasId: "c" } as never),
      () => remote.listWorldCameraHistory({ canvasId: "c", cameraId: "cam" })
    ];
    for (const call of calls) expect(await call()).toMatchObject({ ok: false, code: "not-ready" });
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split("/c/")[1]?.split("?")[0])).toEqual([
      "scene-area-prepare", "scene-area-commit", "scene-area-undo", "scene-area-redo", "world-tool-context", "world-camera-save", "world-camera-restore", "world-camera-history"
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1]!.body as string)).toEqual({ areaId: "a" });
    expect(JSON.parse(fetchImpl.mock.calls[2][1]!.body as string)).toEqual({ operationId: "op" });
  });

  it.each([[410, "DELETED", "not-found"], [409, "PREPARATION_REQUIRED", "not-ready"], [403, "FORBIDDEN", "write-forbidden"], [503, "NOT_READY", "not-ready"]])("decodes HTTP %s envelope", async (status, code, expected) => {
    const remote = createCanvasRemote({ canvasId: "c", fetchImpl: (async () => new Response(JSON.stringify({ code, message: "specific reason" }), { status })) as typeof fetch });
    expect(await remote.prepareSceneArea({ canvasId: "c", areaId: "a" })).toEqual({ ok: false, code: expected, message: "specific reason", transportCode: code });
    expect(await remote.issueWorldToolContext({ canvasId: "c" } as never)).toEqual({ ok: false, code: expected, message: "specific reason", transportCode: code });
  });

  it("propagates cancellation for scene and camera requests", async () => {
    const controller = new AbortController(); controller.abort();
    const remote = createCanvasRemote({ canvasId: "c", fetchImpl: (async () => { throw new Error("aborted"); }) as typeof fetch });
    expect(await remote.executeSceneArea({ canvasId: "c", request: {} } as never, controller.signal)).toMatchObject({ ok: false, code: "cancelled" });
    expect(await remote.saveWorldCamera({ canvasId: "c" } as never, controller.signal)).toMatchObject({ ok: false, code: "cancelled" });
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
