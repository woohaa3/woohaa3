/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createBackendSettingsStore } from "../settings/backend-settings-store.js";
import type { FrontendRuntime } from "../../kernel.js";
import type { AgentConnectionView, SettingsSnapshot, SettingsEntryView } from "@woohaa3/contracts";
import { api, cleanupHarness, declaredSite, render } from "./plugin-harness.js";

let root: Root | undefined; let runtime: FrontendRuntime | undefined;
afterEach(async () => { await cleanupHarness(); act(() => root?.unmount()); await runtime?.dispose(); document.body.innerHTML = ""; });

it("临时图床展示优先级图标与最近真实失败", async () => {
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: {
    settings: [], plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { temporaryHosting: {
      mode: "auto" as const, selectionSource: "auto" as const, selectedId: "runninghub-temporary",
      candidates: [
        { exposerId: "runninghub-temporary", label: "RunningHub 临时图床", category: "provider" as const, ownerExtensionId: "runninghub-provider", priority: 10, configured: true, available: true, selected: true, lastError: "401 unauthorized" },
        { exposerId: "cos", label: "COS / S3 对象存储", category: "provider" as const, ownerExtensionId: "cos-storage", priority: 100, configured: true, available: true, selected: false, lastError: null }
      ],
      error: null, lastFailure: { exposerId: "runninghub-temporary", message: "401 unauthorized" }
    } }
  } }));
  const write = vi.fn(async () => ({ ok: false as const, code: "unavailable", error: "test" }));
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot, write }));
  await act(async () => { await Promise.resolve(); });
  expect(write).not.toHaveBeenCalled();
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).toContain("已配置 2 个提供商");
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).not.toMatch(/自动 ·|指定 ·/);
  await f.click("临时图床");
  const detail = f.el.querySelector('[data-capability-detail="hosting"]')!;
  expect(detail.textContent).toContain("RunningHub 临时图床");
  expect(detail.textContent).not.toContain("当前选择");
  expect(detail.querySelectorAll('[data-hosting-priority="first"]')).toHaveLength(1);
  expect(detail.querySelector('[data-hosting-priority="first"]')?.closest("li")?.textContent).toContain("RunningHub");
  expect(detail.textContent).toContain("最近失败：401 unauthorized");
  expect(detail.textContent).toContain("COS / S3 对象存储");
  expect(detail.querySelectorAll("ul")).toHaveLength(1);
  expect(detail.querySelectorAll("ul li")).toHaveLength(2);
  expect(detail.textContent).not.toContain("内置服务");
  expect(detail.textContent).toContain("配置");
  expect(detail.textContent).not.toContain("暂未接入");
});

it("临时图床未配置来源不进入能力列表，仍可从配置抽屉进入配置", async () => {
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: {
    settings: [], plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { temporaryHosting: {
      mode: "auto" as const, selectionSource: "auto" as const, selectedId: null,
      candidates: [
        { exposerId: "runninghub-temporary", label: "RunningHub 临时图床", category: "provider" as const, ownerExtensionId: "runninghub-provider", priority: 10, configured: false, available: false, selected: false, lastError: null },
        { exposerId: "cos", label: "COS / S3 对象存储", category: "provider" as const, ownerExtensionId: "cos-storage", priority: 100, configured: false, available: false, selected: false, lastError: null }
      ],
      error: "没有可用的临时图床，请检查提供商配置",
      lastFailure: null
    } }
  } }));
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot, write: async () => ({ ok: false as const, code: "unavailable", error: "test" }) }));
  await act(async () => { await Promise.resolve(); });
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).toContain("已配置 0 个提供商");
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).not.toContain("读取失败");
  await f.click("临时图床");
  const detail = f.el.querySelector('[data-capability-detail="hosting"]')!;
  expect(detail.textContent).toContain("没有可用的临时图床");
  expect(detail.querySelectorAll("ul li")).toHaveLength(0);
  expect(detail.textContent).not.toContain("RunningHub 临时图床");
  expect(detail.textContent).not.toContain("COS / S3 对象存储");
  expect(detail.textContent).toContain("尚未配置临时图床来源");
  await f.click("配置");
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("RunningHub 临时图床");
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("COS / S3 对象存储");
});

