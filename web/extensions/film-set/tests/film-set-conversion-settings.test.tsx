/** @vitest-environment jsdom */
/**
 * 「转为片场」设置弹窗的 DOM 行为（change: 2026-10-13-add-node-to-film-set-shortcut / design D6）。
 *
 * 非渲染检查（jsdom，不依赖 GPU）：横条模式下弹窗由宿主打开、贡献不经过 `activate`，因此组件
 * 挂载时必须自行告知控制器「设置已打开」（加载候选 + 预置推荐模型）；提交前失败要**保持弹窗
 * 打开**并就地显示原因，成功才关闭——避免「点了创建片场没反应」。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { defaultFilmSetConversionPrompt } from "@woohaa3/contracts";
import { createEmptyWoohaa3ServerCanvas, type FilmSetConversionModelCandidate, type ServerCanvas } from "@woohaa3/contracts";
import { createFilmSetConversionDialog, createFilmSetConversionSettings } from "../src/frontend/film-set-conversion/settings.js";
import { DialogService } from "../../../frontend/src/cordis/services/dialogs/service.js";
import { DialogHost } from "../../../frontend/src/cordis/services/dialogs/DialogHost.js";
import { defaultFilmSetConversionEntry, type FilmSetConversionController, type FilmSetConversionEntry } from "../src/frontend/film-set-conversion/controller.js";
import type { FilmSetConversionActionDependencies } from "../src/frontend/film-set-conversion/action.js";
import { UiProvider } from "../../../frontend/src/shared/ui/UiProvider.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

const NOW = "2026-10-13T00:00:00.000Z";

/** 就绪图片来源（可用性门禁要求写权限 + ready 且类型匹配的原资产）。 */
function canvasWithImage(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1", NOW);
  return {
    ...base,
    document: { ...base.document, nodes: [{ id: "img", type: "image", position: { x: 0, y: 0 } }] },
    nodeData: { img: { outputAssetId: "asset-image" } },
    assets: [{
      id: "asset-image", title: "参考图", mediaKind: "image", source: "uploaded", status: "ready",
      createdAt: NOW, url: "/api/media/a", metadata: { storageKey: "sha256-a", checksum: "a".repeat(64), contentType: "image/png", size: 4 }
    }] as ServerCanvas["assets"]
  };
}

const model: FilmSetConversionModelCandidate = {
  assistant: { adapterId: "agent", model: "vision" },
  modelKey: "p:vision", label: "视觉模型", isDefault: true, supports: ["image", "video"],
  capabilities: { structuredCandidateOutput: true, input: { imageInput: true, maxImages: 8, videoInput: true, maxFrames: 0, maxDurationSeconds: 0 } }
};

/** 固定快照的假控制器：只记录被调用的动作，不触网。 */
function fakeController(entry: FilmSetConversionEntry, startAccepted: boolean) {
  const calls = { open: 0, close: 0, start: 0 };
  let snapshot = { entries: new Map([[entry.nodeId, entry]]) };
  const listeners = new Set<() => void>();
  const controller = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    getEntry: () => entry,
    state: { isWritable: () => true },
    openSettings: () => { calls.open += 1; },
    closeSettings: () => { calls.close += 1; },
    setDraft: vi.fn(({ draft }) => {
      entry = { ...entry, draft };
      snapshot = { entries: new Map([[entry.nodeId, entry]]) };
      for (const listener of listeners) listener();
    }),
    startFromSettings: vi.fn(async () => { calls.start += 1; return startAccepted; })
  } as unknown as FilmSetConversionController;
  return { controller, calls };
}

function deps(controller: FilmSetConversionController): FilmSetConversionActionDependencies {
  const canvas = canvasWithImage();
  return {
    canvasId: "c1",
    assistant: {
      getDataScopeId: () => "space", invalidateDirectory: () => undefined,
      listConnections: async () => ({ ok: true, value: [{ connectionId: "connection", adapterId: "agent", name: "Assistant", ready: true, configRevision: 1, credentialEpoch: 1,
        capabilities: { imageInput: true, structuredResult: true }, models: [{ id: "vision", label: "Vision", reasoningEfforts: ["low", "high"] }] }] }),
      catalog: async () => ({ ok: true, value: { models: [{ id: "vision", label: "Vision" }] } }),
    } as unknown as NonNullable<FilmSetConversionActionDependencies["assistant"]>,
    controller,
    preferences: { read: () => ({}), write: () => true },
    getCanvas: () => canvas,
    subscribeCanvas: () => () => undefined
  };
}

