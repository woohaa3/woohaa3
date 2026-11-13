import { describe, expect, it, vi } from "vitest";
import { adoptCameraTimeline } from "./plugin.js";
import {
  awaitWorldCameraCanonical,
  loadWorldCameraHistory,
  submitWorldCameraRestore,
  submitWorldCameraSave
} from "../../services/world-camera-ui.js";
import {
  createDefaultWorldCameraData
} from "../../../../../contracts/src/canvas/world-camera-ui.js";
import type {
  ServerCanvas,
  WorldCameraHistoryEntry
} from "@woohaa3/contracts";

const camera = createDefaultWorldCameraData("camera-1", "settings-1", { u: 0, v: 0 });
const settings = {
  position: camera.position,
  rotation: camera.rotation,
  projection: camera.projection,
  captureMode: camera.captureMode,
  aspect: camera.aspect,
  boundInstanceId: camera.boundInstanceId
};
const saveInput = {
  canvasId: "canvas-1",
  cameraId: "camera-1",
  expectedSettingsVersion: "settings-1",
  settings,
  operationId: "operation-1"
};
const completion = {
  canvasId: "canvas-1",
  runId: "run-1",
  completionId: "completion-1",
  cameraId: "camera-1",
  settingsVersion: "settings-1"
};
const historyEntry: WorldCameraHistoryEntry = {
  completionKey: JSON.stringify(["canvas-1", "run-1", "completion-1", "camera-1"]),
  canvasId: "canvas-1",
  cameraId: "camera-1",
  runId: "run-1",
  completionId: "completion-1",
  settingsVersion: "settings-1",
  createdAt: "2026-11-03T00:00:00.000Z",
  snapshot: { version: "world-camera-history-v1", completion, camera }
};

describe("world camera UI transport service", () => {
  it("accepts a matching save receipt and rejects a mismatched camera", async () => {
    const success = await submitWorldCameraSave({
      saveWorldCamera: async () => ({
        ok: true,
        canvasId: "canvas-1",
        cameraId: "camera-1",
        commandId: "command-1",
        revision: 4,
        duplicate: false,
        camera,
        settingsVersion: "settings-1"
      })
    }, saveInput);
    expect(success).toMatchObject({ ok: true, settingsVersion: "settings-1", revision: 4 });

    const mismatch = await submitWorldCameraSave({
      saveWorldCamera: async () => ({
        ok: true,
        canvasId: "canvas-1",
        cameraId: "other-camera",
        commandId: "command-1",
        revision: 4,
        duplicate: false,
        camera,
        settingsVersion: "settings-1"
      })
    }, saveInput);
    expect(mismatch).toMatchObject({ ok: false, code: "invalid-data" });
  });

  it("rejects history entries that belong to another camera", async () => {
    const ok = await loadWorldCameraHistory({
      listWorldCameraHistory: async () => ({
        ok: true,
        canvasId: "canvas-1",
        cameraId: "camera-1",
        entries: [historyEntry]
      })
    }, { canvasId: "canvas-1", cameraId: "camera-1" });
    expect(ok.ok).toBe(true);

    const reject = await loadWorldCameraHistory({
      listWorldCameraHistory: async () => ({
        ok: true,
        canvasId: "canvas-1",
        cameraId: "camera-1",
        entries: [{ ...historyEntry, cameraId: "other-camera" }]
      })
    }, { canvasId: "canvas-1", cameraId: "camera-1" });
    expect(reject).toMatchObject({ ok: false, code: "invalid-data" });
  });

  it("validates restore receipts against the requested completion", async () => {
    const result = await submitWorldCameraRestore({
      restoreWorldCamera: async () => ({
        ok: true,
        canvasId: "canvas-1",
        cameraId: "camera-1",
        commandId: "restore-command",
        revision: 7,
        duplicate: false,
        camera,
        settingsVersion: "settings-1",
        history: historyEntry
      })
    }, {
      canvasId: "canvas-1",
      cameraId: "camera-1",
      completionKey: historyEntry.completionKey,
      expectedSettingsVersion: "settings-1"
    });
    expect(result).toMatchObject({ ok: true, history: historyEntry });
  });

  it("adopts a verified camera save into the shared journal and fails closed on replay", async () => {
    const before = createDefaultWorldCameraData("camera-1", "settings-1", { u: 0, v: 0 });
    const after = createDefaultWorldCameraData("camera-1", "settings-2", { u: 0, v: 0 });
    const entries: Array<{
      id: string;
      undo: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      redo: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    }> = [];
    const edit = {
      recordExternal: (input: (typeof entries)[number]) => {
        entries.push(input);
        return { ok: true as const, entry: {} as never };
      }
    };
    const saveWorldCamera = vi.fn(async (input: { expectedSettingsVersion: string }) => ({
      ok: true as const,
      canvasId: "canvas-1",
      cameraId: "camera-1",
      commandId: "camera-command",
      revision: 3,
      duplicate: false,
      camera: { ...after, settingsVersion: input.expectedSettingsVersion === "settings-2" ? "settings-3" : "settings-4" },
      settingsVersion: input.expectedSettingsVersion === "settings-2" ? "settings-3" : "settings-4"
    }));
    const version = { current: "settings-2" };
    expect(adoptCameraTimeline({
      ctx: { canvasRemote: { saveWorldCamera }, canvasEdit: edit } as never,
      canvasId: "canvas-1",
      cameraId: "camera-1",
      before,
      after,
      label: "调整镜头设置",
      operationId: "camera-op",
      version
    }).ok).toBe(true);
    expect(entries[0]!.id).toBe("world-camera:camera-op");
    expect(await entries[0]!.undo()).toEqual({ ok: true, revision: 3 });
    expect(saveWorldCamera).toHaveBeenLastCalledWith(expect.objectContaining({ expectedSettingsVersion: "settings-2" }), undefined);
    expect(version.current).toBe("settings-3");
    expect(await entries[0]!.redo()).toEqual({ ok: true, revision: 3 });
    expect(saveWorldCamera).toHaveBeenLastCalledWith(expect.objectContaining({ expectedSettingsVersion: "settings-3" }), undefined);
    expect(version.current).toBe("settings-4");

    const failed = { current: "settings-4" };
    const failing = vi.fn(async () => ({ ok: false as const, code: "version-conflict", message: "镜头版本已变化" }));
    adoptCameraTimeline({
      ctx: { canvasRemote: { saveWorldCamera: failing }, canvasEdit: edit } as never,
      canvasId: "canvas-1",
      cameraId: "camera-1",
      before,
      after,
      label: "调整镜头设置",
      operationId: "camera-op-2",
      version: failed
    });
    expect(await entries[1]!.undo()).toEqual({ ok: false, reason: "镜头版本已变化" });
    expect(failed.current).toBe("settings-4");
  });

  it("waits for the canonical projection to adopt the saved settings version", async () => {
    let reads = 0;
    const canonical = await awaitWorldCameraCanonical({
      readCanvas: () => {
        reads += 1;
        return reads < 3 ? null : {
          id: "canvas-1",
          revision: 9,
          document: { nodes: [{ id: "node-1", type: "world-camera" }] },
          nodeData: { "node-1": { worldCamera: { ...camera, settingsVersion: "settings-2" } } }
        } as unknown as ServerCanvas;
      },
      canvasId: "canvas-1",
      nodeId: "node-1",
      cameraId: "camera-1",
      settingsVersion: "settings-2",
      revision: 9,
      attempts: 4,
      wait: async () => undefined
    });
    expect(canonical).toBe(true);
  });
});
