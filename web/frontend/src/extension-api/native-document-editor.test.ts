import { expect, it, vi } from "vitest";
import { nativeDocumentEditorClient } from "./native-document-editor.js";
function host(platform = "macos") {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, value: { providers: [], gpu_ready: true, workspace_open: false } }) }));
  return { fetch, __WOOHAA_NATIVE__: { token: "local-only", protocol: "woohaa-native-v1", platform } } as unknown as typeof globalThis;
}
it("does not register or contact a provider in a browser", () => {
  const fetch = vi.fn(); expect(nativeDocumentEditorClient({ fetch } as unknown as typeof globalThis)).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
it("uses authenticated async desktop RPC and keeps empty registry unavailable", async () => {
  const target = host("windows"), client = nativeDocumentEditorClient(target)!;
  expect((await client.capabilities()).providers).toEqual([]);
  expect(target.fetch).toHaveBeenCalledWith("http://woohaa-native.localhost/editor-rpc", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "X-Woohaa-Token": "local-only" }) }));
});
it("propagates refusal and never implicitly acknowledges a receipt", async () => {
  const target = host(); vi.mocked(target.fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, error: "workspace busy" }) } as Response);
  await expect(nativeDocumentEditorClient(target)!.create({ provider_id: "test", session_id: "a", generation: 1, project_protocol: 1, browser_protocol: 1, capabilities: [], physical_size: [100, 100], scale_factor: 1 })).rejects.toThrow("workspace busy");
  expect(target.fetch).toHaveBeenCalledTimes(1);
  await expect(nativeDocumentEditorClient(target)!.acknowledge(-1)).rejects.toThrow("Invalid native receipt");
});
it("batches input using the native input wire format and rejects oversized batches before dispatch", async () => {
  const target = host(), client = nativeDocumentEditorClient(target)!;
  const input = { sequence: 1, layout_generation: 2, time_seconds: 1, event: { kind: "blur" as const } };
  await client.input([input]);
  const body = JSON.parse(vi.mocked(target.fetch).mock.calls[0]![1]!.body as string);
  expect(body.method).toBe("document_editor_input"); expect(JSON.parse(body.args[0])).toEqual([input]);
  await expect(client.input(Array.from({ length: 257 }, () => input))).rejects.toThrow("256");
  expect(target.fetch).toHaveBeenCalledTimes(1);
});
it("transfers open/export bytes through authenticated binary tickets", async () => {
  const target = host("windows"), client = nativeDocumentEditorClient(target)!;
  const source = Uint8Array.of(137, 80, 78, 71);
  vi.mocked(target.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, value: { ticket: "input-ticket" } }), { headers: { "Content-Type": "application/json" } }));
  expect(await client.upload(source)).toBe("input-ticket");
  expect(vi.mocked(target.fetch).mock.calls[0]![0]).toBe("http://woohaa-native.localhost/editor-blob");
  expect(vi.mocked(target.fetch).mock.calls[0]![1]!.body).toBe(source);
  vi.mocked(target.fetch).mockResolvedValueOnce(new Response(Uint8Array.of(1, 2, 3), { headers: { "Content-Type": "application/octet-stream" } }));
  expect(await client.exportBytes({ kind: "exported", bytes_blob_id: "output-ticket", revision: 2 })).toEqual(Uint8Array.of(1, 2, 3));
  expect(vi.mocked(target.fetch).mock.calls[1]![0]).toBe("http://woohaa-native.localhost/editor-blob?id=output-ticket");
  expect(vi.mocked(target.fetch).mock.calls[1]![1]!.headers).toEqual({ "X-Woohaa-Token": "local-only" });
  vi.mocked(target.fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  await client.discardUpload("input-ticket");
  expect(vi.mocked(target.fetch).mock.calls[2]![1]!.method).toBe("DELETE");
});
it("refuses binary budgets before allocating a decoded response", async () => {
  const target = host(), client = nativeDocumentEditorClient(target)!;
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
  vi.mocked(target.fetch).mockResolvedValueOnce({ ok: true, headers: new Headers({ "Content-Length": String(64 * 1024 * 1024 + 1) }), arrayBuffer } as unknown as Response);
  await expect(client.download("oversized")).rejects.toThrow("64 MiB"); expect(arrayBuffer).not.toHaveBeenCalled();
});
