import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import { addAppBasePath, type ApplicationBackendHost } from "@woohaa3/contracts";
import type { WorkflowRepository } from "../../state/backend/repository.js";
import { workflowInstance, type WorkflowRun } from "../../state/shared/workflow.js";
import type { Candidate } from "../../authoring/backend/production/stages/publish.js";

export function previewBase(host:ApplicationBackendHost,run:WorkflowRun,revision:number):string {
  return addAppBasePath(host.deployment?.basePath??"/",`/api/extensions/creature-video-assets/preview/${encodeURIComponent(run.canvasId)}/${encodeURIComponent(run.nodeId)}/${run.instanceId}/${revision}/`);
}
export function decoratePreview(host:ApplicationBackendHost,run:WorkflowRun):WorkflowRun {
  const result=structuredClone(run),stage=result.stages["09_publish"],candidate=stage.structured?.candidate as Candidate|undefined;
  if(candidate)stage.artifacts=[{...candidate.bundle,title:"生物运行候选",kind:"text",text:`[打开运行预览](${previewBase(host,run,candidate.revision)}index.html)\n\n[下载完整资产包](${previewBase(host,run,candidate.revision)}bundle.zip)`}];
  return result;
}
/** Authenticated reads are confined to this node's durable candidate manifest. */
export function registerPreviewResources(host:ApplicationBackendHost,repository:WorkflowRepository):void {
  host.registerRawHttpHandler?.({route:"creature-video-assets/preview/*",method:"GET",auth:"authenticated",purpose:"read",async handle(req,res,context){
    try{
      const url=new URL(req.url??"/","http://local"),match=/\/preview\/([^/]+)\/([^/]+)\/([\w-]{8,128})\/(\d+)\/([^/]+)$/.exec(url.pathname);
      if(!match||!context.principal||!host.services.canvasAccess||!host.services.extensionNodes)throw Error();
      const canvasId=decodeURIComponent(match[1]),nodeId=decodeURIComponent(match[2]),instanceId=match[3],revision=Number(match[4]),name=decodeURIComponent(match[5]);
      const auth=await host.services.canvasAccess.authorize({subject:context.principal.subject,canvasId,permission:"read"});if(!auth.ok)throw Error();
      const canvas=await host.services.extensionNodes.read({subject:context.principal.subject,canvasId,permission:"read"});if(workflowInstance(canvas.nodeData[nodeId])!==instanceId)throw Error();
      const run=await repository.read(canvasId,nodeId,instanceId),stage=run.stages["09_publish"],snapshot=[stage,...stage.history].find(s=>s.revision===revision);
      const candidate=snapshot?.structured?.candidate as Candidate|undefined;if(!candidate||candidate.revision!==revision)throw Error();
      const artifact=name==="bundle.zip"?candidate.bundle:candidate.files[name];if(!artifact?.storageKey)throw Error();
      const source=await host.services.media.resources?.openRead?.(artifact.storageKey, canvasId);if(!source)throw Error();
      res.writeHead(200,{"Content-Type":source.contentType,"Content-Length":String(source.size),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",...(name==="bundle.zip"?{"Content-Disposition":"attachment; filename=creature-bundle.zip"}:{}),...(name==="index.html"?{"Content-Security-Policy":"sandbox allow-scripts allow-same-origin; default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"}:{})});
      try{await pipeline(Readable.from(source.bytes),res as unknown as ServerResponse,{signal:context.signal});}finally{source.cancel();}
    }catch{if(!res.headersSent){res.writeHead(404,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"});res.end("资产不存在或无权访问。");}else if(!res.writableEnded)res.end();}
  }});
}
