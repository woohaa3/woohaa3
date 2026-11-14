// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasWorkspaceSection } from "./canvas-workspace-section.js";
import { createSettingsEditSession } from "./edit-session.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), folder: vi.fn() }));
vi.mock("../../services/app-base-path.js", () => ({ getAppPublicFetch: () => mocks.fetch }));
vi.mock("../../../desktop/workspace-folders.js", () => ({ workspaceFolder: mocks.folder }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); mocks.fetch.mockReset(); mocks.folder.mockReset(); });
const snapshot = () => ({ available: true, rootPath: "/current", rootRevision: 7, generation: 3 });
const json = (value: unknown, ok = true) => ({ ok, json: async () => value });
async function render(canManage = true) {
  const session = createSettingsEditSession();
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<CanvasWorkspaceSection canManage={canManage} canvasId="canvas/id" editSession={session} />); });
  return session;
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(b => b.textContent === label);
  expect(button).toBeDefined(); await act(async () => { button!.click(); });
}

describe("desktop workspace settings", () => {
  it("cancelled native selection preserves the root without posting settings", async () => {
    mocks.fetch.mockResolvedValue(json(snapshot())); mocks.folder.mockResolvedValue({ path: null });
    const session = await render(); await click("选择文件夹");
    expect(mocks.folder).toHaveBeenCalledWith({ action: "pick" });
    expect(mocks.fetch.mock.calls.every(([, options]) => options.method !== "POST")).toBe(true);
    expect(document.body.textContent).toContain("/current"); expect(session.isPending()).toBe(false);
  });
  it("retries a lost migration response with the same operation identity and revision", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true); mocks.folder.mockResolvedValue({ path: "/next" });
    let fail = true;
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/migrate")) { if (fail) { fail = false; throw new Error("response lost"); } return json({ phase: "waiting-for-idle" }); }
      return json(snapshot());
    });
    const session = await render(); await click("选择文件夹");
    expect(document.body.textContent).toContain("response lost"); expect(session.isPending()).toBe(false);
    await click("重试更换");
    const calls = mocks.fetch.mock.calls.filter(([url]) => url.endsWith("/migrate")).map(([, options]) => JSON.parse(options.body));
    expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toMatchObject({ targetPath: "/next", expectedRootRevision: 7 });
    expect(calls[0].operationId).toBeTruthy(); expect(document.body.textContent).toContain("/current");
  });
  it("shows an accepted migration after reopen, allows cancellation and releases the navigation gate", async () => {
    let migration: unknown = { operationId: "existing", phase: "waiting-for-idle", target: "/next", source: "/current", expectedRootRevision: 7 };
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/cancel-migration")) { migration = { ...(migration as object), phase: "cancelled" }; return json(migration); }
      return json({ ...snapshot(), migration });
    });
    const session = await render();
    expect(document.body.textContent).toContain("等待助手任务完成"); expect(session.isPending()).toBe(false);
    await click("取消迁移");
    const [, options] = mocks.fetch.mock.calls.find(([url]) => url.endsWith("/cancel-migration"))!;
    expect(JSON.parse(options.body)).toEqual({ operationId: "existing" });
    expect(document.body.textContent).toContain("已取消迁移"); expect(session.isPending()).toBe(false);
  });
  it("opens the current canvas and confirms the precise cleanup scope", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.fetch.mockImplementation(async (url: string) => json(url.includes("/location?") ? { path: "/current/canvas" } : url.endsWith("/clean") ? { removed: ["one"], retained: ["active", "unknown"] } : snapshot()));
    mocks.folder.mockResolvedValue({}); await render(); await click("打开当前画布目录");
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith("/location?canvasId=canvas%2Fid"))).toBe(true);
    expect(mocks.folder).toHaveBeenCalledWith({ action: "open", path: "/current/canvas" });
    await click("清理临时文件");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("共享文件、运行中和状态未知"));
    const [, options] = mocks.fetch.mock.calls.find(([url]) => url.endsWith("/clean"))!;
    expect(JSON.parse(options.body)).toEqual({ canvasId: "canvas/id" });
    expect(document.body.textContent).toContain("已清理 1 个回合，保留 2 个回合");
  });
  it("disables all native and write actions without settings permission", async () => {
    mocks.fetch.mockResolvedValue(json(snapshot())); await render(false);
    expect([...document.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
    await click("选择文件夹"); expect(mocks.folder).not.toHaveBeenCalled();
  });
});


it("a stale poll cannot restore a migration after cancellation", async () => {
  vi.useFakeTimers();
  const migration = { operationId: "move", phase: "waiting-for-idle", source: "/current", target: "/next", expectedRootRevision: 7 };
  let reads = 0, resolvePoll!: (value: unknown) => void;
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/cancel-migration")) return json({ ...migration, phase: "cancelled" });
    reads++;
    if (reads === 2) return new Promise(resolve => { resolvePoll = resolve; });
    return json({ ...snapshot(), migration: { ...migration, ...(reads > 2 ? { phase: "cancelled" } : {}) } });
  });
  await render(); await act(async () => { vi.advanceTimersByTime(1200); });
  expect(reads).toBe(2); await click("取消迁移");
  expect(document.body.textContent).toContain("已取消迁移");
  await act(async () => { resolvePoll(json({ ...snapshot(), migration })); });
  expect(document.body.textContent).toContain("已取消迁移");
  expect(document.body.textContent).not.toContain("等待助手任务完成");
});
