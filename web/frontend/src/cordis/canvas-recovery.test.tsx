/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CanvasRecoveryPage } from "./canvas-recovery.js";
import { CanvasCatalogStore } from "./services/canvas-catalog-store.js";
import { createFakeCanvasCatalogRemote, makeSummary } from "./test-support/canvas-catalog.js";
import type { CanvasCatalogListResult, CanvasRecoveryService } from "./contract/canvas-catalog.js";

let catalog: CanvasCatalogStore;
const selection = { setRecentCanvasId: vi.fn() };
vi.mock("./react.js", () => ({ useRuntimeContext: () => ({ canvasCatalog: catalog, canvasSelection: selection }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
const recovery: CanvasRecoveryService = { canvasId: "missing", code: "CATALOG_UNAVAILABLE", error: "画布目录请求失败（HTTP 400）" };
afterEach(() => {
  act(() => root?.unmount()); root = null;
  catalog.dispose(); document.body.innerHTML = ""; selection.setRecentCanvasId.mockClear();
});
async function mount() {
  const navigate = vi.fn();
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<CanvasRecoveryPage recovery={recovery} navigate={navigate} />); });
  return navigate;
}
function button(text: string) {
  const found = [...document.querySelectorAll("button")].find(item => item.textContent === text);
  if (!found) throw Error(`Missing button: ${text}`);
  return found;
}
const failed = { ok: false, code: "http-400", error: "画布目录请求失败（HTTP 400）" } as const;
it("shows list failure, retries with a loading state, then opens an existing canvas", async () => {
  const remote = createFakeCanvasCatalogRemote([makeSummary("existing", "主用")]);
  const list = remote.list.bind(remote);
  let resolve!: (value: CanvasCatalogListResult) => void;
  remote.list = vi.fn().mockResolvedValueOnce(failed).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  catalog = new CanvasCatalogStore({ remote });
  const navigate = await mount();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTTP 400");
  expect(document.body.textContent).not.toContain("不存在");
  expect(document.body.textContent).not.toContain("还没有画布");
  await act(async () => { button("重试").click(); });
  expect(document.body.textContent).toContain("正在加载画布列表");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect([...document.querySelectorAll("button")].some(item => item.textContent === "重试")).toBe(false);
  await act(async () => { resolve(await list({ offset: 0, limit: 20 })); });
  await act(async () => { button("主用").click(); });
  expect(navigate).toHaveBeenCalledWith({ page: "canvas", canvasId: "existing" });
  expect(selection.setRecentCanvasId).toHaveBeenCalledWith("existing");
});
it("a failed retry remains recoverable and does not navigate or create a canvas", async () => {
  const remote = createFakeCanvasCatalogRemote(); remote.list = vi.fn().mockResolvedValue(failed);
  catalog = new CanvasCatalogStore({ remote }); const navigate = await mount();
  await act(async () => { button("重试").click(); });
  expect(remote.list).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTTP 400");
  expect(button("重试").disabled).toBe(false);
  expect(navigate).not.toHaveBeenCalled(); expect(remote.created).toEqual([]);
});
it("only a successful empty directory shows the empty state and allows creation", async () => {
  const remote = createFakeCanvasCatalogRemote([]); catalog = new CanvasCatalogStore({ remote });
  const navigate = await mount();
  expect(document.body.textContent).toContain("还没有画布");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  await act(async () => { button("新建画布").click(); });
  expect(navigate).toHaveBeenCalledWith({ page: "canvas", canvasId: remote.created[0] });
});
it("pagination failure keeps existing choices and retries the failed page", async () => {
  const remote = createFakeCanvasCatalogRemote([makeSummary("a", "画布甲"), makeSummary("b", "画布乙")]);
  const list = remote.list.bind(remote);
  remote.list = vi.fn().mockImplementationOnce(list).mockResolvedValueOnce(failed).mockImplementation(list);
  catalog = new CanvasCatalogStore({ remote, pageSize: 1 }); await mount();
  await act(async () => { button("加载更多").click(); });
  expect(button("画布甲")).toBeDefined(); expect(document.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => { button("重试").click(); });
  expect(button("画布乙")).toBeDefined(); expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(remote.list).toHaveBeenLastCalledWith({ offset: 1, limit: 1 });
});
