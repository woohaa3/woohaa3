import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import type { ApplicationBackendHost } from "@woohaa3/contracts";
import { registerPreviewResources, previewBase } from "../src/preview/backend/resources.js";
import { WorkflowRepository } from "../src/state/backend/repository.js";
import { memoryDocuments } from "./memory-documents.js";

it("preview route matches the extension mapping and serves only authorized candidate files",async()=>{
  const repository=new WorkflowRepository(memoryDocuments()),run=await repository.read("canvas","node","instance-preview");
  const artifact={id:"html",title:"preview",kind:"web" as const,storageKey:"stable-html"};
  run.stages["09_publish"].revision=1;run.stages["09_publish"].structured={candidate:{revision:1,bundle:artifact,files:{"index.html":artifact}}};await repository.save(run);
  let handler!:Parameters<NonNullable<ApplicationBackendHost["registerRawHttpHandler"]>>[0];
  const bytes=Buffer.from("<!doctype html><title>preview</title>"),cancel=vi.fn(),authorize=vi.fn(async()=>({ok:true}));
  const host={registerRawHttpHandler:(value:typeof handler)=>{handler=value;},services:{canvasAccess:{authorize},extensionNodes:{read:async()=>({nodeData:{node:{extensionId:"creature-video-assets",extensionContentRef:{schemaVersion:1,instanceId:run.instanceId}}}})},media:{resources:{openRead:async(key:string)=>{expect(key).toBe("stable-html");return {size:bytes.length,contentType:"text/html",bytes:(async function*(){yield bytes;})(),cancel};}}}}} as unknown as ApplicationBackendHost;
  registerPreviewResources(host,repository);
  const descriptor=JSON.parse(await readFile(new URL("../extension.json",import.meta.url),"utf8"));
  expect(handler.route).toBe(descriptor.publicRoutes[0].route+"/*");expect(handler.auth).toBe("authenticated");
  const server=createServer((req,res)=>{void handler.handle(req as never,res as never,{principal:{subject:"user"}} as never);});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  try{
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`+previewBase(host,run,1);
    const response=await fetch(base+"index.html");expect(response.status).toBe(200);expect(await response.text()).toBe(bytes.toString());expect(response.headers.get("content-security-policy")).toContain("sandbox");expect(cancel).toHaveBeenCalledOnce();
    const missing=await fetch(base+"private.json");expect(missing.status).toBe(404);await missing.text();
    authorize.mockResolvedValue({ok:false});const denied=await fetch(base+"index.html");expect(denied.status).toBe(404);await denied.text();expect(cancel).toHaveBeenCalledOnce();
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
