// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import type { GameFurnaceWorkspaceProps } from "../src/integration/browser/workspace.js";
import { GameFurnaceWorkspace } from "../src/integration/browser/workspace.js";
import { GAME_FURNACE_PREVIEW_START_TIMEOUT_MS } from "../src/preview/browser/use-preview.js";
import { createGameFurnaceState, type GameFurnaceState } from "../src/shared.js";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const cleanup: (() => void)[] = [];
afterEach(() => { act(() => cleanup.splice(0).forEach(fn => fn())); });

async function render(writable = true, response?: Promise<unknown>, initialState?: GameFurnaceState) {
  let canvas = { id: "c", document: { nodes: [{ id: "n", type: "composite-asset" }] }, nodeData: { n: { extensionId: "game-furnace", title: "Original title", modelScript: "original", ...(initialState ? { projectStorageKey: "original" } : {}) } } };
  const listeners = new Set<() => void>();
  const catalog = { status: "ready", catalog: { available: true, models: [{ modelKey: "language-model", modelType: "language", title: "语言模型" }], defaultModels: { language: "language-model" } } };
  const request = vi.fn(async (_input: { path: string; body: unknown }) => response ? await response : { ok: true, status: 200, data: { ok: true, projectStorageKey: "saved", inputHash: "hash", ...(initialState ? { state: initialState } : {}) } });
  const submit = vi.fn((..._args: unknown[]) => ({ ok: true, handle: { settled: Promise.resolve({ state: "committed", error: null as string | null }) } }));
  const upload = vi.fn(async (input: { file: File; onProgress?: (percent: number) => void }): Promise<{ ok: true; media: { storageKey: string; checksum: string; contentType: string; size: number; url: string; deduplicated: boolean } } | { ok: false; error: string }> => ({ ok: true as const, media: { storageKey: `sha256-upload`, checksum: "abc123", contentType: input.file.type || "application/octet-stream", size: input.file.size, url: `/api/media/sha256-upload`, deduplicated: false } }));
  let writableNow = writable;
  const props = { writable, nodeId: "n", onBack: vi.fn(), onConfigureModels: vi.fn(),
    canvasState: { getCanvas: () => canvas, getWorkingCanvas: () => canvas, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } },
    commands: { isWritable: () => writableNow, submit },
    remote: { transport: { request } },
    mediaRemote: { upload, urlFor: (key: string) => `/api/media/${key}`, isAllowedUrl: () => true, resolveCanonicalUrl: () => null },
    taskCatalog: { getState: () => catalog, subscribe: () => () => undefined, load: async () => undefined }
  } as unknown as GameFurnaceWorkspaceProps;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let disposed = false;
  const unmount = () => {
    if (disposed) return;
    disposed = true;
    act(() => root.unmount());
    element.remove();
  };
  cleanup.push(unmount);
  let modalActive = false;
  const paint = () => root.render(<GameFurnaceWorkspace {...props} writable={writableNow} modalActive={modalActive} />);
  await act(async () => { paint(); });
  const button = (text: string) => [...element.querySelectorAll("button")].find(button => button.textContent === text)!;
  const edit = async () => { await act(async () => {
    Simulate.change(element.querySelector('input[data-game-furnace-name="true"]')!, { target: { value: "游戏" } } as never);
    Simulate.change(element.querySelector('textarea[data-game-furnace-description]')!, { target: { value: "描述" } } as never);
  }); };
  const addFile = async (file: File) => { await act(async () => {
    Simulate.change(element.querySelector('input[data-game-furnace-file-input="true"]')!, { target: { files: [file] } } as never);
  }); };
  return { element, request, submit, upload, props, button, edit, addFile, unmount, getCanvas: () => canvas, setCanvas: (next: typeof canvas) => { canvas = next; listeners.forEach(fn => fn()); }, switchCanvas: () => { canvas = { ...canvas, id: "other" }; listeners.forEach(fn => fn()); }, setModal: async (open: boolean) => { modalActive = open; await act(async () => { paint(); }); }, setWritable: async (next: boolean) => { writableNow = next; await act(async () => { paint(); }); } };
}

it("空项目可填写并保存；选定目录默认语言模型，保持节点几何", async () => {
  const h = await render();
  await h.edit();
  await act(async () => { h.button("保存").click(); });
  expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ state: expect.objectContaining({ requirements: { name: "游戏", description: "描述", modelKey: "language-model" } }) }) }));
  expect(h.submit).toHaveBeenCalledWith([expect.objectContaining({ value: expect.objectContaining({ modelScript: "original", projectStorageKey: "saved" }) })], expect.any(String));
  expect(h.element.querySelector('[data-game-furnace-saved="true"]')).not.toBeNull();
});

function playableState() {
  const state = createGameFurnaceState("project") as GameFurnaceState;
  state.builds = [{ buildId: "build", generationId: "generation", inputHash: "hash", manifestAssetId: "manifest", sourceAssetId: "source",
    dependencyAssetIds: [], sourceHash: "source-hash", policyVersion: "game-furnace/v1", createdAt: new Date().toISOString(), title: "可玩游戏", controlsSummary: "", resources: [] }];
  state.activeBuildId = "build";
  return state;
}

