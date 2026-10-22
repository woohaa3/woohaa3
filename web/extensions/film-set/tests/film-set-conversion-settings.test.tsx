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
import { readFilmSetConversionAssistant, type AgentConnectionView } from "@woohaa3/contracts";
import "../../../frontend/src/cordis/test-support/dom-setup.js";
import { createEmptyWoohaa3ServerCanvas, type FilmSetConversionModelCandidate, type ServerCanvas } from "@woohaa3/contracts";
import { createFilmSetConversionDialog, createFilmSetConversionSettings } from "../src/authoring/browser/film-set-conversion/settings.js";
import { DialogService } from "../../../frontend/src/cordis/services/dialogs/service.js";
import { DialogHost } from "../../../frontend/src/cordis/services/dialogs/DialogHost.js";
import { UiProvider } from "../../../frontend/src/shared/ui/UiProvider.js";
import { createFilmSetConversionController, defaultFilmSetConversionEntry, type FilmSetConversionController, type FilmSetConversionEntry } from "../src/authoring/browser/film-set-conversion/controller.js";
import type { FilmSetConversionClient } from "../src/authoring/browser/film-set-conversion/client.js";
import type { FilmSetConversionActionDependencies } from "../src/authoring/browser/film-set-conversion/action.js";

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

it("真实弹窗内的模型选项可点选，保留提示词并按选中模型提交", async () => {
  const alternative = { ...model, modelKey: "p:alternative", label: "另一视觉模型", isDefault: false };
  const submit = vi.fn<FilmSetConversionClient["submit"]>(async () => ({ ok: false as const, code: "test-rejected", error: "测试拒绝提交" }));
  const client = {
    models: async () => ({ ok: true, value: { models: [model, alternative] } }),
    submit
  } as unknown as FilmSetConversionClient;
  const canvas = canvasWithImage();
  const controller = createFilmSetConversionController({
    canvasId: "c1", client, getCanvas: () => canvas, isWritable: () => true,
    preferences: { read: () => ({}), write: () => true }
  });
  const dialogs = new DialogService();
  dialogs.registerDialog("film-set-creation", {
    definition: { dismissible: true, singleton: true, validatePayload: payload => ({ ok: true, payload }) },
    renderer: createFilmSetConversionDialog(deps(controller), dialogs)
  });
  dialogs.open({ dialogId: "film-set-creation", payload: { nodeId: "img", nodeType: "image" } });
  const element = document.createElement("div");
  document.body.appendChild(element);
  root = createRoot(element);
  await act(async () => { root!.render(<UiProvider><DialogHost dialogs={dialogs} /></UiProvider>); });

  const prompt = document.querySelector("textarea")!.value;
  const trigger = () => document.querySelector<HTMLButtonElement>(".film-set-conversion-settings__model button")!;
  act(() => { trigger().click(); });
  const listbox = document.querySelector('[role="listbox"]')!;
  // 应用级 portal 位于模态遮罩外，即使 jsdom 可派发 click，真实鼠标也无法命中。
  expect(document.querySelector('.dlg[role="dialog"]')!.contains(listbox)).toBe(true);
  const option = [...listbox.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === alternative.label)!;
  act(() => { option.click(); });

  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(trigger().textContent).toContain(alternative.label);
  expect(document.querySelector("textarea")!.value).toBe(prompt);
  expect(dialogs.top()?.dialogId).toBe("film-set-creation");
  act(() => { trigger().click(); });
  expect(document.querySelector('[role="option"][aria-selected="true"]')!.textContent).toBe(alternative.label);
  act(() => { document.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')!.click(); });
  await act(async () => { startButton()!.click(); });
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ settings: { modelKey: alternative.modelKey, instruction: prompt } }));
});