function hostingSnapshot(configured = false, primary = "auto", lockedBy: string | null = null): SettingsSnapshot {
  const setting = (key: string, extra: Partial<SettingsEntryView>): SettingsEntryView => ({
    key, kind: "string", label: "来源", description: "", reload: "hot", secret: false,
    source: "file", lockedBy: null, value: null, configured: true, pendingRestart: false, ...extra,
  });
  return {
    settings: [
      setting("exposer.primary", { value: primary, lockedBy }),
      setting("providers.test.apiKey", { label: "API Key", secret: true, configured, ownerExtensionId: "test-provider" }),
    ], plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { exposer: [{ id: "test-hosting", label: "测试图床", ownerExtensionId: "test-provider" }], temporaryHosting: {
      mode: primary === "auto" ? "auto" : "manual", selectionSource: primary === "auto" ? "auto" : "manual",
      selectedId: configured || primary !== "auto" ? "test-hosting" : null,
      candidates: [{ exposerId: "test-hosting", label: "测试图床", category: "provider", ownerExtensionId: "test-provider", priority: 10, configured, available: configured, selected: configured || primary !== "auto", lastError: null }],
      error: configured ? null : "没有可用的临时图床", lastFailure: null,
    } },
  };
}

it("临时图床列表只展示已配置来源，就绪说明留在配置入口", async () => {
  const fetchSnapshot = vi.fn(async () => ({ ok: true as const, snapshot: {
    settings: [], plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { temporaryHosting: {
      mode: "auto" as const, selectionSource: "auto" as const, selectedId: null,
      candidates: [
        { exposerId: "sdpppx-temporary", label: "SDPPPX 临时图床", category: "provider" as const, ownerExtensionId: "sdpppx-provider", priority: 10, configured: false, available: false, selected: false, statusNote: "未登录 SDPPPX", lastError: null },
        { exposerId: "cos", label: "COS / S3 对象存储", category: "provider" as const, ownerExtensionId: "cos-storage", priority: 100, configured: true, available: false, selected: false, statusNote: null, lastError: null }
      ],
      error: "没有可用的临时图床，请检查提供商配置",
      lastFailure: null
    } }
  } }));
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot, write: async () => ({ ok: false as const, code: "unavailable", error: "test" }) }));
  await act(async () => { await Promise.resolve(); });
  await f.click("临时图床");
  const detail = f.el.querySelector('[data-capability-detail="hosting"]')!;
  expect(detail.textContent).not.toContain("SDPPPX");
  expect(detail.querySelectorAll("ul li")).toHaveLength(1);
  expect(detail.textContent).toContain("COS / S3 对象存储");
  expect(detail.textContent).toContain("当前请求不可用");
  await f.click("配置");
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("未登录 SDPPPX");
});

it("模型目录读取失败不影响图床数量与配置，保存失败保留密钥，成功后返回详情刷新状态", async () => {
  const snapshot = () => hostingSnapshot(configured);
  let configured = false;
  const write = vi.fn(async (_values: unknown) => { configured = true; return { ok: true as const, snapshot: snapshot() }; })
    .mockResolvedValueOnce({ ok: false, code: "unavailable", error: "保存失败，请重试" } as never);
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot: snapshot() }), write }), {}, {
    listServiceConnections: async () => ({ ok: false, code: "unavailable", error: "目录读取失败" }),
  });
  expect(f.el.querySelector('[data-capability="image"]')?.textContent).toContain("读取失败");
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).toContain("已配置 0 个提供商");
  expect(f.el.querySelector('[data-capability="hosting"]')?.textContent).not.toContain("读取失败");
  await f.click("临时图床");
  await f.click("配置");
  const rowConfig = f.el.querySelector<HTMLButtonElement>('.agent-assistant__drawer li button')!;
  await act(async () => rowConfig.click());
  expect(f.el.querySelector('[data-page="overview"]')?.getAttribute("data-state")).toBe("active");
  const field = f.el.querySelector<HTMLInputElement>('.agent-assistant__drawer [data-setting-key="providers.test.apiKey"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "test-key");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await f.click("保存");
  expect(field.value).toBe("test-key");
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("保存失败，请重试");
  await f.click("保存");
  expect(write).toHaveBeenLastCalledWith({ "providers.test.apiKey": "test-key" });
  expect(f.el.querySelector(".agent-assistant__drawer")).toBeNull();
  expect(f.el.querySelector('[data-capability-detail="hosting"]')?.textContent).toContain("已配置 1 个提供商");
  expect(f.el.querySelector('[data-capability-detail="hosting"]')?.textContent).not.toContain("当前选择");
  expect(f.el.querySelector('[data-hosting-priority="first"]')?.closest("li")?.textContent).toContain("测试图床");
});