function render(entry: FilmSetConversionEntry, startAccepted: boolean) {
  const { controller, calls } = fakeController(entry, startAccepted);
  const onClose = vi.fn();
  const Settings = createFilmSetConversionSettings(deps(controller));
  const element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
  act(() => {
    root!.render(<Settings nodeId={entry.nodeId} nodeType={entry.nodeType} writable onClose={onClose} />);
  });
  return { calls, onClose, controller };
}

function entryWith(patch: Partial<FilmSetConversionEntry>): FilmSetConversionEntry {
  return {
    ...defaultFilmSetConversionEntry("img", "image", {}),
    models: [model], modelsLoaded: true,
    ...patch,
    draft: { ...patch.draft, ...(patch.draft?.modelKey ? { connection: { connectionId: "connection", adapterId: "agent", configRevision: 1, credentialEpoch: 1 } } : {}), instruction: patch.draft?.instruction ?? defaultFilmSetConversionPrompt("image") }
  };
}

const startButton = () => [...document.querySelectorAll("button")].find((entry) => entry.textContent?.includes("创建片场")) as HTMLButtonElement | undefined;

it("内置提示词直接填入编辑框，不作为占位文本", () => {
  render(entryWith({}), true);
  expect(document.querySelector("textarea")!.value).toBe(defaultFilmSetConversionPrompt("image"));
});

it("独立挂载创建弹窗会加载候选模型", () => {
  const { calls } = render(entryWith({ draft: { modelKey: "p:vision" } }), true);
  expect(calls.open).toBe(1);
});

it("提交前失败：保持弹窗打开并就地显示原因", async () => {
  const { calls, onClose } = render(entryWith({ draft: { modelKey: "p:vision" }, error: "尚未配置支持视觉输入的转换模型" }), false);
  expect(document.querySelector("[data-testid='film-set-conversion-settings-error']")!.textContent).toContain("尚未配置支持视觉输入的转换模型");
  await vi.waitFor(() => expect(startButton()!.disabled).toBe(false));
  await act(async () => { startButton()!.click(); });
  expect(calls.start).toBe(1);
  expect(onClose).not.toHaveBeenCalled();
});