it("从旧节点关联恢复到新项目 key 后仅在 writable 且关联未变时写回", async () => {
  const response = Promise.resolve({ ok: true, status: 200, data: {
    ok: true, projectStorageKey: "recovered-key", inputHash: "recovered-hash", state: playableState()
  } });
  const writable = await render(true, response, playableState());
  const patch = writable.submit.mock.calls.find(call => (call[0] as { type: string }[])[0]?.type === "nodeData.patch");
  expect(patch).toBeDefined();
  expect((patch![0] as { value: Record<string, unknown> }[])[0]!.value).toMatchObject({
    projectStorageKey: "recovered-key", inputHash: "recovered-hash", activeBuildId: "build"
  });
  expect(writable.element.textContent).toContain("试玩");

  const readOnly = await render(false, Promise.resolve({ ok: true, status: 200, data: {
    ok: true, projectStorageKey: "recovered-key", inputHash: "recovered-hash", state: playableState()
  } }), playableState());
  expect(readOnly.submit).not.toHaveBeenCalled();
  expect(readOnly.element.textContent).toContain("试玩");
});

it("点击试玩立即显示加载；入口直接打开，停止后恢复构建列表", async () => {
  const h = await render(false, undefined, playableState());
  let resolve!: (value: unknown) => void;
  h.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => { h.button("试玩").click(); });
  expect(h.element.textContent).toContain("正在加载试玩…");
  expect(h.element.querySelector('.game-furnace-workspace__body')).toBeNull();
  expect(document.activeElement).toBe(h.element.querySelector('[aria-label="试玩"]'));
  await act(async () => { resolve({ ok: true, status: 200, data: { ok: true, sessionId: "session", html: "<h1>游戏</h1>" } }); });
  expect(h.element.querySelector('iframe')?.getAttribute('srcdoc')).toContain("<h1>游戏</h1>");
  // 任务 8.5：srcDoc 注入受校验引导脚本（携带 nonce/generation），仅白名单 ready/error。
  const srcdoc = h.element.querySelector('iframe')?.getAttribute('srcdoc') ?? "";
  expect(srcdoc).toMatch(/\{"nonce":"[0-9a-f]+","generation":\d+\}/);
  expect(h.request).toHaveBeenCalledTimes(2); // 打开项目和预览，无重复describe
  await act(async () => { h.button("停止试玩").click(); });
  expect(h.element.querySelector('iframe')).toBeNull();
  expect(h.button("试玩")).toBeDefined();
  expect(h.submit).not.toHaveBeenCalled();
  // 任务 8.7：停止时显式释放短期只读会话（回收固定资源）。
  expect(h.request.mock.calls.some(call => (call[0] as { path: string }).path.includes("game-furnace/preview-close")
    && (call[0] as { body: { sessionId?: string } }).body.sessionId === "session")).toBe(true);
});

it("试玩失败可见且可重试；停止或切换画布后迟到响应不打开游戏", async () => {
  const h = await render(true, undefined, playableState());
  h.request.mockResolvedValueOnce({ ok: false, code: "unavailable", error: "offline" });
  await act(async () => { h.button("试玩").click(); });
  expect(h.element.querySelector('[role="alert"]')?.textContent).toContain("无法连接服务");
  let resolve!: (value: unknown) => void;
  h.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => { h.button("重试试玩").click(); });
  await act(async () => { h.button("停止试玩").click(); });
  await act(async () => { resolve({ ok: true, status: 200, data: { ok: true, html: "<h1>迟到游戏</h1>" } }); });
  expect(h.element.querySelector('iframe')).toBeNull();
  h.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => { h.button("试玩").click(); });
  await act(async () => { h.switchCanvas(); });
  await act(async () => { resolve({ ok: true, status: 200, data: { ok: true, html: "<h1>旧画布游戏</h1>" } }); });
  expect(h.element.querySelector('[aria-label="试玩"]')).toBeNull();
});

it("试玩启动超时显示边界说明并卸载无响应 iframe（任务 8.8）", async () => {
  vi.useFakeTimers();
  try {
    const h = await render(true, undefined, playableState());
    h.request.mockImplementationOnce(() => new Promise(() => undefined));
    await act(async () => { h.button("试玩").click(); });
    expect(h.element.querySelector('[aria-label="试玩"] [role="status"]')?.textContent).toContain("正在加载试玩");

    await act(async () => { vi.advanceTimersByTime(GAME_FURNACE_PREVIEW_START_TIMEOUT_MS); });
    expect(h.element.querySelector('[aria-label="试玩"] [role="alert"]')?.textContent).toContain("浏览器不保证立即回收执行资源");
    expect(h.element.querySelector("iframe")).toBeNull();
    expect(h.button("停止试玩")).toBeDefined();
    expect(h.button("重试试玩")).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

it("加载后的试玩会话过期会销毁 iframe、释放会话，等待显式重开", async () => {
  vi.useFakeTimers();
  try {
    const h = await render(true, undefined, playableState());
    h.request.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, sessionId: "expiring", expiresAt: Date.now() + 1000, html: "<h1>游戏</h1>" } });
    await act(async () => { h.button("试玩").click(); });
    const frame = h.element.querySelector("iframe")!;
    await act(async () => { Simulate.load(frame); });
    expect(h.element.querySelector("iframe")).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(h.element.querySelector("iframe")).toBeNull();
    expect(h.element.textContent).toContain("试玩会话已过期");
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringContaining("preview-close"), body: { sessionId: "expiring" } }));
    expect(h.button("重试试玩")).toBeDefined();
  } finally { vi.useRealTimers(); }
});