function sortableHostingSnapshot() {
  const snapshot = hostingSnapshot(true, "test-hosting");
  snapshot.settings.push({ ...snapshot.settings[0]!, key: "exposer.order", value: "", lockedBy: null });
  const route = snapshot.extensionPoints!.temporaryHosting!;
  snapshot.extensionPoints!.temporaryHosting = { ...route, candidates: [
    ...route.candidates,
    { ...route.candidates[0]!, exposerId: "cos", label: "COS / S3 对象存储", ownerExtensionId: "cos-storage", selected: false },
    { ...route.candidates[0]!, exposerId: "sdpppx-temporary", label: "SDPPPX", ownerExtensionId: "sdpppx-provider", configured: false, available: false, selected: false }
  ] };
  return snapshot;
}

function hostingPointer(target: EventTarget, type: string, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

function mockHostingRects(el: HTMLElement) {
  el.querySelectorAll<HTMLElement>("[data-hosting-id]").forEach(row => {
    vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
      const index = [...row.parentElement!.children].indexOf(row);
      const offset = Number(row.style.transform.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0);
      return { top: index * 80 + offset, height: 80 } as DOMRect;
    });
  });
}

it("临时图床在列表拖动排序，保存失败保留顺序并可重试，成功后刷新保持排序", async () => {
  const snapshot = sortableHostingSnapshot();
  const write = vi.fn(async () => {
    const route = snapshot.extensionPoints!.temporaryHosting!;
    snapshot.extensionPoints!.temporaryHosting = {
      ...route, mode: "auto", selectionSource: "auto", selectedId: "cos",
      candidates: [route.candidates[1]!, route.candidates[0]!, route.candidates[2]!]
    };
    snapshot.settings.find(entry => entry.key === "exposer.order")!.value = "cos,test-hosting,sdpppx-temporary";
    return { ok: true as const, snapshot: { ...snapshot } };
  }).mockResolvedValueOnce({ ok: false, code: "unavailable", error: "暂时无法保存" } as never);
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }));
  await f.click("临时图床");
  expect(f.el.querySelector('[aria-label="临时图床来源"]')).toBeNull();
  const ids = () => [...f.el.querySelectorAll<HTMLElement>("[data-hosting-id]")].map(row => row.dataset.hostingId);
  mockHostingRects(f.el);
  const handle = f.el.querySelector<HTMLButtonElement>('[data-hosting-id="cos"] .agent-assistant__hosting-drag')!;
  const dragged = handle.closest("li")!;
  const neighbour = f.el.querySelector<HTMLElement>('[data-hosting-id="test-hosting"]')!;
  const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
  neighbour.animate = animate as unknown as HTMLElement["animate"];
  dragged.animate = animate as unknown as HTMLElement["animate"];
  await act(async () => hostingPointer(handle, "pointerdown", 120));
  await act(async () => hostingPointer(document, "pointermove", 118));
  expect(dragged.style.transform).toBe("translateY(-2px)");
  expect(ids()).toEqual(["test-hosting", "cos"]);
  await act(async () => hostingPointer(document, "pointermove", 100));
  expect(dragged.style.transform).toBe("translateY(-20px)");
  expect(ids()).toEqual(["test-hosting", "cos"]);
  await act(async () => hostingPointer(document, "pointermove", 10));
  expect(ids()).toEqual(["cos", "test-hosting"]);
  expect(dragged.getBoundingClientRect().top).toBe(-30);
  expect(animate).toHaveBeenCalledWith([{ transform: "translateY(-80px)" }, { transform: "translateY(0px)" }], expect.objectContaining({ duration: 180 }));
  expect(f.el.querySelector('[data-hosting-priority="first"]')?.closest("li")?.getAttribute("data-hosting-id")).toBe("cos");
  expect(f.el.querySelector('[data-capability-detail="hosting"]')?.textContent).not.toContain("当前选择");
  expect(write).not.toHaveBeenCalled();
  await act(async () => hostingPointer(document, "pointerup", 10));
  expect(dragged.style.transform).toBe("");
  expect(animate).toHaveBeenCalledWith([{ transform: "translateY(-30px)" }, { transform: "translateY(0px)" }], expect.objectContaining({ duration: 180 }));
  expect(f.el.textContent).toContain("暂时无法保存");
  expect(ids()).toEqual(["cos", "test-hosting"]);
  await f.click("重试");
  expect(write).toHaveBeenLastCalledWith({ "exposer.order": "cos,test-hosting,sdpppx-temporary", "exposer.primary": "auto" });
  expect(ids()).toEqual(["cos", "test-hosting"]);
  expect(f.el.textContent).not.toContain("暂时无法保存");
  await f.click("刷新状态");
  expect(ids()).toEqual(["cos", "test-hosting"]);
});