it("已被接受（含占位片场上的任务级失败）：关闭弹窗，失败改由目标节点承载", async () => {
  const { calls, onClose } = render(entryWith({ draft: { modelKey: "p:vision" } }), true);
  await vi.waitFor(() => expect(startButton()!.disabled).toBe(false));
  await act(async () => { startButton()!.click(); });
  expect(calls.start).toBe(1);
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

it("真实 DialogHost 打开稳定，提交中不可关闭，受理后关闭", async () => {
  const { controller } = fakeController(entryWith({ draft: { modelKey: "p:vision" }, settingsOpen: true }), true);
  let finish!: (accepted: boolean) => void;
  controller.startFromSettings = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const dialogs = new DialogService();
  dialogs.registerDialog("film-set-creation", {
    definition: { dismissible: true, singleton: true, validatePayload: payload => ({ ok: true, payload }) },
    renderer: createFilmSetConversionDialog(deps(controller), dialogs)
  });
  dialogs.open({ dialogId: "film-set-creation", payload: { nodeId: "img", nodeType: "image" } });
  const element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
  act(() => { root!.render(<DialogHost dialogs={dialogs} />); });
  expect(document.querySelectorAll("textarea")).toHaveLength(1);
  expect(document.querySelectorAll("input[type=number]")).toHaveLength(0);
  await vi.waitFor(() => expect(startButton()!.disabled).toBe(false));
  act(() => { startButton()!.click(); });
  expect(dialogs.top()?.busy).toBe(true);
  expect(dialogs.requestCloseTop().closed).toBe(false);
  await act(async () => { finish(true); });
  expect(dialogs.top()).toBeNull();
});

it("已保存模型失效时说明原因并禁用创建", async () => {
  render(entryWith({ draft: { modelKey: "p:removed" } }), true);
  await vi.waitFor(() => expect(document.body.textContent).toContain("请选择支持此素材的助手模型"));
  expect(startButton()!.disabled).toBe(true);
});

it.each(["codex-appserver", "openai-responses"])("%s 可从账户目录选择模型并创建，不依赖全局候选清单", async adapterId => {
  const { controller, calls } = fakeController(entryWith({ models: [], modelsLoaded: false }), true);
  const dependencies = deps(controller);
  dependencies.assistant!.listConnections = async () => ({ ok: true, value: [{ connectionId: "native", adapterId, name: "Native", ready: true, configRevision: 2, credentialEpoch: 3, models: [{ id: "vision", label: "Vision", reasoningEfforts: ["high"] }] }] }) as any;
  dependencies.assistant!.catalog = async () => ({ ok: true, value: { capabilities: { candidateGeneration: { imageInput: true, maxImages: 12 } }, models: [{ id: "vision", label: "Vision" }] } }) as any;
  const Settings = createFilmSetConversionSettings(dependencies);
  const element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  act(() => root!.render(<UiProvider><Settings nodeId="img" nodeType="image" writable onClose={() => undefined} /></UiProvider>));
  const trigger = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!;
  await vi.waitFor(() => expect(trigger("选择助手").disabled).toBe(false));
  act(() => trigger("选择助手").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  act(() => (document.querySelector("[role=menuitemradio][aria-label=Native]") as HTMLElement).click());
  act(() => trigger("选择助手模型").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  act(() => (document.querySelector("[role=menuitemradio][aria-label=Vision]") as HTMLElement).click());
  act(() => (document.querySelector("[role=menuitemradio][aria-label=high]") as HTMLElement).click());
  expect(controller.getEntry("img", "image").draft).toMatchObject({ modelKey: `${adapterId}:vision`, reasoningEffort: "high", connection: { connectionId: "native", adapterId, configRevision: 2, credentialEpoch: 3 } });
  await vi.waitFor(() => expect(startButton()!.disabled).toBe(false));
  await act(async () => startButton()!.click());
  expect(calls.start).toBe(1);
});

it("真实 DialogHost 内可点击选择助手、模型与 Variant，菜单属于当前弹窗且不会关闭它", async () => {
  const { controller } = fakeController(entryWith({ settingsOpen: true }), true);
  const dialogs = new DialogService();
  dialogs.registerDialog("film-set-creation", {
    definition: { dismissible: true, singleton: true, validatePayload: payload => ({ ok: true, payload }) },
    renderer: createFilmSetConversionDialog(deps(controller), dialogs)
  });
  dialogs.open({ dialogId: "film-set-creation", payload: { nodeId: "img", nodeType: "image" } });
  const element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
  act(() => { root!.render(<UiProvider><DialogHost dialogs={dialogs} /></UiProvider>); });
  const trigger = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!;
  await vi.waitFor(() => expect(trigger("选择助手").disabled).toBe(false));
  const open = (label: string) => act(() => {
    trigger(label).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });
  open("选择助手");
  expect(document.querySelector("[role=menu]")?.closest(".dlg")).toBeTruthy();
  act(() => { (document.querySelector("[role=menuitemradio][aria-label=Assistant]") as HTMLElement).click(); });
  expect(controller.setDraft).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({
    connection: { connectionId: "connection", adapterId: "agent", configRevision: 1, credentialEpoch: 1 }
  }) }));
  expect(dialogs.top()?.dialogId).toBe("film-set-creation");
  open("选择助手模型");
  act(() => { (document.querySelector("[role=menuitemradio][aria-label=Vision]") as HTMLElement).click(); });
  expect(document.querySelector("[role=menu]")).toBeTruthy();
  act(() => { (document.querySelector("[role=menuitemradio][aria-label=high]") as HTMLElement).click(); });
  expect(controller.getEntry("img", "image").draft).toEqual(expect.objectContaining({ modelKey: "p:vision", reasoningEffort: "high" }));
  expect(document.querySelector("[role=menu]")).toBeNull();
  expect(startButton()!.disabled).toBe(false);
  expect(dialogs.top()?.dialogId).toBe("film-set-creation");
});

it("候选模型仍在加载时不锁住助手选择，并保留管理与刷新入口", async () => {
  render(entryWith({ modelsLoaded: false }), true);
  const trigger = () => document.querySelector<HTMLButtonElement>("button[aria-label='选择助手']")!;
  await vi.waitFor(() => expect(trigger().disabled).toBe(false));
  act(() => { trigger().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })); });
  expect(document.querySelector("[role=menuitemradio][aria-label=Assistant]")).toBeTruthy();
  expect(startButton()!.disabled).toBe(true);
});