it("模态打开停止试玩并释放会话；关闭模态不自动重启（任务 5.9/8.7）", async () => {
  const h = await render(true, undefined, playableState());
  h.request.mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, data: { ok: true, sessionId: "session", html: "<h1>游戏</h1>" } }));
  await act(async () => { h.button("试玩").click(); });
  expect(h.element.querySelector('iframe')?.getAttribute('srcdoc')).toContain("<h1>游戏</h1>");

  h.request.mockClear();
  await h.setModal(true);
  // 模态打开：销毁 iframe 并显式关闭短期会话；不残留 capture/监听。
  expect(h.element.querySelector('iframe')).toBeNull();
  expect(h.request.mock.calls.some(call => (call[0] as { path: string }).path.includes("game-furnace/preview-close")
    && (call[0] as { body: { sessionId?: string } }).body.sessionId === "session")).toBe(true);

  h.request.mockClear();
  await h.setModal(false);
  // 关闭模态：不自动重启试玩（无 preview-open），构建列表恢复可见。
  expect(h.element.querySelector('iframe')).toBeNull();
  expect(h.request.mock.calls.some(call => (call[0] as { path: string }).path.includes("game-furnace/preview-open"))).toBe(false);
  expect(h.button("试玩")).toBeDefined();
});

it("workspace owner 卸载时销毁 iframe 并关闭试玩会话（任务 8.7）", async () => {
  const h = await render(true, undefined, playableState());
  h.request.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, sessionId: "session", html: "<h1>游戏</h1>" } });
  await act(async () => { h.button("试玩").click(); });
  expect(h.element.querySelector("iframe")).not.toBeNull();

  h.request.mockClear();
  h.unmount();

  expect(h.element.querySelector("iframe")).toBeNull();
  expect(h.request).toHaveBeenCalledWith(expect.objectContaining({
    path: expect.stringContaining("game-furnace/preview-close"),
    body: { sessionId: "session" }
  }));
});

it("只读禁用持久编辑与生成，配置与返回入口仍可达", async () => {
  const h = await render(false);
  expect((h.element.querySelector('input[data-game-furnace-name="true"]') as HTMLInputElement).disabled).toBe(true);
  expect(h.button("保存").disabled).toBe(true);
  expect(h.button("生成").disabled).toBe(true);
  await act(async () => { h.button("返回画布").click(); h.button("配置模型").click(); });
  expect(h.props.onBack).toHaveBeenCalledOnce();
  expect(h.props.onConfigureModels).toHaveBeenCalledOnce();
  expect(h.request).not.toHaveBeenCalled();
});

it("切换画布后旧保存响应不写入新画布的同名节点", async () => {
  let resolve!: (value: unknown) => void;
  const result = new Promise(r => { resolve = r; });
  const h = await render(true, result);
  await h.edit();
  await act(async () => { h.button("保存").click(); });
  expect(h.request).toHaveBeenCalledOnce();
  await act(async () => { h.switchCanvas(); });
  await act(async () => { resolve({ ok: true, status: 200, data: { ok: true, projectStorageKey: "old", inputHash: "hash" } }); });
  expect(h.submit).not.toHaveBeenCalled();
  expect((h.element.querySelector('input[data-game-furnace-name="true"]') as HTMLInputElement).value).toBe("");
});

it("生成和收尾写回各自的项目关联，并显示真实构建与活动版本", async () => {
  const h = await render();
  await h.edit();
  const state = createGameFurnaceState("project") as GameFurnaceState;
  state.requirements = { name: "游戏", description: "描述", modelKey: "language-model" };
  state.generations = [{ generationId: "generation", workerTaskKey: "task", inputHash: "hash", admittedAt: new Date().toISOString(), disposition: "candidate" }];
  state.latestGenerationId = "generation";
  h.request.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, projectStorageKey: "saved", inputHash: "hash" } });
  h.request.mockResolvedValueOnce({ ok: true, status: 202, data: { ok: true, state: "queued", generationId: "generation",
    project: { state, projectStorageKey: "generated", inputHash: "hash" } } });
  await act(async () => { h.button("生成").click(); });
  expect(h.submit).toHaveBeenLastCalledWith([expect.objectContaining({ value: expect.objectContaining({ projectStorageKey: "generated" }) })], expect.any(String));
  expect(h.button("取消生成")).toBeDefined();
  const build = { buildId: "build", generationId: "generation", inputHash: "hash", manifestAssetId: "manifest", sourceAssetId: "source",
    dependencyAssetIds: [], sourceHash: "source-hash", policyVersion: "game-furnace/v1", createdAt: new Date().toISOString(), title: "可玩游戏", controlsSummary: "", resources: [] };
  const built = { ...state, builds: [build], activeBuildId: "build", generations: [{ ...state.generations[0]!, disposition: "active", candidateBuildId: "build" }] };
  h.request.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, state: "succeeded",
    project: { state: built, projectStorageKey: "built", inputHash: "hash" } } });
  await act(async () => { h.button("收尾最新生成").click(); });
  expect(h.submit).toHaveBeenLastCalledWith([expect.objectContaining({ value: expect.objectContaining({ projectStorageKey: "built", activeBuildId: "build" }) })], expect.any(String));
  expect(h.element.querySelector(".game-furnace-workspace__builds")!.textContent).toContain("可玩游戏当前试玩");
});