it("转片场列出统一目录的全部助手，支持本机默认模型与 API 模型/Variant，提交保持图片来源和提示词", async () => {
  const connections = [
    { connectionId: "codex", adapterId: "codex-appserver", name: "Codex 本机", authMode: "local-login", models: [] },
    { connectionId: "opencode", adapterId: "opencode-server", name: "OpenCode 本机", authMode: "local-login", models: [] },
    { connectionId: "api", adapterId: "anthropic", name: "自定义 API 助手", authMode: "api-key", models: [{ id: "vision", label: "视觉模型", reasoningEfforts: ["high"] }] },
    { connectionId: "oauth", adapterId: "chatgpt", name: "ChatGPT 授权", authMode: "oauth", models: [{ id: "gpt", label: "GPT" }] }
  ].map(c => ({ configRevision: 1, credentialEpoch: 2, ready: true, ...c })) as unknown as AgentConnectionView[];
  const listConnections = vi.fn(async () => ({ ok: true, value: connections }));
  const catalog = vi.fn(async () => ({ ok: true, value: { models: [] } }));
  const user = { dataScopeId: "instance-test" };
  const assistant = { service: { listConnections, catalog, invalidateDirectory: vi.fn() }, currentUser: { subscribe: () => () => {}, getSnapshot: () => user } } as unknown as NonNullable<FilmSetConversionActionDependencies["assistant"]>;
  const submit = vi.fn<FilmSetConversionClient["submit"]>(async () => ({ ok: false as const, code: "test-rejected", error: "测试拒绝提交" }));
  const legacyModels = vi.fn();
  const canvas = canvasWithImage();
  const controller = createFilmSetConversionController({ canvasId: "c1", client: { submit, models: legacyModels } as unknown as FilmSetConversionClient,
    preferences: { read: () => ({}), write: () => true }, getCanvas: () => canvas, isWritable: () => true });
  const dialogs = new DialogService();
  dialogs.registerDialog("film-set-creation", { definition: { dismissible: true, singleton: true, validatePayload: payload => ({ ok: true, payload }) }, renderer: createFilmSetConversionDialog({ ...deps(controller), assistant }, dialogs) });
  dialogs.open({ dialogId: "film-set-creation", payload: { nodeId: "img", nodeType: "image" } });
  const element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  await act(async () => { root!.render(<UiProvider><DialogHost dialogs={dialogs} /></UiProvider>); });
  const prompt = document.querySelector("textarea")!.value;
  const open = async (label: string) => { await act(async () => { document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); }); };
  const choose = async (label: string) => { const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(item => item.textContent === label)!; expect(item).toBeTruthy(); await act(async () => item.click()); };
  await open("选择助手");
  expect([...document.querySelectorAll('[role="menuitemradio"]')].map(item => item.textContent)).toEqual(connections.map(c => c.name));
  expect(document.querySelector('.dlg[role="dialog"]')!.contains(document.querySelector('[role="menu"]'))).toBe(true);
  await choose("Codex 本机");
  expect(startButton()!.disabled).toBe(false);
  await act(async () => startButton()!.click());
  expect(readFilmSetConversionAssistant(submit.mock.calls[0]![0].settings!.modelKey)).toEqual({ connection: { connectionId: "codex", adapterId: "codex-appserver", configRevision: 1, credentialEpoch: 2 } });
  await open("选择助手"); await choose("自定义 API 助手");
  expect(startButton()!.disabled).toBe(true);
  await open("选择助手模型"); await choose("视觉模型");
  const modelMenu = document.querySelector('[role="menu"]');
  expect(modelMenu).not.toBeNull();
  await choose("high");
  expect(document.querySelector('[role="menu"]')).toBe(modelMenu);
  await act(async () => document.querySelector<HTMLElement>('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => startButton()!.click());
  const request = submit.mock.calls[1]![0];
  expect(readFilmSetConversionAssistant(request.settings!.modelKey)).toEqual({ connection: { connectionId: "api", adapterId: "anthropic", configRevision: 1, credentialEpoch: 2 }, model: "vision", reasoningEffort: "high" });
  expect(request.sourceNodeId).toBe("img");
  expect(request.settings!.instruction).toBe(prompt);
  expect(document.querySelector("textarea")!.value).toBe(prompt);
  expect(legacyModels).not.toHaveBeenCalled();
  expect(listConnections).toHaveBeenCalledOnce();
});