it("取消拖动或拖回原位置不保存，配置抽屉只提供来源配置", async () => {
  const snapshot = sortableHostingSnapshot();
  const write = vi.fn();
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }));
  await f.click("临时图床");
  mockHostingRects(f.el);
  const handle = f.el.querySelector<HTMLButtonElement>('[data-hosting-id="cos"] .agent-assistant__hosting-drag')!;
  await act(async () => hostingPointer(handle, "pointerdown", 120));
  await act(async () => hostingPointer(document, "pointermove", 10));
  await act(async () => hostingPointer(document, "pointercancel", 10));
  expect(f.el.querySelector<HTMLElement>("[data-hosting-id]")!.dataset.hostingId).toBe("test-hosting");
  expect(handle.closest("li")!.style.transform).toBe("");
  await act(async () => hostingPointer(handle, "pointerdown", 120));
  await act(async () => hostingPointer(document, "pointermove", 10));
  await act(async () => hostingPointer(document, "pointerup", 120));
  expect(write).not.toHaveBeenCalled();
  await f.click("配置");
  expect(f.el.querySelector('.agent-assistant__drawer [role="combobox"]')).toBeNull();
  expect(f.el.querySelector('.agent-assistant__drawer')?.textContent).toContain("SDPPPX");
});

it("临时图床来源有专用贡献时，配置抽屉渲染扩展自己的就绪面板", async () => {
  const snapshot = hostingSnapshot(false);
  snapshot.extensionPoints!.temporaryHosting = {
    ...snapshot.extensionPoints!.temporaryHosting!,
    candidates: [{ exposerId: "sdpppx-temporary", label: "SDPPPX 临时图床", category: "provider", ownerExtensionId: "sdpppx-provider", priority: 10, configured: false, available: false, selected: false, statusNote: "未登录 SDPPPX", lastError: null }],
    selectedId: null,
    error: "没有可用的临时图床"
  };
  const write = vi.fn();
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }), {}, {}, undefined, false, true);
  await f.click("临时图床");
  await f.click("配置");
  const rowConfig = f.el.querySelector<HTMLButtonElement>('.agent-assistant__drawer li button')!;
  await act(async () => rowConfig.click());
  const drawer = f.el.querySelector(".agent-assistant__drawer")!;
  expect(drawer.textContent).toContain("来源自己的登录面板");
  expect(drawer.textContent).not.toContain("当前来源没有可编辑的配置");
  expect(write).not.toHaveBeenCalled();
});

it("没有专用贡献时，来源不可编辑就如实说明，不伪造登录或上传", async () => {
  const snapshot = hostingSnapshot(false);
  snapshot.extensionPoints!.temporaryHosting = {
    ...snapshot.extensionPoints!.temporaryHosting!,
    candidates: [{ exposerId: "sdpppx-temporary", label: "SDPPPX 临时图床", category: "provider", ownerExtensionId: "sdpppx-provider", priority: 10, configured: false, available: false, selected: false, statusNote: "未登录 SDPPPX", lastError: null }],
    selectedId: null,
    error: "没有可用的临时图床"
  };
  const write = vi.fn();
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }));
  await f.click("临时图床");
  await f.click("配置");
  const rowConfig = f.el.querySelector<HTMLButtonElement>('.agent-assistant__drawer li button')!;
  await act(async () => rowConfig.click());
  expect(f.el.querySelector(".agent-assistant__drawer")?.textContent).toContain("当前来源没有可编辑的配置");
  expect(write).not.toHaveBeenCalled();
});