it("右侧 MCP 指引复制当前画布/节点和需求，复制及切换目标不提交生成请求", async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const h = await render();
  await h.edit();
  const requestCount = h.request.mock.calls.length;
  const guide = h.element.querySelector('[aria-label="MCP 游戏生成指引"]')!;
  expect(guide.closest('.game-furnace-workspace__requirements')).not.toBeNull();
  await act(async () => { h.button("复制给 Agent").click(); });
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('目标：{"canvasId":"c","nodeId":"n"}'));
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('"name":"游戏","description":"描述"'));
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("交付独立 Vite 游戏项目"));
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("prepare_game_project"));
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("Agent在projectDirectory自行写代码"));
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining("entryUrl"));
  expect(guide.textContent).toContain("Agent 指引已复制");
  expect(h.request).toHaveBeenCalledTimes(requestCount);
  expect(h.submit).not.toHaveBeenCalled();
  await act(async () => { h.switchCanvas(); });
  await act(async () => { h.button("复制给 Agent").click(); });
  expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('目标：{"canvasId":"other","nodeId":"n"}'));
  writeText.mockRejectedValueOnce(new Error("clipboard denied"));
  await act(async () => { h.button("复制 MCP 地址").click(); });
  expect(h.element.textContent).toContain("复制失败，请手动选择文本复制");
});

it("候选版本可显式采用：写回 activeBuildId 并销毁旧试玩（任务 7.7）", async () => {
  const state = createGameFurnaceState("project") as GameFurnaceState;
  const build = (buildId: string, title: string, generationId: string) => ({ buildId, generationId, inputHash: "hash", manifestAssetId: "m", sourceAssetId: "s",
    dependencyAssetIds: [], sourceHash: "sh", policyVersion: "game-furnace/v1", createdAt: new Date().toISOString(), title, controlsSummary: "", resources: [] });
  state.builds = [build("build-a", "版本A", "gen-a"), build("build-b", "版本B", "gen-b")];
  state.activeBuildId = "build-a";
  state.generations = [
    { generationId: "gen-a", workerTaskKey: "t", inputHash: "hash", admittedAt: new Date().toISOString(), disposition: "active", candidateBuildId: "build-a" },
    { generationId: "gen-b", workerTaskKey: "t2", inputHash: "hash2", admittedAt: new Date().toISOString(), disposition: "candidate", candidateBuildId: "build-b" }
  ];
  state.latestGenerationId = "gen-b";

  const h = await render(true, undefined, state);
  // 唯一「采用」按钮属于非活动的版本B。
  const adoptButtons = () => [...h.element.querySelectorAll("button")].filter(b => b.textContent === "采用");
  expect(adoptButtons()).toHaveLength(1);

  const activated = { ...state, activeBuildId: "build-b", generations: [{ ...state.generations[0]!, disposition: "candidate" }, { ...state.generations[1]!, disposition: "active" }] };
  h.request.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, activeBuildId: "build-b", project: { state: activated, projectStorageKey: "activated", inputHash: "hash" } } });
  await act(async () => { adoptButtons()[0]!.click(); });

  expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ path: expect.stringContaining("activate-build"), body: expect.objectContaining({ buildId: "build-b" }) }));
  expect(h.submit).toHaveBeenLastCalledWith([expect.objectContaining({ value: expect.objectContaining({ projectStorageKey: "activated", activeBuildId: "build-b" }) })], expect.any(String));
  expect(h.element.textContent).toContain("已采用该版本为当前活动游戏");
  // 采用后版本B成为「当前」；版本A重新变为可采用的候选（任务 7.7 的候选/版本展示）。
  const builds = h.element.querySelector(".game-furnace-workspace__builds")!;
  expect(builds.textContent).toContain("版本B当前");
  expect(builds.querySelectorAll(".game-furnace-workspace__candidate")).toHaveLength(1);
  const remaining = adoptButtons();
  expect(remaining).toHaveLength(1);
  expect(remaining[0]!.closest("li")!.textContent).toContain("版本A");
});

