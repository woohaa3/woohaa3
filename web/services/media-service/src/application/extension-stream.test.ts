import { afterEach, expect, it, vi } from "vitest";
import type { MediaObject, MediaStorage } from "@woohaa3/contracts";
import { createExtensionMediaResources } from "./extension-resources.js";

function harness(){
  const objects=new Map<string,MediaObject>();
  const storage:MediaStorage={exists:async key=>objects.has(key),get:vi.fn(async key=>objects.get(key)!),put:vi.fn(),stat:async key=>({size:objects.get(key)!.bytes.length,contentType:objects.get(key)!.contentType}),
    openRead:async key=>({bytes:(async function*(){yield objects.get(key)!.bytes;})(),cancel:vi.fn()}),
    putStream:vi.fn(async(key,source,contentType,options)=>{const chunks:Buffer[]=[];let size=0;for await(const chunk of source){options.signal?.throwIfAborted();chunks.push(Buffer.from(chunk));size+=chunk.length;}expect(size).toBe(options.size);objects.set(key,{bytes:Buffer.concat(chunks),contentType});})};
  return {storage,objects,resources:createExtensionMediaResources(storage)};
}
afterEach(()=>vi.restoreAllMocks());
it("routes streaming reads and writes to the declared canvas and rejects invalid scope before consuming input",async()=>{
  const h=harness(),scope={canvasId:"canvas-stream"};
  const stat=vi.spyOn(h.storage,"stat"),openRead=vi.spyOn(h.storage,"openRead");
  const result=await h.resources.writeStream!({bytes:(async function*(){yield new Uint8Array([1,2,3]);})(),contentType:"application/zip",canvasId:scope.canvasId});
  expect(h.storage.putStream).toHaveBeenCalledWith(result.storageKey,expect.anything(),"application/zip",expect.objectContaining({size:3}),scope);
  const read=await h.resources.openRead!(result.storageKey,scope.canvasId);for await(const _chunk of read.bytes){}read.cancel();
  expect(stat).toHaveBeenCalledWith(result.storageKey,scope);
  expect(openRead).toHaveBeenCalledWith(result.storageKey,undefined,scope);
  const consume=vi.fn();
  await expect(h.resources.writeStream!({bytes:(async function*(){consume();yield new Uint8Array([1]);})(),contentType:"application/zip",canvasId:"../escape"})).rejects.toMatchObject({code:"malformed-request"});
  expect(consume).not.toHaveBeenCalled();
});
it("streams >16 MiB with a stable hash and metadata, without the small-resource get/put path",async()=>{
  const h=harness(),size=17*1024**2,chunk=new Uint8Array(1024**2).fill(71);
  async function* source(){for(let i=0;i<17;i++)yield chunk;}
  const result=await h.resources.writeStream!({bytes:source(),contentType:"application/zip"});
  expect(result.size).toBe(size);expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);expect(h.storage.get).not.toHaveBeenCalled();expect(h.storage.put).not.toHaveBeenCalled();
  const again=await h.resources.writeStream!({bytes:source(),contentType:"application/zip"});expect(again).toEqual(result);expect(h.storage.putStream).toHaveBeenCalledOnce();
  const read=await h.resources.openRead!(result.storageKey);let actual=0;for await(const bytes of read.bytes)actual+=bytes.length;read.cancel();expect(actual).toBe(size);
  await expect(h.resources.read(result.storageKey)).rejects.toMatchObject({code:"limit-exceeded"});expect(h.storage.get).not.toHaveBeenCalled();
  await expect(h.resources.writeStream!({bytes:source(),contentType:"video/mp4"})).rejects.toMatchObject({code:"content-type-conflict"});
});
it("concurrent uploads of identical bytes cannot overwrite a committed content type",async()=>{
  const h=harness(),other=createExtensionMediaResources(h.storage),source=()=> (async function*(){yield new Uint8Array(1024).fill(42);})();
  const results=await Promise.allSettled([h.resources.writeStream!({bytes:source(),contentType:"video/mp4"}),other.writeStream!({bytes:source(),contentType:"application/zip"})]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);expect(h.storage.putStream).toHaveBeenCalledOnce();
});
it("never publishes a partial, oversized or aborted source; the transfer slot is released",async()=>{
  const h=harness();
  async function* broken(){yield new Uint8Array(1024);throw Error("disconnected");}
  await expect(h.resources.writeStream!({bytes:broken(),contentType:"video/mp4"})).rejects.toThrow("disconnected");
  await expect(h.resources.writeStream!({bytes:(async function*(){yield new Uint8Array(2048);})(),contentType:"video/mp4",maxBytes:1024})).rejects.toMatchObject({code:"limit-exceeded"});
  const controller=new AbortController();
  await expect(h.resources.writeStream!({bytes:(async function*(){yield new Uint8Array(1024);controller.abort();yield new Uint8Array(1024);})(),contentType:"video/mp4",signal:controller.signal})).rejects.toThrow();
  expect(h.objects.size).toBe(0);expect(h.storage.putStream).not.toHaveBeenCalled();
  await h.resources.writeStream!({bytes:(async function*(){yield new Uint8Array(1024);})(),contentType:"video/mp4"});expect(h.objects.size).toBe(1);
});
