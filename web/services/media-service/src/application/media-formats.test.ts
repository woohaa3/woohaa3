import { expect, it, vi } from "vitest";
import { createMediaFormatRegistry } from "./media-formats.js";
import { ingestMediaObject } from "./ingest.js";
import type { MediaStorage } from "@woohaa3/contracts";
const contentType = "application/vnd.fixture-project";
it("format ownership survives stale disposal and rejects built-in types", () => {
  const registry = createMediaFormatRegistry();
  const format = { contentType, maxBytes: 4, validate: async () => {} };
  const dispose = registry.register(format);
  expect(() => registry.register(format)).toThrow("already registered");
  dispose();
  const next = registry.register(format);
  dispose();
  expect(registry.get(contentType)).toBeDefined();
  next();
  expect(registry.get(contentType)).toBeUndefined();
  for (const type of ["application/json", "application/octet-stream", "image/png"]) {
    expect(() => registry.register({ ...format, contentType: type })).toThrow();
  }
});
it("uninstalled, oversized and invalid formats cannot write; valid custom formats can", async () => {
  const formats = createMediaFormatRegistry();
  const put = vi.fn(), exists = vi.fn(async () => false);
  const storage = { put, exists } as unknown as MediaStorage;
  const options = { storage, formats, contentType, bytes: new Uint8Array([1, 2]), projectIngest: true };
  await expect(ingestMediaObject(options)).rejects.toMatchObject({ code: "unsupported-media-type" });
  const validate = vi.fn(async () => { throw new Error("invalid archive"); });
  const dispose = formats.register({ contentType, maxBytes: 2, validate });
  await expect(ingestMediaObject({ ...options, bytes: new Uint8Array(3) })).rejects.toMatchObject({ code: "payload-too-large" });
  await expect(ingestMediaObject({ ...options, projectIngest: false })).rejects.toMatchObject({ code: "project-requires-verification" });
  await expect(ingestMediaObject({ ...options, projectIngest: false, allowedTypes: [contentType] })).rejects.toMatchObject({ code: "project-requires-verification" });
  await expect(ingestMediaObject(options)).rejects.toMatchObject({ code: "project-verification-failed" });
  expect(put).not.toHaveBeenCalled(); expect(exists).not.toHaveBeenCalled();
  dispose(); formats.register({ contentType, maxBytes: 2, validate: async () => {} });
  await expect(ingestMediaObject(options)).resolves.toMatchObject({ contentType, size: 2 });
  expect(put).toHaveBeenCalledOnce();
});
it('accepts bounded motion NPZ objects through ordinary media ingest',async()=>{
 const put=vi.fn();const storage={put,exists:async()=>false} as unknown as MediaStorage;
 const result=await ingestMediaObject({storage,contentType:'application/x-npz',bytes:new Uint8Array([80,75,3,4]),maxBytes:32*1024*1024});
 expect(result.contentType).toBe('application/x-npz');expect(put).toHaveBeenCalledOnce();
});