it("添加文件：上传成功后原子收集素材并写回关联，刷新显示确定性描述（任务 4.7/4.9）", async () => {
  const h = await render(true);
  const collectOp = (path: string) => path.includes("project-collect");
  const collectedState = {
    ...(createGameFurnaceState("p") as GameFurnaceState),
    resources: [{
      resourceId: "res-upload-abc123", kind: "image", name: "hero.png", category: "图片",
      description: "image/png · 3 字节", payload: { kind: "asset", assetIds: ["asset-upload-abc123"] },
      metadata: { mime: "image/png", size: 3, storageKey: "sha256-upload", previewAssetId: "asset-upload-abc123" }
    }]
  } as GameFurnaceState;
  h.request.mockImplementation(async (input: { path: string; body: unknown }) => {
    if (collectOp(input.path)) return { ok: true, status: 200, data: { ok: true, projectStorageKey: "collected", inputHash: "hash2" } };
    return { ok: true, status: 200, data: { ok: true, projectStorageKey: "collected", inputHash: "hash2", state: collectedState } };
  });
  h.submit.mockClear();
  await h.addFile(new File([new Uint8Array([1, 2, 3])], "hero.png", { type: "image/png" }));

  expect(h.upload).toHaveBeenCalledTimes(1);
  const collect = h.request.mock.calls.find(call => collectOp((call[0] as { path: string }).path));
  expect(collect).toBeDefined();
  const ops = ((collect as unknown[])[0] as { body: { operations: { type: string }[] } }).body.operations;
  expect(ops.map(op => op.type)).toEqual(["resources.add"]);
  expect(h.submit).toHaveBeenCalledWith([
    expect.objectContaining({ type: "asset.upsert", asset: expect.objectContaining({ id: "asset-upload-abc123" }) }),
    expect.objectContaining({ type: "nodeData.patch", value: expect.objectContaining({ projectStorageKey: "collected" }) })
  ], expect.any(String));
  // 关联写回保留通用字段，使用服务端返回的稳定 storageKey/inputHash。
  expect(h.submit.mock.calls.some(call => JSON.stringify(call).includes("\"projectStorageKey\":\"collected\""))).toBe(true);
  expect(h.element.textContent).toContain("已添加文件素材");
  // 刷新后的清单显示新素材及其确定性默认描述。
  expect(h.element.querySelector(".game-furnace-workspace__materials")!.textContent).toContain("hero.png");
  expect(h.element.querySelector(".game-furnace-workspace__materials")!.textContent).toContain("image/png · 3 字节");
});

it("上传失败：进行态可见、给出安全原因并可重试；不写假成功素材（任务 4.9）", async () => {
  const h = await render(true);
  h.upload.mockResolvedValueOnce({ ok: false as const, error: "上传失败（HTTP 500）" });
  await h.addFile(new File([new Uint8Array([9])], "note.txt", { type: "text/plain" }));
  expect(h.element.textContent).toContain("上传失败：note.txt");
  expect(h.element.textContent).toContain("上传失败（HTTP 500）");
  expect(h.element.textContent).toContain("有 1 个文件未添加");
  // 失败未关联素材：无收集请求、无关联写回。
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.request.mock.calls.some(call => (call[0] as { path: string }).path.includes("project-collect"))).toBe(false);
  // 重试成功：同一 File 句柄重新上传并收集。
  await act(async () => { h.button("重试").click(); });
  expect(h.upload).toHaveBeenCalledTimes(2);
  expect(h.element.textContent).toContain("已添加：note.txt");
});

it("只读时禁用添加文件入口（任务 4.9）", async () => {
  const h = await render(false);
  expect(h.button("添加文件").disabled).toBe(true);
  expect(h.request).not.toHaveBeenCalled();
});

it("素材名称/分类/描述可编辑并逐字段保存；刷新显示新值（任务 5.4/5.5）", async () => {
  const state = createGameFurnaceState("project") as GameFurnaceState;
  state.resources = [{
    resourceId: "res-a", kind: "image", name: "主角", category: "图片", description: "image/png · 3 字节",
    payload: { kind: "asset", assetIds: ["asset-a"] }, metadata: { mime: "image/png", size: 3, storageKey: "sha256-a" }
  }];
  const h = await render(true, undefined, state);
  const nameInput = () => h.element.querySelector('input[data-game-furnace-resource-name="true"]') as HTMLInputElement;
  const categoryInput = () => h.element.querySelector('input[data-game-furnace-resource-category="true"]') as HTMLInputElement;
  const descInput = () => h.element.querySelector('textarea[data-game-furnace-resource-description="true"]') as HTMLTextAreaElement;
  expect(nameInput().value).toBe("主角");

  const updated = { ...state, resources: [{ ...state.resources[0]!, name: "英雄", description: "新的图片描述" }] };
  h.request.mockClear();
  h.request.mockImplementation(async (input: { path: string; body: unknown }) => {
    if (input.path.includes("project-collect")) return { ok: true, status: 200, data: { ok: true, projectStorageKey: "edited", inputHash: "hash2" } };
    return { ok: true, status: 200, data: { ok: true, projectStorageKey: "edited", inputHash: "hash2", state: updated } };
  });
  await act(async () => {
    Simulate.change(nameInput(), { target: { value: "英雄" } } as never);
    Simulate.change(descInput(), { target: { value: "新的图片描述" } } as never);
  });
  await act(async () => { h.button("保存素材信息").click(); });

  const collect = h.request.mock.calls.find(call => (call[0] as { path: string }).path.includes("project-collect"));
  expect(collect).toBeDefined();
  const operations = ((collect as unknown[])[0] as { body: { operations: unknown[] } }).body.operations;
  // 只下发真正变化的字段；分类未编辑故不出现。
  expect(operations).toEqual([{ type: "resources.update", updates: [{ resourceId: "res-a", name: "英雄", description: "新的图片描述" }] }]);
  expect(h.submit.mock.calls.some(call => JSON.stringify(call).includes("\"projectStorageKey\":\"edited\""))).toBe(true);
  // 提交后刷新并清除草稿，显示权威新值。
  expect(nameInput().value).toBe("英雄");
  expect(categoryInput().value).toBe("图片");
  expect(h.element.textContent).toContain("已保存素材名称与描述");
});

