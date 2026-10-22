import { z } from "zod";
import type { ApplicationBackendExtensionDefinition, ServerCanvas } from "@woohaa3/contracts";
import { WorkflowRepository } from "../../state/backend/repository.js";
import { WorkflowService } from "../../authoring/backend/service.js";
import { createTaskExecutor } from "../../authoring/backend/task-executor.js";
import { createProductionBridge } from "../../authoring/backend/production-bridge.js";
import { DEFAULT_PRODUCTION_PROFILE } from "../../authoring/backend/production-profile.js";
import { decoratePreview, registerPreviewResources } from "../../preview/backend/resources.js";
import { GpuClient, gpuOptions } from "../../authoring/backend/production/providers/gpu.js";
import { STAGE_IDS, DIRECTION_IDS } from "../../state/shared/creature/ids.js";
import { EXTENSION_ID } from "../../state/shared/recipe.js";
import { WorkflowError, workflowInstance, type StageInput, type WorkflowRun } from "../../state/shared/workflow.js";
const identitySchema = z.object({ canvasId: z.string().min(1).max(200), nodeId: z.string().min(1).max(200), instanceId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) });
const referenceSchema = z.object({ sourceNodeId: z.string().min(1).max(200), assetId: z.string().min(1).max(500), storageKey: z.string().min(1).max(1000), checksum: z.string().min(1).max(200), contentType: z.string().max(100).startsWith("image/"), size: z.number().int().nonnegative(), title: z.string().max(500) }).strict();
const stageInputSchema = z.object({ prompt: z.string().max(16000), modelKey: z.string().max(500), reviewModelKey: z.string().max(500), directions: z.array(z.enum(DIRECTION_IDS)).min(1).max(8), mirrorDecision: z.enum(["accepted_semantic_mirroring", "promoted_all_to_master"]), referenceImages: z.array(referenceSchema).max(8), outputPrompts: z.record(z.string().max(200), z.string().max(16000)), outputModels: z.record(z.string().max(200), z.string().max(500)) }).strict();
const versionSchema = z.number().int().min(0);
const startSchema = identitySchema.extend({ expectedVersion: versionSchema, stageId: z.enum(STAGE_IDS), input: stageInputSchema, outputKey: z.string().min(1).max(200).optional() });
const approveSchema = identitySchema.extend({ expectedVersion: versionSchema, stageId: z.enum(STAGE_IDS), revision: z.number().int().positive(), gate: z.enum(["stage-output", "pilot", "batch"]), accepted: z.array(z.boolean()).max(12) });

