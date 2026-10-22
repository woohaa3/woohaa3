import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { ApplicationBackendHost } from "@woohaa3/contracts";
import { WorkflowError, type Operation } from "../../../../state/shared/workflow.js";
import { setOutputState } from "../../output-jobs.js";
import type { ExecutionContext } from "../../service.js";

const artifactSchema = z.object({name:z.string(),url:z.string(),media_type:z.string().optional()});
const taskSchema = z.object({state:z.enum(["queued","preparing","waiting_gpu","running","uploading","succeeded","failed","cancelled","cancelling"]),artifacts:z.array(artifactSchema).optional()});
export type GpuArtifact = z.infer<typeof artifactSchema>;
export type GpuOptions = {baseUrl:string;token:string;fetch?:typeof fetch;pollMs?:number};
const hash = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function gpuOptions(host:ApplicationBackendHost):GpuOptions {
  const config = host.config.values().gpu as {baseUrl?:string;secretOwner?:string} | undefined;
  const token = host.services.secrets?.read<{token:string}>(config?.secretOwner ?? "system","gpu")?.value.token ?? process.env.WOOHAA_CREATURE_GPU_TOKEN;
  if (!token) throw new WorkflowError("gpu-not-configured","请为生物资产扩展配置 GPU 服务凭据。");
  return {baseUrl:config?.baseUrl ?? "http://9.135.14.44:8800",token};
}
/** SAM3 / VideoMaMa / Cosmos share the source project's v1 Task Server protocol. */
export class GpuClient {
  private readonly base:URL;
  constructor(private readonly options:GpuOptions) { this.base = new URL(options.baseUrl); if (!/^https?:$/.test(this.base.protocol) || this.base.username || this.base.password) throw new WorkflowError("invalid-gpu-url","GPU 服务地址非法。"); }
  private url(path:string):URL {
    const url = new URL(path,this.base);
    if (url.origin !== this.base.origin) throw new WorkflowError("invalid-artifact-origin","GPU 产物地址不属于配置的服务。");
    return url;
  }
  private async request(path:string,init:RequestInit={},timeout=60_000):Promise<Response> {
    const response = await (this.options.fetch ?? fetch)(this.url(path),{...init,redirect:"error",headers:{Authorization:`Bearer ${this.options.token}`,...init.headers},signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)});
    if (!response.ok) throw new WorkflowError(response.status>=500?"remote-unavailable":"remote-rejected",`GPU 服务返回 HTTP ${response.status}。`);
    return response;
  }
  async upload(file:string,contentType:string):Promise<string> {
    const source = createReadStream(file), size = (await stat(file)).size;
    if (size>2*1024**3) throw new WorkflowError("media-limit","GPU 输入超过上限。");
    try {
      const res = await this.request("/v1/assets",{method:"POST",headers:{"Content-Type":contentType,"Content-Length":String(size),"X-Filename":contentType.startsWith("video/")?"input.mp4":"input.png"},body:source as unknown as BodyInit,duplex:"half"} as RequestInit,30*60_000);
      const value = z.object({asset_id:z.string().regex(/^asset_[a-f0-9]{16,}$/)}).parse(await res.json()); return value.asset_id;
    } finally {source.destroy();}
  }
  async execute(context:ExecutionContext,label:string,payload:Record<string,unknown>):Promise<GpuArtifact[]> {
    const stage = context.run.stages[context.stageId], key = `gpu-${hash([context.run.canvasId,context.run.nodeId,context.run.instanceId,context.stageId,stage.revision,label,...(stage.outputAttempts?.[context.outputKey ?? "main"] ? [stage.outputAttempts[context.outputKey ?? "main"]] : [])])}`;
    let op = stage.operations.find(o=>o.key===key);
    if (op?.state === "succeeded" && op.remoteArtifacts) return op.remoteArtifacts;
    if (!op) {op = {key,outputKey:context.outputKey,modelKey:String(payload.task_type),state:"prepared",executorVersion:"gpu-task-v1",inputDigest:hash(payload)} satisfies Operation;stage.operations.push(op);await context.checkpoint();}
    if (op.state === "unknown" && !op.remoteRef) throw new WorkflowError("submit-unknown",`GPU 任务受理结果待核对（${key}），不会自动重发。`);
    if (op.state === "failed") throw new WorkflowError("remote-failed","GPU 任务已失败，请重新执行创建新候选。");
    if (op.state === "prepared") {
      await context.assertCurrent(); op.state="unknown"; await context.checkpoint();
      try {
        const res = await this.request("/v1/tasks",{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":key,"X-Request-ID":key},body:JSON.stringify(payload)});
        op.remoteRef = z.object({task_id:z.string().min(1)}).parse(await res.json()).task_id;op.state="submitted";await context.checkpoint();
      } catch (error) {
        if (error instanceof WorkflowError && error.code === "remote-rejected") {op.state="failed";await context.checkpoint();throw error;}
        throw new WorkflowError("submit-unknown",`GPU 任务受理结果待核对（${key}），不会重复提交。`);
      }
    }
    const deadline = Date.now()+26*60*60_000;
    while (!context.isStopped() && Date.now()<deadline) {
      await context.assertCurrent();
      let state:z.infer<typeof taskSchema>;
      try { state = taskSchema.parse(await (await this.request(`/v1/tasks/${encodeURIComponent(op.remoteRef!)}`)).json()); }
      catch { throw new WorkflowError("submit-unknown","GPU 任务查询暂时中断；原任务可能仍在运行，请核对恢复。"); }
      await setOutputState(context, ["queued","waiting_gpu"].includes(state.state) ? "queued" : state.state === "running" ? "running" : "processing");
      if (state.state === "failed" || state.state === "cancelled") {op.state="failed";await context.checkpoint();throw new WorkflowError("remote-failed","GPU 制作任务失败，成功产物已保留。");}
      if (state.state === "succeeded") {op.remoteArtifacts=state.artifacts??[];op.state="succeeded";await context.checkpoint();return op.remoteArtifacts;}
      await new Promise(resolve=>setTimeout(resolve,this.options.pollMs??15_000));
    }
    if (context.isStopped()) throw new WorkflowError("executor-stopped","扩展已暂停，原任务可恢复查询。");
    throw new WorkflowError("submit-unknown","本地等待超时，原 GPU 任务可能仍在运行。");
  }
  async download(artifact:GpuArtifact,file:string):Promise<void> {
    const response = await this.request(artifact.url,{},30*60_000);
    if (!response.body) throw new WorkflowError("empty-download","GPU 产物缺少内容。");
    let bytes = 0; const reader = response.body.getReader();
    try {await pipeline(Readable.from((async function*(){for (;;) {const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>2*1024**3)throw new WorkflowError("media-limit","GPU 产物超过上限。");yield part.value;}})()),createWriteStream(file,{flags:"wx"}));}
    finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async cancel(remoteRef:string):Promise<void> {await this.request(`/v1/tasks/${encodeURIComponent(remoteRef)}/cancel`,{method:"POST"});}
}