it("只读时素材字段与保存入口禁用（任务 5.10）", async () => {
  const state = createGameFurnaceState("project") as GameFurnaceState;
  state.resources = [{
    resourceId: "res-a", kind: "image", name: "主角", category: "图片", description: "image/png",
    payload: { kind: "asset", assetIds: ["asset-a"] }, metadata: { mime: "image/png", size: 3, storageKey: "sha256-a" }
  }];
  const h = await render(false, undefined, state);
  expect((h.element.querySelector('input[data-game-furnace-resource-name="true"]') as HTMLInputElement).disabled).toBe(true);
  expect((h.element.querySelector('textarea[data-game-furnace-resource-description="true"]') as HTMLTextAreaElement).disabled).toBe(true);
});

it("只读可查看素材预览与试玩已有版本；持久编辑/运行/激活受门禁（任务 5.10）", async () => {
  const storageKey = `sha256-${"a".repeat(64)}`;
  const state = createGameFurnaceState("project") as GameFurnaceState;
  state.requirements = { name: "游戏", description: "描述", modelKey: "language-model" };
  state.resources = [{
    resourceId: "res-img", kind: "image", name: "主角", category: "图片", description: "image/png",
    payload: { kind: "asset", assetIds: ["asset-a"] }, metadata: { mime: "image/png", size: 3, storageKey }
  }, {
    resourceId: "res-audio", kind: "audio", name: "音乐", category: "音效", description: "audio/mpeg",
    payload: { kind: "asset", assetIds: ["asset-b"] }, metadata: { mime: "audio/mpeg", size: 3, storageKey }
  }, {
    resourceId: "res-unknown", kind: "unknown", name: "未知", category: "其它", description: "bin",
    payload: { kind: "asset", assetIds: ["asset-u"] }, metadata: { mime: "application/octet-stream", size: 3, storageKey }
  }];
  const build = (buildId: string, title: string, generationId: string) => ({ buildId, generationId, inputHash: "hash", manifestAssetId: "m", sourceAssetId: "s",
    dependencyAssetIds: [], sourceHash: "sh", policyVersion: "game-furnace/v1", createdAt: new Date().toISOString(), title, controlsSummary: "", resources: [] });
  state.builds = [build("build-a", "版本A", "gen-a"), build("build-b", "版本B", "gen-b")];
  state.activeBuildId = "build-a";
  state.generations = [{ generationId: "gen-a", workerTaskKey: "t", inputHash: "hash", admittedAt: new Date().toISOString(), disposition: "active", candidateBuildId: "build-a" }];
  state.latestGenerationId = "gen-a";

  const h = await render(false, undefined, state);

  // 只读：素材可查看（媒体预览可达），且顶部显式标注只读（不伪装可保存）。
  expect(h.element.querySelector('img[src="/api/media/' + storageKey + '"]')).not.toBeNull();
  const audio = h.element.querySelector('audio');
  expect(audio).not.toBeNull();
  // 媒体不自动播放：preload 为 none（用户显式播放才加载）。
  expect(audio!.getAttribute("preload")).toBe("none");
  expect(h.element.textContent).toContain("只读");
  // unknown 明确「已保留原件，暂无可用预览」。
  expect(h.element.textContent).toContain("已保留原件，暂无可用预览");

  // 只读：持久编辑、运行、激活均受门禁。
  expect((h.element.querySelector('input[data-game-furnace-name="true"]') as HTMLInputElement).disabled).toBe(true);
  expect(h.button("保存").disabled).toBe(true);
  expect(h.button("生成").disabled).toBe(true);
  const adopt = [...h.element.querySelectorAll("button")].filter(b => b.textContent === "采用");
  expect(adopt).toHaveLength(1); // 非活动版本B 唯一可采用的候选
  expect(adopt[0]!.disabled).toBe(true);
  expect(h.button("收尾最新生成").disabled).toBe(true);
  expect(h.button("添加文件").disabled).toBe(true);

  // 只读：试玩已有版本仍允许——请求 preview-open 并渲染 iframe。
  h.request.mockClear();
  h.request.mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, data: { ok: true, sessionId: "s-readonly", html: "<h1>只读试玩</h1>" } }));
  await act(async () => { h.button("试玩").click(); });
  expect(h.request.mock.calls.some(call => (call[0] as { path: string }).path.includes("preview-open"))).toBe(true);
  expect(h.element.querySelector('iframe')?.getAttribute('srcdoc')).toContain("只读试玩");
  // 试玩是只读操作：不写回画布关联、不触发采用/保存/生成。
  expect(h.submit).not.toHaveBeenCalled();
});

