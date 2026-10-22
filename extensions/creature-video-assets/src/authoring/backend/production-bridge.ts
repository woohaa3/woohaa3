import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ApplicationBackendHost } from "@woohaa3/contracts";
import { WorkflowError, type Artifact } from "../../state/shared/workflow.js";
import type { ProductionStageBridge } from "./task-executor.js";
import { GpuClient, gpuOptions } from "./production/providers/gpu.js";
import { executeMatting } from "./production/stages/matting.js";
import { executePublish } from "./production/stages/publish.js";

/** 制作工具适配属于本扩展；不把 ffmpeg/GPU/项目发布语义引入宿主。 */
export const PRODUCTION_CHECKS = {
  "05_direction_stills": ["master-coverage", "mirror-provenance", "identity", "camera", "subject-scale", "foot-baseline", "safe-margin"],
  "07_rgb_videos": ["scope", "frame-provenance", "24fps-no-audio", "loop-boundary", "hard-cut-boundary", "event-frames", "stop-exit"],
  "08_matting": ["sam3-envelope", "videomama-alpha-hint", "source-rgb-preserved", "straight-alpha", "frame-size-fps-pts", "dark-light-checker-composites"],
  "09_publish": ["gbuffer-original-surface-material", "body-surface-material-mask-shadow", "same-source-frame", "atomic-switch", "stop-exit", "load-fallback", "rollback"]
} as const;
const artifactSchema = z.object({ id: z.string().min(1).max(300), title: z.string().min(1).max(500), kind: z.enum(["text", "image", "video", "web"]), storageKey: z.string().max(1000).optional(), contentType: z.string().max(120).optional(), checksum: z.string().max(200).optional(), size: z.number().int().nonnegative().optional(), text: z.string().max(100000).optional(), directionId: z.string().max(20).optional(), actionId: z.string().max(100).optional(), previewUrl: z.string().url().refine(value => /^https?:\/\//.test(value)).optional() }).strict();
const outputSchema = z.object({ protocol: z.literal("creature-production.v1"), operationKey: z.string(), stageId: z.string(), revision: z.number().int(), gate: z.string(), status: z.enum(["complete", "unknown", "blocked"]), message: z.string().max(2000).optional(), artifacts: z.array(artifactSchema).max(300), structured: z.record(z.string(), z.unknown()).nullable(), checks: z.array(z.object({ id: z.string(), passed: z.boolean(), evidenceIds: z.array(z.string()).min(1).max(100) }).strict()).max(100) }).strict();

function invoke(executable: string, args: string[], input: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", finished = false;
    const finish = (error?: Error, value?: unknown) => { if (finished) return; finished = true; clearTimeout(timeout); error ? reject(error) : resolve(value); };
    const timeout = setTimeout(() => { child.kill(); finish(new WorkflowError("submit-unknown", "制作工具超时；任务结果待核对，不会自动重发。")); }, 45 * 60 * 1000);
    child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString("utf8"); if (Buffer.byteLength(output) > 2_000_000) { child.kill(); finish(new WorkflowError("submit-unknown", "制作工具返回超出限制，需核对原任务。")); } });
    // 工具日志可能含本机路径或凭据，不能回传浏览器或宿主公共日志。
    child.stderr.resume();
    child.on("error", () => finish(new WorkflowError("production-unavailable", "制作工具无法启动，请检查扩展配置。")));
    child.stdin.on("error", () => finish(new WorkflowError("submit-unknown", "制作工具连接中断，需先核对任务。")));
    child.on("close", code => {
      if (code !== 0) { finish(new WorkflowError("submit-unknown", "制作工具退出，任务结果待核对。")); return; }
      try { finish(undefined, JSON.parse(output)); } catch { finish(new WorkflowError("submit-unknown", "制作工具未返回可验证的结果，需先核对任务。")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
export function createLegacyProductionBridge(host: ApplicationBackendHost, invokeWorker = invoke): ProductionStageBridge {
  return async context => {
    const config = host.config.values(), worker = config.productionWorker as { executable?: unknown; args?: unknown } | undefined;
    if (!worker || typeof worker.executable !== "string" || !isAbsolute(worker.executable) || !Array.isArray(worker.args) || !worker.args.every(item => typeof item === "string")) throw new WorkflowError("production-not-configured", "此步需要连接生物资产制作工具。请在扩展配置中配置方向图、视频、抠像与 G-buffer 制作适配。");
    const required = PRODUCTION_CHECKS[context.stageId as keyof typeof PRODUCTION_CHECKS];
    if (!required) throw new WorkflowError("invalid-stage", "制作工具不负责该步骤。");
    const stage = context.run.stages[context.stageId];
    const key = `production-${createHash("sha256").update(JSON.stringify([context.run.canvasId, context.run.nodeId, context.run.instanceId, context.stageId, stage.revision, stage.gate])).digest("hex")}`;
    let operation = stage.operations.find(item => item.key === key);
    const mode = operation ? "reconcile" : "execute";
    if (!operation) { operation = { key, modelKey: stage.input.modelKey, state: "unknown" }; stage.operations.push(operation); await context.checkpoint(); }
    await context.assertCurrent();
    const raw = await invokeWorker(worker.executable, worker.args as string[], {
      protocol: "creature-production.v1", mode, operationKey: key,
      identity: { canvasId: context.run.canvasId, nodeId: context.run.nodeId, instanceId: context.run.instanceId },
      stageId: context.stageId, revision: stage.revision, gate: stage.gate, input: stage.input,
      productionProfile: context.run.productionProfile ?? null,
      upstream: Object.fromEntries(Object.entries(stage.inputVersions).map(([id, revision]) => [id, { revision, structured: context.run.stages[id as keyof typeof context.run.stages].structured, artifacts: context.run.stages[id as keyof typeof context.run.stages].artifacts }])),
      pilot: stage.gate === "batch" ? { approval: stage.approvals.pilot, artifacts: stage.artifacts } : null,
      requiredChecks: required
    });
    const parsed = outputSchema.safeParse(raw);
    if (!parsed.success) throw new WorkflowError("submit-unknown", "制作工具响应不符合版本化契约，先核对原任务。");
    const result = parsed.data;
    if (result.operationKey !== key || result.stageId !== context.stageId || result.revision !== stage.revision || result.gate !== stage.gate) throw new WorkflowError("submit-unknown", "制作工具返回了其他版本或验收门的结果，需核对原任务。");
    if (result.status === "unknown") throw new WorkflowError("submit-unknown", "制作工具尚未确认任务结果，请稍后核对。");
    if (result.status === "blocked") { operation.state = "failed"; await context.checkpoint(); throw new WorkflowError("production-qa-required", result.message ?? "制作证据不足，不能进入验收。"); }
    const ids = new Set(result.artifacts.map(artifact => artifact.id));
    if (!ids.size || ids.size !== result.artifacts.length) throw new WorkflowError("production-qa-required", "制作产物缺失或身份重复。");
    const expectedKind = context.stageId === "05_direction_stills" ? "image" : context.stageId === "09_publish" ? "web" : "video";
    if (!result.artifacts.some(artifact => artifact.kind === expectedKind && (expectedKind !== "web" || artifact.previewUrl))) throw new WorkflowError("production-qa-required", "制作工具未提供本步必需的媒体或实际运行预览。");
    const verified = new Set<string>();
    for (const artifact of result.artifacts) {
      if (artifact.kind === "text" && artifact.text) { verified.add(artifact.id); continue; }
      if (!artifact.storageKey || !artifact.checksum || !host.services.media.verify) throw new WorkflowError("media-verify-unavailable", "制作产物缺少稳定媒体引用或内容核验能力。");
      const found = await host.services.media.verify(artifact.storageKey);
      if (!found.exists || found.metadata.checksum !== artifact.checksum || found.metadata.size !== artifact.size || found.metadata.contentType !== artifact.contentType) throw new WorkflowError("production-qa-required", "制作产物内容核验失败。");
      verified.add(artifact.id);
    }
    const hardPassed = required.every(id => result.checks.some(check => check.id === id && check.passed && check.evidenceIds.every(evidence => verified.has(evidence))));
    operation.state = "succeeded"; await context.checkpoint();
    return { artifacts: result.artifacts as Artifact[], structured: { ...result.structured, productionChecks: result.checks }, checks: { hardPassed, agent: "pending", notes: hardPassed ? [] : ["制作工具尚未提供全部必需的确定性检查及对应证据。"] } };
  };
}

/** New work is extension-owned. Old in-flight external operations may only reconcile. */
export function createProductionBridge(host: ApplicationBackendHost): ProductionStageBridge {
  return async context => {
    if (context.run.stages[context.stageId].operations.some(op => op.key.startsWith("production-") && op.state !== "failed")) return createLegacyProductionBridge(host)(context);
    const gpu = new GpuClient(gpuOptions(host));
    if (context.stageId === "08_matting") return executeMatting(context,host.services,gpu);
    if (context.stageId === "09_publish") return executePublish(context,host.services,gpu);
    throw new WorkflowError("invalid-stage","专用制作服务只负责抠像与通道发布。");
  };
}
