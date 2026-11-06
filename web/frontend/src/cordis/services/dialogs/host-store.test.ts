/**
 * Dialog Host store 与 registry（change: add-frontend-dialog-system，任务 1.1 / 3.1）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DialogHostStore } from "./host-store.js";
import { DialogRegistry, objectPayload } from "./registry.js";
import { alertDefinition } from "./alert-dialog.js";
import { isAllowedMediaUrl, mediaPreviewDefinition, resolveImagePreview } from "../../plugins/media-preview/media-preview.js";
import type { DialogDefinition } from "./types.js";

const accept = () => ({ ok: true as const, payload: {} });

function definition(overrides: Partial<DialogDefinition> = {}): DialogDefinition {
  return { validatePayload: accept, ...overrides };
}

describe("DialogHostStore", () => {
  let store: DialogHostStore;
  let registry: DialogRegistry;

  beforeEach(() => {
    // 用独立 registry 注册内置 dialog（不触碰页面级单例）。
    registry = new DialogRegistry();
    registry.register("alert", alertDefinition);
    registry.register("media-preview", mediaPreviewDefinition);
    store = new DialogHostStore(registry);
  });

  it("拒绝未知 dialogId，stack 不变", () => {
    const before = store.getSnapshot();
    const result = store.open({ dialogId: "missing" });
    expect(result.ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(store.getDiagnostic()).toContain("未注册");
  });

  it("open/closeTop/activeDialogId 协同工作", () => {
    const opened = store.open({ dialogId: "alert", payload: { title: "t", description: "d" } });
    expect(opened.ok).toBe(true);
    expect(store.getSnapshot().activeDialogId).toBe("alert");
    expect(store.getSnapshot().isModalActive).toBe(true);
    expect(store.closeTop()).toBe(true);
    expect(store.getSnapshot().isModalActive).toBe(false);
  });

  it("media-preview singleton 替换复用 instanceId", () => {
    const first = store.open({ dialogId: "media-preview", payload: { assetId: "a", nodeId: "n", title: "" } });
    const second = store.open({ dialogId: "media-preview", payload: { assetId: "b", nodeId: "n", title: "" } });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.instance.instanceId).toBe(first.instance.instanceId);
      expect((second.instance.payload as { assetId: string }).assetId).toBe("b");
    }
    expect(store.getSnapshot().stack).toHaveLength(1);
  });

  it("payload 非法时拒绝并保留诊断", () => {
    const result = store.open({ dialogId: "alert", payload: { title: "" } });
    expect(result.ok).toBe(false);
    expect(store.getSnapshot().isModalActive).toBe(false);
    expect(store.getDiagnostic()).toBeTruthy();
  });

  it("busy 时 requestCloseTop 不关闭", () => {
    const opened = store.open({ dialogId: "media-preview", payload: { assetId: "a", nodeId: "n", title: "" } });
    expect(opened.ok).toBe(true);
    if (opened.ok) store.setBusy(opened.instance.instanceId, true);
    expect(store.requestCloseTop().closed).toBe(false);
    expect(store.getSnapshot().isModalActive).toBe(true);
  });

  it("订阅在状态变化时收到新快照", () => {
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe((snapshot) => seen.push(snapshot.isModalActive));
    store.open({ dialogId: "alert", payload: { title: "t", description: "d" } });
    store.closeTop();
    unsubscribe();
    expect(seen).toEqual([true, false]);
  });
  it("关闭 guard：dirty 时接管关闭请求、重复请求只调一次 guard，放行后才关闭", () => {
    // change: 2026-10-17-move-settings-into-canvas-dialog，任务 3.2。
    registry.register("settings", definition({ singleton: true, dismissible: true }));
    const opened = store.open({ dialogId: "settings", payload: {} });
    expect(opened.ok).toBe(true);
    let handled = true;
    const guard = vi.fn(() => (handled ? ("handled" as const) : ("allow" as const)));
    const dispose = store.registerCloseGuard("settings", guard);

    // guard 接管：不关闭。
    const first = store.requestCloseTop();
    expect(first).toMatchObject({ closed: false, handled: true });
    expect(store.getSnapshot().stack).toHaveLength(1);
    expect(guard).toHaveBeenCalledTimes(1);

    // 放行后正常关闭。
    handled = false;
    const second = store.requestClose();
    expect(second.closed).toBe(true);
    expect(store.getSnapshot().stack).toHaveLength(0);

    // 注销后不再调用 guard。
    dispose();
    expect(store.getSnapshot().stack).toHaveLength(0);
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("关闭 guard 抛错时保守拒绝关闭（保留草稿）", () => {
    registry.register("settings", definition({ singleton: true, dismissible: true }));
    store.open({ dialogId: "settings", payload: {} });
    store.registerCloseGuard("settings", () => {
      throw new Error("guard failed");
    });
    const result = store.requestCloseTop();
    expect(result.closed).toBe(false);
    expect(store.getSnapshot().stack).toHaveLength(1);
  });
});

describe("media-preview payload 与 canonical 解析", () => {
  it("只接受 ready image 的稳定同源 URL", () => {
    const canvas = {
      assets: [
        { id: "ok", mediaKind: "image", status: "ready", url: "/api/media/abc", metadata: { storageKey: "abc", checksum: "a" } },
        { id: "not-ready", mediaKind: "image", status: "generating", url: "/api/media/x", metadata: { storageKey: "x", checksum: "b" } },
        { id: "no-metadata", mediaKind: "image", status: "ready", url: "/api/media/n", metadata: {} },
        { id: "video", mediaKind: "video", status: "ready", url: "/api/media/v", metadata: { storageKey: "v", checksum: "c" } },
        { id: "external", mediaKind: "image", status: "ready", url: "https://evil.example/x.png", metadata: { storageKey: "e", checksum: "d" } },
        { id: "blob", mediaKind: "image", status: "ready", url: "blob:http://localhost/xyz", metadata: { storageKey: "b", checksum: "e" } }
      ]
    };
    expect(resolveImagePreview(canvas, "ok")).toEqual({ url: "/api/media/abc", mediaKind: "image" });
    expect(resolveImagePreview(canvas, "not-ready")).toBeNull();
    expect(resolveImagePreview(canvas, "no-metadata")).toBeNull();
    expect(resolveImagePreview(canvas, "external")).toBeNull();
    expect(resolveImagePreview(canvas, "blob")).toBeNull();
    expect(resolveImagePreview(canvas, "video")).toBeNull();
    expect(resolveImagePreview(canvas, "missing")).toBeNull();
  });

  it("isAllowedMediaUrl 只接受站内相对路径", () => {
    expect(isAllowedMediaUrl("/api/media/abc")).toBe(true);
    expect(isAllowedMediaUrl("https://x/y")).toBe(false);
    expect(isAllowedMediaUrl("//cdn/x")).toBe(false);
    expect(isAllowedMediaUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isAllowedMediaUrl("blob:http://x/1")).toBe(false);
    expect(isAllowedMediaUrl("")).toBe(false);
  });

});

describe("DialogRegistry", () => {
  it("objectPayload 拒绝非对象与缺字段", () => {
    const validate = objectPayload<{ id: string }>("demo", (value) =>
      typeof value.id === "string" ? { id: value.id } : null
    );
    expect(validate(1).ok).toBe(false);
    expect(validate({}).ok).toBe(false);
    expect(validate({ id: "x" })).toEqual({ ok: true, payload: { id: "x" } });
  });

  it("ids 稳定排序", () => {
    const registry = new DialogRegistry();
    registry.register("b", definition());
    registry.register("a", definition());
    expect(registry.ids()).toEqual(["a", "b"]);
  });

  it("validate 区分未知 ID 与非法 payload", () => {
    const registry = new DialogRegistry();
    registry.register("known", definition({ validatePayload: () => ({ ok: false, error: "nope" }) }));
    expect(registry.validate("unknown", {}).ok).toBe(false);
    const invalid = registry.validate("known", {});
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toContain("payload 非法");
  });

  it("payload 校验要求 assetId 与 nodeId", () => {
    expect(mediaPreviewDefinition.validatePayload({ assetId: "a", nodeId: "n", title: "t" }).ok).toBe(true);
    expect(mediaPreviewDefinition.validatePayload({ assetId: "a" }).ok).toBe(false);
    expect(mediaPreviewDefinition.validatePayload({ nodeId: "n" }).ok).toBe(false);
  });
});