it("只读时不显示/禁用取消他人工作等写操作入口（任务 5.10）", async () => {
  const state = createGameFurnaceState("project") as GameFurnaceState;
  state.requirements = { name: "游戏", description: "描述", modelKey: "language-model" };
  // 进行中的生成（候选、未失败/取消）——只读用户不得取消他人工作。
  state.generations = [{ generationId: "gen-run", workerTaskKey: "t", inputHash: "hash", admittedAt: new Date().toISOString(), disposition: "candidate" }];
  state.latestGenerationId = "gen-run";
  const h = await render(false, undefined, state);
  expect(h.button("取消生成").disabled).toBe(true);
  expect(h.button("收尾最新生成").disabled).toBe(true);
});

it("编辑期间权限降为只读：迟到的保存响应不写回画布（操作时再次校验，任务 5.10）", async () => {
  let resolve!: (value: unknown) => void;
  const result = new Promise(r => { resolve = r; });
  const h = await render(true, result);
  await h.edit();
  await act(async () => { h.button("保存").click(); });
  expect(h.request).toHaveBeenCalledOnce();
  // 请求在途时权限被撤销（会话变只读）。
  await h.setWritable(false);
  await act(async () => { resolve({ ok: true, status: 200, data: { ok: true, projectStorageKey: "late", inputHash: "hash" } }); });
  // 操作时二次校验失败：不提交 nodeData.patch，不把只读伪装为可保存。
  expect(h.submit).not.toHaveBeenCalled();
});


it.each(["stop", "unmount"])("preview-open 迟到于 %s 后仍关闭已创建的远端会话", async (exit) => {
  const h = await render(false, undefined, playableState());
  let resolve!: (value: unknown) => void;
  h.request.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await act(async () => { h.button("试玩").click(); });
  if (exit === "stop") await act(async () => { h.button("停止试玩").click(); });
  else h.unmount();
  h.request.mockClear();
  await act(async () => { resolve({ ok: true, status: 200, data: { ok: true, sessionId: "late-session", html: "<h1>late</h1>" } }); });
  expect(h.request).toHaveBeenCalledWith(expect.objectContaining({
    path: expect.stringContaining("game-furnace/preview-close"), body: { sessionId: "late-session" }
  }));
  expect(h.element.querySelector("iframe")).toBeNull();
});

