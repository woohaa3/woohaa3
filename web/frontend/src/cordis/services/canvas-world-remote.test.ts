import { describe, expect, it, vi } from "vitest";
import { createCanvasRemote } from "./canvas-remote.js";

const bounds = { min: { u: 0, v: 0 }, max: { u: 4, v: 4 } };
const area = { areaId: "a", scopeVersion: "v1", bounds };
const members = { instances: [], cameras: [] };
const request = { contractVersion: "scene-area-plan-v1", canvasId: "c", operationId: "op", intent: "delete-area", area, members };
const plan = { contractVersion: "scene-area-plan-v1", canvasId: "c", operationId: "op", intent: "delete-area", source: { area, members }, commands: [{ kind: "delete-scene-area", areaId: "a", expectedScopeVersion: "v1" }], inverse: [{ kind: "restore-scene-area", areaId: "a", scopeVersion: "v1", bounds }] };
const receipt = { version: "world-authoring-receipt-v1", canvasId: "c", operationId: "op", intent: "delete-area", direction: "forward", intentHash: "hash", previousCommandId: null, plan, source: { area: { nodeId: "n", node: {}, nodeData: {} }, members: [] }, deletedNodes: [], produced: { areaScopeVersion: null, targets: [] }, revision: 2, createdAt: "2026-01-01T00:00:00Z" };
const command = { ok: true, canvasId: "c", operationId: "op", commandId: "cmd", revision: 2, duplicate: false, plan, receipt };
const camera = { kind: "world-camera", version: "shared-world-v1", cameraId: "cam", settingsVersion: "v2", position: { u: 0, v: 0, h: 1 }, rotation: [0, 0, 0, 1], projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 }, captureMode: { kind: "static" }, aspect: { width: 16, height: 9 }, boundInstanceId: null };
const cameraResult = { ok: true, canvasId: "c", cameraId: "cam", commandId: "cmd", revision: 2, duplicate: false, camera, settingsVersion: "v2" };
const history = { completionKey: "key", canvasId: "c", cameraId: "cam", runId: "run", completionId: "done", settingsVersion: "v2", createdAt: "2026-01-01T00:00:00Z", snapshot: { version: "world-camera-history-v1", completion: { canvasId: "c", runId: "run", completionId: "done", cameraId: "cam", settingsVersion: "v2" }, camera } };
const scope = { kind: "scene-area", areaId: "a", scopeVersion: "v1" };
const cases: Array<{ route: string; body?: unknown; success: unknown; invoke: (remote: ReturnType<typeof createCanvasRemote>, signal?: AbortSignal) => Promise<unknown> }> = [
  { route: "scene-area-prepare", body: { areaId: "a" }, success: { ok: true, snapshot: { version: "world-authoring-v1", canvasId: "c", revision: 1, scope, areaNodeId: "n", area, bounds, writable: [], readOnly: [], members, objects: [] } }, invoke: (r, s) => r.prepareSceneArea({ canvasId: "c", areaId: "a" }, s) },
  { route: "scene-area-commit", body: { request }, success: command, invoke: (r, s) => r.executeSceneArea({ canvasId: "c", request } as never, s) },
  ...(["undo", "redo"] as const).map(direction => ({ route: `scene-area-${direction}`, body: { operationId: "op" }, success: { ...command, direction, receipt: { ...receipt, direction } }, invoke: (r: ReturnType<typeof createCanvasRemote>, s?: AbortSignal) => r.historySceneArea(direction, { canvasId: "c", operationId: "op" }, s) })),
  { route: "world-tool-context", body: { requestId: "req", runId: "run", epoch: 1, executionId: "exec", scope: { kind: "scene-area", areaId: "a" } }, success: { ok: true, context: { contextId: "ctx", canvasId: "c", runId: "run", epoch: 1, scope, writableTargets: [], readOnlyReferences: [] }, run: { canvasId: "c", requestId: "req", runId: "run", epoch: 1, executionId: "exec", state: "active" }, retry: false }, invoke: (r, s) => r.issueWorldToolContext({ canvasId: "c", requestId: "req", runId: "run", epoch: 1, executionId: "exec", scope: { kind: "scene-area", areaId: "a" } }, s) },
  { route: "world-tool-context-revoke", body: { contextId: "ctx" }, success: { ok: true }, invoke: (r, s) => r.revokeWorldToolContext({ canvasId: "c", contextId: "ctx" }, s) },
  { route: "world-camera-save", body: { cameraId: "cam", expectedSettingsVersion: "v1", settings: { position: camera.position, rotation: camera.rotation, projection: camera.projection, captureMode: camera.captureMode, aspect: camera.aspect, boundInstanceId: null } }, success: cameraResult, invoke: (r, s) => r.saveWorldCamera({ canvasId: "c", cameraId: "cam", expectedSettingsVersion: "v1", settings: { position: camera.position, rotation: camera.rotation, projection: camera.projection, captureMode: camera.captureMode, aspect: camera.aspect, boundInstanceId: null } } as never, s) },
  { route: "world-camera-history?cameraId=cam&limit=5", success: { ok: true, canvasId: "c", cameraId: "cam", entries: [history] }, invoke: (r, s) => r.listWorldCameraHistory({ canvasId: "c", cameraId: "cam", limit: 5 }, s) },
  { route: "world-camera-restore", body: { cameraId: "cam", completionKey: "key", expectedSettingsVersion: "v1" }, success: { ...cameraResult, history }, invoke: (r, s) => r.restoreWorldCamera({ canvasId: "c", cameraId: "cam", completionKey: "key", expectedSettingsVersion: "v1" }, s) }
];

describe("world authoring remote", () => {
  it.each(cases)("round trips and handles failures for $route", async ({ route, body, success, invoke }) => {
    let payload: unknown = success;
    let status = 200;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(payload), { status }));
    const remote = createCanvasRemote({ canvasId: "c", fetchImpl: fetchImpl as typeof fetch });
    expect(await invoke(remote)).toEqual(success);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain(`/c/${route}`);
    expect(init?.method).toBe(body === undefined ? "GET" : "POST");
    if (body !== undefined) expect(JSON.parse(init!.body as string)).toEqual(body);
    status = 403; payload = { code: "FORBIDDEN", message: "denied" };
    expect(await invoke(remote)).toEqual({ ok: false, code: "write-forbidden", message: "denied", transportCode: "FORBIDDEN" });
    status = 409; payload = { ok: false, code: "version-conflict", message: "stale" };
    expect(await invoke(remote)).toEqual(payload);
    status = 200; payload = route === "world-tool-context-revoke" ? { ok: "true" } : { ok: true };
    expect(await invoke(remote)).toMatchObject({ ok: false, code: "not-ready" });
    const controller = new AbortController(); controller.abort();
    const aborted = createCanvasRemote({ canvasId: "c", fetchImpl: (async (_url, init) => { expect(init?.signal).toBe(controller.signal); throw new Error("aborted"); }) as typeof fetch });
    expect(await invoke(aborted, controller.signal)).toMatchObject({ ok: false, code: "cancelled" });
  });
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