it("环境锁定的图床来源禁止排序，配置抽屉不再展示自动或手动下拉框", async () => {
  const snapshot = sortableHostingSnapshot();
  snapshot.settings[0]!.lockedBy = "WOOHAA_EXPOSER";
  const write = vi.fn();
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot }), write }));
  await f.click("临时图床");
  expect([...f.el.querySelectorAll<HTMLButtonElement>(".agent-assistant__hosting-drag")].every(button => button.disabled)).toBe(true);
  expect(f.el.textContent).toContain("WOOHAA_EXPOSER");
  await f.click("配置");
  expect(f.el.querySelector('.agent-assistant__drawer [aria-label="临时图床来源"]')).toBeNull();
  expect(write).not.toHaveBeenCalled();
});

it("Agent 详情无目标仅配置，来源不可用禁用使用", async () => {
  const source = declaredSite({ serviceConnectionId: "svc", name: "文字提供商", scope: "personal", managedByAdministrator: false });
  const connection = { ...api, connectionId: "auto-c1", name: "文字提供商", serviceConnectionId: "svc", ready: true } as AgentConnectionView;
  const noTarget = await render([connection], true, undefined, { canvasId: "canvas" }, {
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [source], duplicates: [], providers: [] } }),
  });
  await noTarget.click("Agent");
  const noTargetButtons = [...noTarget.el.querySelectorAll('[data-capability-detail="agent"] button')].map(button => button.textContent);
  expect(noTargetButtons).toContain("配置");
  expect(noTargetButtons).not.toContain("使用");
  await act(async () => { root?.unmount(); }); root = undefined; await runtime?.dispose(); runtime = undefined; document.body.innerHTML = "";
  const unavailable = await render([{ ...connection, ready: false, credentialConfigured: false }], true, undefined, { canvasId: "canvas", nodeId: "node" }, {
    serviceConnectionDirectory: async () => ({ ok: true, value: { connections: [{ ...source, credentialConfigured: false }], duplicates: [], providers: [] } }),
  });
  await unavailable.click("Agent");
  const disabled = [...unavailable.el.querySelectorAll<HTMLButtonElement>('[data-capability-detail="agent"] button')].find(button => button.textContent === "使用");
  expect(disabled?.disabled).toBe(true);
  expect(unavailable.el.querySelector('[data-capability-detail="agent"]')?.textContent).toContain("待配置密钥");
});




it("COS 图床复用存储配置，保存后进入已配置列表且可再次编辑", async () => {
  let configured = false;
  const snapshot = (): SettingsSnapshot => ({
    settings: [{
      key: "storage.cos.secretId", kind: "string", label: "SecretId", description: "", reload: "hot", secret: true,
      source: "file", lockedBy: null, value: null, configured, pendingRestart: false, ownerExtensionId: "cos-storage"
    }],
    plugins: [], files: { config: "c", secrets: "s" },
    extensionPoints: { temporaryHosting: {
      mode: "auto", selectionSource: "auto", selectedId: configured ? "cos" : null,
      candidates: [{ exposerId: "cos", label: "COS / S3 对象存储", category: "provider", ownerExtensionId: "cos-storage", priority: 100,
        configured, available: configured, selected: configured, lastError: null }], error: null, lastFailure: null
    } }
  });
  const write = vi.fn(async () => { configured = true; return { ok: true as const, snapshot: snapshot() }; });
  const f = await render([], false, createBackendSettingsStore({ fetchSnapshot: async () => ({ ok: true, snapshot: snapshot() }), write }));
  await f.click("临时图床");
  expect(f.el.querySelectorAll('[data-capability-detail="hosting"] li')).toHaveLength(0);
  await f.click("配置");
  await act(async () => f.el.querySelector<HTMLButtonElement>('.agent-assistant__drawer li button')!.click());
  const field = f.el.querySelector<HTMLInputElement>('[data-setting-key="storage.cos.secretId"] input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "cos-id");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await f.click("保存");
  expect(write).toHaveBeenLastCalledWith({ "storage.cos.secretId": "cos-id" });
  const detail = f.el.querySelector('[data-capability-detail="hosting"]')!;
  expect(detail.textContent).toContain("已配置 1 个提供商");
  expect(detail.querySelectorAll("li")).toHaveLength(1);
  expect(detail.textContent).toContain("COS / S3 对象存储");
  await act(async () => detail.querySelector<HTMLButtonElement>("li .agent-assistant__actions button")!.click());
  expect(f.el.querySelector('[data-setting-key="storage.cos.secretId"]')).not.toBeNull();
});