it("保存后使用后端转存状态，避免再次提交超长内联原件", async () => {
  const original = createGameFurnaceState("p") as unknown as GameFurnaceState;
  original.resources = [{ resourceId: "large", kind: "text", name: "大文本", category: "文本", description: "", payload: { kind: "text", assetIds: [], snapshot: { text: "原件".repeat(7000) } } }];
  const h = await render(true, undefined, original);
  const canonical: GameFurnaceState = { ...original, resources: [{ ...original.resources[0]!, metadata: { storageKey: "sha256-original", mime: "text/plain" }, payload: { kind: "text", assetIds: ["sha256-original"], snapshot: { overBudget: true, sourceAssetId: "sha256-original", textChars: 14000 } } }] };
  h.request.mockImplementation(async ({ path, body }) => ({ ok: true, status: 200, data: { ok: true, projectStorageKey: "saved", inputHash: "hash", state: path.endsWith("project-save") ? { ...canonical, requirements: (body as { state: GameFurnaceState }).state.requirements } : canonical } }));
  await h.edit();
  await act(async () => { h.button("保存").click(); });
  expect(h.element.textContent).toContain("完整文本保留在原件中");
  await act(async () => { Simulate.change(h.element.querySelector('textarea[data-game-furnace-description]')!, { target: { value: "第二版描述" } } as never); });
  await act(async () => { h.button("保存").click(); });
  const saves = h.request.mock.calls.filter(([input]) => input.path.endsWith("project-save"));
  expect(saves).toHaveLength(2);
  expect((saves.at(-1)![0].body as { state: GameFurnaceState }).state.resources[0]!.payload.snapshot?.text).toBeUndefined();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const savedResponse = { ok: true, status: 200, data: { ok: true, projectStorageKey: "saved", inputHash: "hash" } };

it.each(["recreate", "scope-return", "business", "definition", "project"])("保存迟到不写入已失效目标：%s", async (change) => {
  const h = await render();
  const remote = deferred<unknown>();
  h.request.mockImplementationOnce(() => remote.promise);
  await h.edit();
  await act(async () => { h.button("保存").click(); });
  const original = h.getCanvas();
  if (change === "recreate") {
    await act(async () => { h.setCanvas({ ...original, document: { nodes: [] } }); });
    await act(async () => { h.setCanvas(structuredClone(original)); });
  } else if (change === "scope-return") {
    await act(async () => { h.switchCanvas(); });
    await act(async () => { h.setCanvas(structuredClone(original)); });
  } else {
    const patch = change === "business" ? { extensionId: "film-set" } : change === "definition" ? { modelScript: "changed" } : { projectStorageKey: "new-project" };
    await act(async () => { h.setCanvas({ ...original, nodeData: { n: { ...original.nodeData.n, ...patch } } }); });
  }
  await act(async () => { remote.resolve(savedResponse); });
  expect(h.submit).not.toHaveBeenCalled();
  expect(h.element.querySelector('[data-game-furnace-saved="true"]')).toBeNull();
});

it.each(["committed", "rejected"])("保存关联等正式回执，不把pending作为成功：%s", async (state) => {
  const h = await render();
  const receipt = deferred<{ state: string; error: string | null }>();
  h.submit.mockImplementationOnce(() => ({ ok: true, handle: { settled: receipt.promise } }));
  await h.edit();
  await act(async () => { h.button("保存").click(); });
  expect(h.submit).toHaveBeenCalledOnce();
  expect(h.element.querySelector('[data-game-furnace-saved="true"]')).toBeNull();
  await act(async () => { receipt.resolve({ state, error: state === "rejected" ? "conflict" : null }); });
  if (state === "committed") expect(h.element.querySelector('[data-game-furnace-saved="true"]')).not.toBeNull();
  else {
    expect(h.element.querySelector('[data-game-furnace-saved="true"]')).toBeNull();
    expect(h.element.textContent).toContain("关联未写回");
  }
});


it("已提交关联的旧回执在切画布再返回后不显示成功", async () => {
  const h = await render();
  const receipt = deferred<{ state: string; error: string | null }>();
  h.submit.mockImplementationOnce(() => ({ ok: true, handle: { settled: receipt.promise } }));
  await h.edit();
  await act(async () => { h.button("保存").click(); });
  const original = h.getCanvas();
  await act(async () => { h.switchCanvas(); });
  await act(async () => { h.setCanvas(structuredClone(original)); });
  await act(async () => { receipt.resolve({ state: "committed", error: null }); });
  expect(h.element.querySelector('[data-game-furnace-saved="true"]')).toBeNull();
  expect(h.element.querySelector('.game-furnace-workspace__message')?.textContent).not.toBe("已保存");
});

it("其它节点更新不取消当前保存，关联提交保留最新通用字段", async () => {
  const h = await render();
  const remote = deferred<unknown>();
  h.request.mockImplementationOnce(() => remote.promise);
  await h.edit();
  await act(async () => { h.button("保存").click(); });
  const original = h.getCanvas();
  await act(async () => { h.setCanvas({ ...original, document: { nodes: [...original.document.nodes, { id: "other", type: "image" }] }, nodeData: { n: { ...original.nodeData.n, title: "Remote title" } } }); });
  await act(async () => { remote.resolve(savedResponse); });
  expect(h.submit).toHaveBeenCalledWith([expect.objectContaining({ value: expect.objectContaining({ title: "Remote title", projectStorageKey: "saved" }) })], expect.any(String));
  expect(h.element.querySelector('[data-game-furnace-saved="true"]')).not.toBeNull();
});

it.each(["recreate", "business", "project"])("试玩迟到不打开已失效的工作区：%s", async (change) => {
  const h = await render(true, undefined, playableState());
  h.submit.mockClear();
  const remote = deferred<unknown>();
  h.request.mockImplementationOnce(() => remote.promise);
  await act(async () => { h.button("试玩").click(); });
  const original = h.getCanvas();
  if (change === "recreate") {
    await act(async () => { h.setCanvas({ ...original, document: { nodes: [] } }); });
    await act(async () => { h.setCanvas(structuredClone(original)); });
  } else {
    const patch = change === "business" ? { extensionId: "film-set" } : { projectStorageKey: "different" };
    await act(async () => { h.setCanvas({ ...original, nodeData: { n: { ...original.nodeData.n, ...patch } } }); });
  }
  await act(async () => { remote.resolve({ ok: true, status: 200, data: { ok: true, html: "<h1>Late game</h1>" } }); });
  expect(h.element.querySelector("iframe")).toBeNull();
  expect(h.submit.mock.calls.every(call => String(call[1]).startsWith("game-furnace-open-recovery:"))).toBe(true);
});

it("采用构建等待关联回执；被拒绝时保留原活动构建", async () => {
  const state = playableState();
  state.builds.push({ ...state.builds[0]!, buildId: "candidate", generationId: "candidate-gen", title: "候选游戏" });
  const h = await render(true, undefined, state);
  const next = { ...state, activeBuildId: "candidate" };
  const receipt = deferred<{ state: string; error: string | null }>();
  h.submit.mockImplementationOnce(() => ({ ok: true, handle: { settled: receipt.promise } }));
  h.request.mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, activeBuildId: "candidate", project: { state: next, projectStorageKey: "next", inputHash: "hash" } } });
  await act(async () => { h.button("采用").click(); });
  expect(h.element.querySelector('.game-furnace-workspace__message')?.textContent ?? "").not.toContain("已采用");
  expect(h.button("保存").disabled).toBe(true);
  await act(async () => { receipt.resolve({ state: "rejected", error: "conflict" }); });
  expect(h.element.querySelector('.game-furnace-workspace__message')?.textContent).toContain("关联未写回");
  expect(h.element.querySelector('.game-furnace-workspace__builds')?.textContent).toContain("可玩游戏当前");
  expect(h.element.querySelector("input")!.disabled).toBe(false);
  expect(h.button("采用").disabled).toBe(false);
});
