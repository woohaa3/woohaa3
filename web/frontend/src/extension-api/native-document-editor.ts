import type { NativeEditorCapabilities, NativeEditorCreate, NativeEditorRequest, NativeEditorSnapshot, NativeEditorInput, NativeEditorLayout, NativeEditorResult } from "@woohaa3/contracts";
import { nativeProtocolUrl } from "../desktop/native-protocol.js";

export type NativeDocumentEditorClient = {
  capabilities(signal?: AbortSignal): Promise<NativeEditorCapabilities>;
  upload(bytes: Uint8Array, signal?: AbortSignal): Promise<string>;
  discardUpload(ticket: string, signal?: AbortSignal): Promise<void>;
  download(ticket: string, signal?: AbortSignal): Promise<Uint8Array>;
  exportBytes(result: Extract<NativeEditorResult, { kind: "exported" }>, signal?: AbortSignal): Promise<Uint8Array>;
  create(request: NativeEditorCreate, signal?: AbortSignal): Promise<void>;
  enqueue(request: NativeEditorRequest, signal?: AbortSignal): Promise<void>;
  input(events: readonly NativeEditorInput[], signal?: AbortSignal): Promise<void>;
  layout(layout: NativeEditorLayout, signal?: AbortSignal): Promise<void>;
  poll(signal?: AbortSignal): Promise<NativeEditorSnapshot>;
  acknowledge(requestId: number, signal?: AbortSignal): Promise<boolean>;
  shutdown(signal?: AbortSignal): Promise<void>;
};

/** Missing capability means WASM fallback; this function never chooses a provider. */
export function nativeDocumentEditorClient(target: typeof globalThis = globalThis): NativeDocumentEditorClient | null {
  const bootstrap = (target as typeof globalThis & { __WOOHAA_NATIVE__?: { token?: string; protocol?: string } }).__WOOHAA_NATIVE__;
  if (bootstrap?.protocol !== "woohaa-native-v1" || !bootstrap.token) return null;
  const token = bootstrap.token;
  async function call<T>(method: string, argument?: unknown, signal?: AbortSignal): Promise<T> {
    const body = JSON.stringify({ method: `document_editor_${method}`, args: argument === undefined ? [] : [JSON.stringify(argument)] });
    if (new TextEncoder().encode(body).length > 16 * 1024 * 1024) throw new Error("Native editor control exceeds transport budget");
    const response = await target.fetch(nativeProtocolUrl("editor-rpc", target), {
      method: "POST", headers: { "Content-Type": "application/json", "X-Woohaa-Token": token }, body, signal,
    });
    if (!response.ok) throw new Error(`Native editor transport failed (${response.status})`);
    const envelope = await response.json() as { ok: boolean; value?: T; error?: string };
    if (!envelope.ok) throw new Error(envelope.error || "Native editor request failed");
    return envelope.value as T;
  }
  const binaryBudget = 64 * 1024 * 1024;
  async function upload(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    if (bytes.byteLength > binaryBudget) throw new Error("Native editor upload exceeds 64 MiB");
    const response = await target.fetch(nativeProtocolUrl("editor-blob", target), {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Woohaa-Token": token }, body: bytes as BodyInit, signal,
    });
    const envelope = await response.json() as { ok: boolean; value?: { ticket: string }; error?: string };
    if (!response.ok || !envelope.ok || !envelope.value?.ticket) throw new Error(envelope.error || "Native editor upload failed");
    return envelope.value.ticket;
  }
  async function download(ticket: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!ticket || ticket.length > 256) throw new Error("Invalid native editor download ticket");
    const response = await target.fetch(`${nativeProtocolUrl("editor-blob", target)}?id=${encodeURIComponent(ticket)}`, {
      method: "GET", headers: { "X-Woohaa-Token": token }, signal,
    });
    if (!response.ok) throw new Error(`Native editor download failed (${response.status})`);
    if (response.headers.get("Content-Type")?.includes("application/json")) {
      const failure = await response.json() as { error?: string };
      throw new Error(failure.error || "Native editor download failed");
    }
    const length = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(length) && length > binaryBudget) throw new Error("Native editor download exceeds 64 MiB");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > binaryBudget) throw new Error("Native editor download exceeds 64 MiB");
    return bytes;
  }
  return {
    upload, download,
    discardUpload: async (ticket, signal) => {
      if (!ticket || ticket.length > 256) throw new Error("Invalid native editor upload ticket");
      const response = await target.fetch(`${nativeProtocolUrl("editor-blob", target)}?id=${encodeURIComponent(ticket)}`, { method: "DELETE", headers: { "X-Woohaa-Token": token }, signal });
      const result = await response.json() as { ok: boolean; error?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "Native editor upload release failed");
    },
    exportBytes: async (result, signal) => {
      if (result.bytes_blob_id) return download(result.bytes_blob_id, signal);
      if (!result.bytes) throw new Error("Native editor export has no byte payload");
      if (result.bytes.length > binaryBudget) throw new Error("Native editor export exceeds 64 MiB");
      return Uint8Array.from(result.bytes);
    },
    capabilities: signal => call("capabilities", undefined, signal),
    create: async (request, signal) => { await call("create", request, signal); },
    enqueue: async (request, signal) => { await call("enqueue", request, signal); },
    input: async (events, signal) => {
      if (events.length > 256) throw new Error("Native editor input batch exceeds 256 events");
      if (events.length) await call("input", events, signal);
    },
    layout: async (layout, signal) => { await call("layout", layout, signal); },
    poll: signal => call("poll", undefined, signal),
    acknowledge: async (requestId, signal) => {
      if (!Number.isSafeInteger(requestId) || requestId < 1) throw new Error("Invalid native receipt ID");
      return (await call<{ ok: boolean }>("ack", requestId, signal)).ok;
    },
    shutdown: async signal => { await call("shutdown", undefined, signal); },
  };
}
