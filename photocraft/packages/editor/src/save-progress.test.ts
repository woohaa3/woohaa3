/**
 * 保存进度百分比（I255）。
 *
 * 这里锁定两条边界：只有宿主上报的真实进度才会进入界面状态；保存结束后不残留百分比。
 * 不模拟上传、不估算进度。
 */
import {describe,expect,it} from "vitest";
import {EditorHandle,type EditorExportBundle,type EditorInstance} from "./editor-wasm.js";
import {EditorWorkspaceController} from "./editor-workspace.js";
import type {EditorDocumentSession} from "./session.js";

const digest = async (bytes: Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

/** 最小会话：只关心冻结/保存阶段和净变化。 */
class DevSession implements EditorDocumentSession {
  private dirty = false;
  private readonly events: string[] = [];
  isDirty() { return this.dirty; }
  beginFreeze() { this.events.push("freeze"); }
  resumeEditing() { this.events.push("resume"); }
  beginSave() { this.events.push("save"); }
  commitBaseline() { this.dirty = false; this.events.push("commit"); }
  establishBaseline() { this.dirty = false; }
  applyContentState() {}
  failSave() { this.events.push("fail"); }
  status() { return { events: [...this.events], dirty: this.dirty }; }
  markDirty() { this.dirty = true; }
}

function build(save: (request: { onProgress?: (percent: number) => void; isCurrent: () => boolean }) => Promise<unknown>) {
  let revision = 1;
  const edit = () => { revision++; };
  const stateJson = () => JSON.stringify({
    document: {
      width: 16, height: 16, revision, activeLayer: 1, canUndo: revision > 1, history: [],
      layers: [{ id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal" }]
    }
  });
  const bundle = (): EditorExportBundle => ({
    revision, documentContentHash: revision.toString(16).padStart(16, "0"),
    canvasWidth: 16, canvasHeight: 16, project: new Uint8Array([1, 2, 3]), output: new Uint8Array([4, 5, 6])
  });
  const instance = {
    openImage: stateJson, stateJson,
    commandsJson: () => JSON.stringify([{ id: "layer.delete", label: "删除图层", menu: ["Layer"], shortcut: null, params: "", enabled: true, disabledReason: null, needsDocument: true, allowed: true }]),
    allowedCommandIdsJson: () => JSON.stringify(["layer.delete"]),
    contentHash: () => revision.toString(16).padStart(16, "0"),
    assetIdsJson: () => "[]",
    execute: () => { edit(); return "null"; },
    exportBundle: bundle,
    renderPreview: () => ({ width: 1, height: 1, pixels: new Uint8Array([revision, 0, 0, 255]) }),
    renderRegion: () => { throw new Error("not stubbed"); },
    closeDocument: () => stateJson()
  } as unknown as EditorInstance;
  const session = new DevSession();
  const controller = new EditorWorkspaceController({
    session,
    load: async () => ({ ok: true, value: new EditorHandle(instance, { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: "photocraft-v1", formatVersion: 1 }) }),
    digest,
    yieldTask: async () => undefined,
    save: save as never
  });
  return { controller, session, edit };
}

/** 让排队中的微任务/计时器跑完，直到条件成立；只用于测试协调，不掩盖真实等待。 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`等待超时：${label}`);
}

describe("保存进度百分比", () => {
  it("宿主上报的真实进度显示为 saving.savePercent，结束后清除", async () => {
    let report: ((percent: number) => void) | undefined;
    let finish: ((outcome: unknown) => void) | undefined;
    const { controller, session, edit } = build(async request => {
      report = request.onProgress;
      expect(request.isCurrent()).toBe(true);
      return new Promise(resolve => { finish = resolve; });
    });
    await controller.openImage({ name: "art", assetId: "asset-1", bytes: new Uint8Array([1]) });
    session.establishBaseline();
    edit(); session.markDirty();
    controller.dispatch("layer.delete");
    const states: Array<number | undefined> = [];
    controller.subscribe(snapshot => states.push(snapshot.state.savePercent));
    const saving = controller.save();
    await until(() => !!report && !!finish, "保存端口进入");
    // 先报 20，再报 65；同一百分比不重复发布，回退值被忽略。
    report!(20); report!(20); report!(65); report!(10);
    expect(controller.snapshot().state).toMatchObject({ phase: "saving", savePercent: 65 });
    finish!({ ok: true, status: "completed" });
    await saving;
    expect(states.filter(value => value !== undefined)).toEqual([20, 65]);
    expect(states.at(-1)).toBeUndefined();
    expect(controller.snapshot().state.phase).toBe("saved");
    expect(controller.snapshot().state.savePercent).toBeUndefined();
    controller.dispose();
  });

  it("宿主不提供进度时状态保持 undefined，界面继续只显示「保存中」", async () => {
    const { controller, session, edit } = build(async () => ({ ok: true, status: "completed" }));
    await controller.openImage({ name: "art", assetId: "asset-1", bytes: new Uint8Array([1]) });
    session.establishBaseline();
    edit(); session.markDirty();
    controller.dispatch("layer.delete");
    const states: Array<number | undefined> = [];
    controller.subscribe(snapshot => states.push(snapshot.state.savePercent));
    await controller.save();
    expect(states.every(value => value === undefined)).toBe(true);
    controller.dispose();
  });

  it("保存失败后不残留百分比；失败阶段的迟到进度不写入", async () => {
    let report: ((percent: number) => void) | undefined;
    let finish: ((outcome: unknown) => void) | undefined;
    const { controller, session, edit } = build(async request => {
      report = request.onProgress;
      return new Promise(resolve => { finish = resolve; });
    });
    await controller.openImage({ name: "art", assetId: "asset-1", bytes: new Uint8Array([1]) });
    session.establishBaseline();
    edit(); session.markDirty();
    controller.dispatch("layer.delete");
    const saving = controller.save();
    await until(() => !!report && !!finish, "保存端口进入");
    report!(40);
    expect(controller.snapshot().state.savePercent).toBe(40);
    finish!({ ok: false, code: "project-upload-failed", message: "工程对象上传失败", retriable: true });
    await saving;
    expect(controller.snapshot().state.phase).toBe("failed");
    expect(controller.snapshot().state.savePercent).toBeUndefined();
    controller.dispose();
  });
});