function assertNode(canvas: ServerCanvas, nodeId: string, instanceId: string): void {
  if (!canvas.document.nodes.some(node => node.id === nodeId && node.type === "composite-asset") || workflowInstance(canvas.nodeData[nodeId]) !== instanceId) throw new WorkflowError("node-conflict", "制作节点已删除或内容关联已改变。");
}
export function createCreatureVideoAssetsBackendDefinition(): ApplicationBackendExtensionDefinition {
  return {
    extensionId: EXTENSION_ID,
    capabilities: [{ id: `${EXTENSION_ID}.workflow`, kind: "capability", description: "八步制作与逐版本验收" }],
    activate(host) {
      const { services } = host;
      if (!services.documents) throw new Error("生物资产制作需要扩展文档存储。");
      const repository = new WorkflowRepository(services.documents);
      const assertCurrent = async (run: WorkflowRun) => {
        if (!services.extensionNodes || !run.execution?.subject) throw new WorkflowError("authorization-unavailable", "无法验证制作节点归属。");
        const canvas = await services.extensionNodes.read({ subject: run.execution.subject, canvasId: run.canvasId, permission: "write" });
        assertNode(canvas, run.nodeId, run.instanceId);
      };
      const service = new WorkflowService(repository, createTaskExecutor(services, createProductionBridge(host)), { assertCurrent, settled: (run, state) => { if (run.execution) host.work.resume(run.execution.workId)?.settle(state); }, log: event => host.logger({ module: EXTENSION_ID, ...event }) });
      registerPreviewResources(host,repository);
      host.registerHandler({route:"gpu-credentials",auth:"authenticated",requiredActions:["extensions.configure"],purpose:"work-control",async handle({body}){
        const input=z.object({token:z.string().min(16).max(8192),expectedVersion:z.number().int().nonnegative()}).safeParse(body);
        if(!input.success||!services.secrets)return {status:400,body:{ok:false,code:"invalid-input"}};
        const owner=(host.config.values().gpu as {secretOwner?:string}|undefined)?.secretOwner??"system";
        const result=services.secrets.write(owner,"gpu",{token:input.data.token},{version:input.data.expectedVersion});
        return {status:result.ok?200:409,body:result.ok?{ok:true,configured:true,version:result.version}:{ok:false,code:result.code}};
      }});
      host.registerResource({ id: `${EXTENSION_ID}.recovery`, start: () => service.recover(), stop: () => service.stop() });
      for (const route of ["status", "start", "approve", "reconcile", "rollback", "cancel"] as const) host.registerHandler({
        route, auth: "authenticated", purpose: route === "start" ? "new-work" : route === "status" ? "read" : "work-control",
        async handle({ body, context }) {
          try {
            const identity = identitySchema.parse(body), subject = context.principal?.subject;
            if (!subject) return { status: 401, body: { ok: false, code: "unauthorized", message: "缺少可信用户身份。" } };
            if (!services.canvasAccess || !services.extensionNodes) throw new WorkflowError("authorization-unavailable", "宿主未提供画布授权与读取能力。");
            const permission = route === "status" ? "read" : "write";
            const decision = await services.canvasAccess.authorize({ subject, canvasId: identity.canvasId, permission });
            if (!decision.ok) return { status: 403, body: { ok: false, code: decision.code, message: decision.message } };
            const canvas = await services.extensionNodes.read({ subject, canvasId: identity.canvasId, permission });
            assertNode(canvas, identity.nodeId, identity.instanceId);
            let run = await repository.read(identity.canvasId, identity.nodeId, identity.instanceId);
            if (route !== "status") {
              const expectedVersion = z.object({ expectedVersion: versionSchema }).parse(body).expectedVersion;
              if (run.version !== expectedVersion) throw new WorkflowError("revision-conflict", "制作记录已更新，请刷新后重试。");
            }
            if (route === "start") {
              const request = startSchema.parse(body);
              if (request.stageId === "02_identity_board") run.productionProfile = structuredClone(DEFAULT_PRODUCTION_PROFILE);
              await verifyReferences(canvas, request.input, services.media.verify);
              const admission = host.work.admit();
              if (!admission.ok) throw new WorkflowError("work-unavailable", "扩展当前不能受理新制作。");
              run.execution = { subject, workId: admission.workId };
              try { run = await service.start(run, request.stageId, request.input, request.outputKey); host.work.resume(admission.workId)?.markRunning(); }
              catch (error) { host.work.resume(admission.workId)?.settle("failed"); throw error; }
            } else if (route === "approve") {
              const request = approveSchema.parse(body);
              run = await service.approve(run, { ...request, actor: subject });
            } else if (route === "reconcile") run = await service.reconcile(run);
            else if (route === "rollback") run = await service.rollback(run);
            else if (route === "cancel") {
              for(const stage of Object.values(run.stages))if(stage.status === "running")for(const op of stage.operations)if(op.state === "submitted"){
                try {
                  if(op.remoteRef)await new GpuClient(gpuOptions(host)).cancel(op.remoteRef);
                  else await services.tasks.cancel(op.key);
                } catch { /* 本机仍须停止；持久任务身份保留，之后核对远端终态。 */ }
              }
              run=await service.cancel(run);
            }
            return { status: 200, body: { ok: true, run:decoratePreview(host,run) } };
          } catch (error) {
            const code = error instanceof WorkflowError ? error.code : error instanceof z.ZodError ? "invalid-input" : "unavailable";
            const message = error instanceof WorkflowError ? error.message : error instanceof z.ZodError ? "输入格式不正确，请检查参数。" : "制作服务暂时不可用，请刷新后重试。";
            host.logger({ module: EXTENSION_ID, event: "handler-failed", route, code });
            return { status: /conflict|unknown/.test(code) ? 409 : /unavailable|not-configured/.test(code) ? 503 : 400, body: { ok: false, code, message } };
          }
        }
      });
      return { dispose: () => service.stop() };
    }
  };
}
async function verifyReferences(canvas: ServerCanvas, input: StageInput, verify: import("@woohaa3/contracts").ApplicationExtensionMediaFacade["verify"]): Promise<void> {
  for (const ref of input.referenceImages) {
    const asset = canvas.assets.find(item => item.id === ref.assetId);
    if (!asset || asset.mediaKind !== "image" || asset.metadata?.storageKey !== ref.storageKey || asset.metadata?.checksum !== ref.checksum || asset.metadata?.size !== ref.size || asset.metadata?.contentType !== ref.contentType) throw new WorkflowError("reference-conflict", "参考图已改变或不属于当前画布，请重新拖入。");
    if (!verify) throw new WorkflowError("media-verify-unavailable", "宿主尚未提供媒体内容核验能力。");
    const found = await verify(ref.storageKey, canvas.id);
    if (!found.exists || found.metadata.checksum !== ref.checksum || found.metadata.size !== ref.size || found.metadata.contentType !== ref.contentType) throw new WorkflowError("reference-conflict", "参考图内容核验失败，请重新拖入。");
  }
}
