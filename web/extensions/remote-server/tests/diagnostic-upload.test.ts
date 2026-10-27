import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDiagnosticUploader, desktopDiagnosticUploadRoot } from "../src/backend/diagnostic-upload.js";
import type { RemoteSession } from "../src/backend/session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const session: RemoteSession = { serverUrl: "https://server.example", subject: "alice", token: "private-token", displayName: null, expiresAt: 9e15 };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "diagnostic-upload-")); roots.push(root);
  const id = "12345678-1234-4123-8123-123456789abc";
  const dir = path.join(root, id); await mkdir(dir);
  await writeFile(path.join(dir, "archive.tar.gz"), "immutable log bytes");
  await writeFile(path.join(dir, "job.json"), JSON.stringify({ schema: 1, id, serverUrl: session.serverUrl,
    actorHash: createHash("sha256").update(session.subject).digest("hex"), archiveKind: "diagnostics", runId: "run-123", trigger: "manual", createdAt: Date.now(), frontendVersion: "0.1.4" }));
  return { root, dir, id };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
describe("desktop diagnostic upload spool", () => {
  it("uploads immutable bytes without Bearer on PUT, then commits metadata", async () => {
    const { root, dir } = await fixture();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ key: "key", url: "https://objects.example/private", expiresAt: String(Math.floor(Date.now()/1000)+900), maxBytes: "33554432", contentType: "application/octet-stream" }))
      .mockResolvedValueOnce(new Response(null)).mockResolvedValueOnce(json({ id: "42", size: "19" }));
    const uploader = createDiagnosticUploader({ root, session: async () => session, fetchImpl });
    await uploader.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const put = fetchImpl.mock.calls[1][1]!;
    expect(put.method).toBe("PUT"); expect(put.headers).toEqual({ "Content-Type": "application/octet-stream" });
    expect(Buffer.from(put.body as Uint8Array).toString()).toBe("immutable log bytes");
    expect(JSON.parse(fetchImpl.mock.calls[2][1]!.body as string)).toMatchObject({ key: "key", archiveKind: "diagnostics", runId: "run-123", trigger: "manual" });
    expect(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"))).toMatchObject({ status: "complete", recordId: "42" });
    await uploader.tick(); expect(fetchImpl).toHaveBeenCalledTimes(3);
    const descriptor = await readFile(path.join(root, "destination.json"), "utf8");
    expect(descriptor).not.toContain(session.token);
  });
  it("retries commit with the same key after a lost response, without uploading again", async () => {
    const { root, dir } = await fixture(); let now = Date.now();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ key: "same-key", url: "https://objects.example/private", expiresAt: Math.floor(now/1000)+900, maxBytes: 33554432, contentType: "application/octet-stream" }))
      .mockResolvedValueOnce(new Response(null)).mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce(json({ id: "42", size: "19" }));
    const uploader = createDiagnosticUploader({ root, session: async () => session, fetchImpl, now: () => now });
    await uploader.tick(); now += 61_000; await uploader.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(JSON.parse(fetchImpl.mock.calls[3][1]!.body as string).key).toBe("same-key");
    expect(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).status).toBe("complete");
  });
  it("does not send approved bytes to another account or server", async () => {
    const { root } = await fixture(); const fetchImpl = vi.fn<typeof fetch>();
    await createDiagnosticUploader({ root, session: async () => ({ ...session, subject: "bob" }), fetchImpl }).tick();
    await createDiagnosticUploader({ root, session: async () => ({ ...session, serverUrl: "https://other.example" }), fetchImpl }).tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rechecks the account before sending archive bytes", async () => {
    const { root } = await fixture(); let current = session;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      current = { ...session, subject: "bob" };
      return json({ key: "key", url: "https://objects.example/private", expiresAt: Math.floor(Date.now()/1000)+900, maxBytes: 33554432, contentType: "application/octet-stream" });
    });
    await createDiagnosticUploader({ root, session: async () => current, fetchImpl }).tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("does not upload oversized files or follow archive symlinks", async () => {
    const { root, dir } = await fixture();
    const { symlink, unlink, open } = await import("node:fs/promises");
    await unlink(path.join(dir, "archive.tar.gz"));
    await symlink(path.join(dir, "job.json"), path.join(dir, "archive.tar.gz"));
    const fetchImpl = vi.fn<typeof fetch>();
    await createDiagnosticUploader({ root, session: async () => session, fetchImpl }).tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    await rm(path.join(dir, "state.json"), { force: true });
    const file = await open(path.join(dir, "archive.tar.gz"), "w"); await file.truncate(33554433); await file.close();
    await createDiagnosticUploader({ root, session: async () => session, fetchImpl }).tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("keeps the upload spool outside exported/pruned run journals", () => {
    const logs = path.join(tmpdir(), "data", "logs");
    expect(desktopDiagnosticUploadRoot(path.join(logs, "runs", "run-123"))).toBe(path.join(logs, "upload-queue"));
    expect(desktopDiagnosticUploadRoot("relative")).toBeNull();
  });
  it("removes expired approved bytes even while logged out", async () => {
    const { root, dir } = await fixture();
    const job = JSON.parse(await readFile(path.join(dir, "job.json"), "utf8"));
    job.createdAt = Date.now() - 8 * 86400000;
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job));
    const fetchImpl = vi.fn<typeof fetch>();
    await createDiagnosticUploader({ root, session: async () => null, fetchImpl }).tick();
    await expect(readFile(path.join(dir, "archive.tar.gz"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("detects changed snapshots instead of committing bytes from a different archive", async () => {
    const { root, dir } = await fixture(); let now = Date.now();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ key: "same-key", url: "https://objects.example/private", expiresAt: Math.floor(now/1000)+900, maxBytes: 33554432, contentType: "application/octet-stream" }))
      .mockResolvedValueOnce(new Response(null)).mockRejectedValueOnce(new Error("network lost"));
    const uploader = createDiagnosticUploader({ root, session: async () => session, fetchImpl, now: () => now });
    await uploader.tick(); await writeFile(path.join(dir, "archive.tar.gz"), "different snapshot");
    now += 61000; await uploader.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).status).toBe("failed");
  });
  it("coalesces concurrent polls and removes destination when stopped", async () => {
    const { root } = await fixture();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ key: "key", url: "https://objects.example/private", expiresAt: Math.floor(Date.now()/1000)+900, maxBytes: 33554432, contentType: "application/octet-stream" }))
      .mockResolvedValueOnce(new Response(null)).mockResolvedValueOnce(json({ id: "42", size: "19" }));
    const uploader = createDiagnosticUploader({ root, session: async () => session, fetchImpl });
    await Promise.all([uploader.tick(), uploader.tick()]); expect(fetchImpl).toHaveBeenCalledTimes(3);
    await uploader.stop(); await uploader.tick();
    await expect(readFile(path.join(root, "destination.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves private proxy upload URLs under the approved deployment mount", async () => {
    const { root, dir } = await fixture();
    const job = JSON.parse(await readFile(path.join(dir, "job.json"), "utf8"));
    job.serverUrl = "https://server.example/mounted";
    await writeFile(path.join(dir, "job.json"), JSON.stringify(job));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ key: "key", url: "/storage/objects/key?signature=private", expiresAt: Math.floor(Date.now()/1000)+900, maxBytes: 33554432, contentType: "application/octet-stream" }))
      .mockResolvedValueOnce(new Response(null)).mockResolvedValueOnce(json({ id: "42", size: "19" }));
    await createDiagnosticUploader({ root, session: async () => ({ ...session, serverUrl: job.serverUrl }), fetchImpl }).tick();
    expect(fetchImpl.mock.calls[1][0]).toBe("https://server.example/mounted/storage/objects/key?signature=private");
    expect(fetchImpl.mock.calls[1][1]!.headers).toEqual({ "Content-Type": "application/octet-stream" });
  });

  it("refreshes destination independently while a slow PUT is in flight", async () => {
    const { root } = await fixture(); let now = Date.now();
    let releasePut!: () => void;
    const pendingPut = new Promise<Response>(resolve => { releasePut = () => resolve(new Response(null)); });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ key: "key", url: "https://objects.example/private", expiresAt: Math.floor(now/1000)+900, maxBytes: 33554432, contentType: "application/octet-stream" }))
      .mockImplementationOnce(() => pendingPut).mockResolvedValueOnce(json({ id: "42", size: "19" }));
    const uploader = createDiagnosticUploader({ root, session: async () => session, fetchImpl, now: () => now });
    const upload = uploader.tick();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    now += 45000; await uploader.refreshDestination();
    expect(JSON.parse(await readFile(path.join(root, "destination.json"), "utf8")).updatedAt).toBe(now);
    releasePut(); await upload;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

});
