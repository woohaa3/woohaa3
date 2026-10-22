import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeComponentsStore, imageEditorReadiness } from "./runtime-components.js";
afterEach(() => { vi.useRealTimers(); });
const response = (status: string) => new Response(JSON.stringify({ available: true, components: [{ id: "image-editor", status }] }));
it("shares in-flight reads and polls once for all subscribers, then stops", async () => {
  vi.useFakeTimers();
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const store = createRuntimeComponentsStore(fetcher);
  const off = store.subscribe(() => {});
  const off2 = store.subscribe(() => {});
  const first = store.refresh();
  expect(store.refresh()).toBe(first);
  expect(fetcher).toHaveBeenCalledTimes(1);
  finish(response("missing")); await first;
  expect(imageEditorReadiness(store.getSnapshot()).phase).toBe("missing");
  off(); off2();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("distinguishes browser mode, installation, failures and recovery", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ available: false, components: [] })))
    .mockResolvedValueOnce(response("downloading")).mockRejectedValueOnce(new Error("离线"))
    .mockResolvedValueOnce(response("ready"));
  const store = createRuntimeComponentsStore(fetcher);
  expect(imageEditorReadiness(store.getSnapshot()).phase).toBe("loading");
  await store.refresh(); expect(imageEditorReadiness(store.getSnapshot()).phase).toBe("ready");
  await store.refresh(); expect(imageEditorReadiness(store.getSnapshot()).phase).toBe("loading");
  await store.refresh(); expect(imageEditorReadiness(store.getSnapshot())).toMatchObject({ phase: "failed", tip: "离线" });
  await store.refresh(); expect(imageEditorReadiness(store.getSnapshot()).phase).toBe("ready");
});
it("prepares on demand, installs missing editor once, and shares repeated double clicks", async () => {
  vi.useFakeTimers();
  let installed = false, ready = false;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { installed = true; return new Response("{}"); }
    return response(ready ? "ready" : installed ? "downloading" : "missing");
  });
  const store = createRuntimeComponentsStore(fetcher);
  expect(fetcher).not.toHaveBeenCalled();
  const first = store.prepareImageEditor();
  expect(store.prepareImageEditor()).toBe(first);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  ready = true;
  await vi.advanceTimersByTimeAsync(1500);
  await first;
  expect(imageEditorReadiness(store.getSnapshot()).phase).toBe("ready");
  const count = fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetcher).toHaveBeenCalledTimes(count);
});
it("preparation failure stops waiting and permits an explicit retry", async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
    ? new Response(JSON.stringify({ message: "下载源不可用" }), { status: 400 }) : response("missing"));
  const store = createRuntimeComponentsStore(fetcher);
  await expect(store.prepareImageEditor()).rejects.toThrow("下载源不可用");
  await expect(store.prepareImageEditor()).rejects.toThrow("下载源不可用");
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
});
it("browser editor preparation never calls desktop management, even offline", async () => {
  const fetcher = vi.fn(async () => { throw new Error("403"); });
  const store = createRuntimeComponentsStore(fetcher, false);
  const off = store.subscribeImageEditor(() => {});
  await store.prepareImageEditor(); off();
  expect(fetcher).not.toHaveBeenCalled();
});
