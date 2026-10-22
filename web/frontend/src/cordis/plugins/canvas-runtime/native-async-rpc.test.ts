import { afterEach, expect, it, vi } from "vitest";
import { createNativeAsyncRpc } from "./native-async-rpc.js";
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const requests: Xhr[] = [];
  class Xhr {
    open = vi.fn(); setRequestHeader = vi.fn(); send = vi.fn();
    timeout = 0; status = 200; responseText = '{"ok":true,"value":"diagnostics"}';
    onload = () => {}; onloadend = () => {}; ontimeout = () => {}; onabort = () => {};
    abort = vi.fn(() => { this.onabort(); this.onloadend(); });
    constructor() { requests.push(this); }
  }
  vi.stubGlobal("XMLHttpRequest", Xhr);
  return { requests, rpc: createNativeAsyncRpc(globalThis, "token") };
}
it("uses asynchronous IPC and rejects timeout/disposal without leaving callers waiting", async () => {
  const { rpc, requests } = setup();
  const first = rpc.call("canvas_work_diagnostics");
  expect(requests[0].open).toHaveBeenCalledWith("POST", "woohaa-native://localhost/rpc", true);
  requests[0].onload(); requests[0].onloadend();
  await expect(first).resolves.toBe("diagnostics");
  const timeout = rpc.call("canvas_work_diagnostics");
  const timedOut = expect(timeout).rejects.toThrow("unavailable");
  requests[1].ontimeout(); requests[1].onloadend(); await timedOut;
  const pending = rpc.call("canvas_work_diagnostics");
  const aborted = expect(pending).rejects.toThrow("unavailable");
  rpc.dispose(); await aborted;
  expect(requests[2].abort).toHaveBeenCalledOnce();
  await expect(rpc.call("canvas_work_diagnostics")).rejects.toThrow("disposed");
});
it("携带有界参数，并支持取消单个请求", async () => {
  const { rpc, requests } = setup(); const abort = new AbortController();
  const pending = rpc.call("set_viewport_sequenced", ["viewport-json", 3], abort.signal);
  expect(requests[0].send).toHaveBeenCalledWith(JSON.stringify({ method: "set_viewport_sequenced", args: ["viewport-json", 3] }));
  const failed = expect(pending).rejects.toThrow("unavailable");
  abort.abort(); await failed;
  await expect(rpc.call("set_viewport_sequenced", [], abort.signal)).rejects.toThrow("cancelled");
  expect(requests).toHaveLength(1); rpc.dispose();
});
