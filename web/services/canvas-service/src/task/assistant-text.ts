import { createHash } from "node:crypto";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import {
  stableStringify,
  type AssistantTextPort,
  type PreparedAssistantText,
  type AssistantTextRun,
  type AssistantTextReceipt,
  type ServerCanvas,
  type StoredAsset,
  type CanvasCommand,
  type CanvasTaskInputBinding,
} from "@woohaa3/contracts";
import type { CanvasRoom } from "../sync/room.js";
import type { CanvasMediaClient } from "../clients/media-client.js";
import type { NodeHistoryApplicationService } from "../storage/core/node-history-service.js";
import { resolveImagePrompt } from "./prompt-resolution.js";
import { resolveNodeReferenceInputs } from "./input-resolution.js";
import { resolveMentionsAndCompile } from "./mention-resolution.js";

const digest = (value: unknown) =>
  createHash("sha256").update(stableStringify(value)).digest("hex");
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
export function textContentBaseline(
  canvas: ServerCanvas,
  nodeId: string,
): string {
  const data = canvas.nodeData[nodeId];
  return digest([
    data?.outputAssetId ?? null,
    data?.result ?? null,
    canvas.assets.find((asset) => asset.id === data?.outputAssetId) ?? null,
  ]);
}
/** Canvas owns input compilation, durable jobs, assets and history. No Application import. */
export function createCanvasAssistantTextPort(deps: {
  resolveRoom(canvasId: string): Promise<CanvasRoom | null>;
  authorize(
    owner: string,
    canvasId: string,
    permission: "read" | "write",
  ): Promise<boolean>;
  media: CanvasMediaClient;
  history?: NodeHistoryApplicationService;
}): AssistantTextPort {
  const roomFor = async (
    owner: string,
    canvasId: string,
    permission: "read" | "write" = "write",
  ) => {
    if (!(await deps.authorize(owner, canvasId, permission)))
      fail("unauthorized", "当前用户无画布权限");
    return (
      (await deps.resolveRoom(canvasId)) ??
      fail("canvas-unavailable", "画布不可用")
    );
  };
  const snapshot = (room: CanvasRoom) => {
    const result = room.exportCanvas();
    return result.ok
      ? result.canvas
      : fail("canvas-unavailable", result.message);
  };
  const target = (canvas: ServerCanvas, nodeId: string) => {
    if (
      !canvas.document.nodes.some(
        (node) => node.id === nodeId && node.type === "text",
      )
    )
      fail("target-invalid", "原文本节点不存在或类型已改变");
  };
  const receipt = (
    run: AssistantTextRun,
    revision: number,
    asset?: StoredAsset,
  ): AssistantTextReceipt => ({
    kind: "text-generation",
    runId: run.runId,
    jobId: run.jobId,
    commandId: run.commandId,
    revision,
    assetId: asset?.id,
    current: asset?.metadata?.current === true,
  });
  const history = async (
    prepared: PreparedAssistantText,
    run: AssistantTextRun,
    text: string,
    createdAt: string,
  ) => {
    if (!deps.history) fail("history-unavailable", "文本版本存储不可用");
    await deps.history.registerTaskResult({
      canvasId: prepared.canvasId,
      nodeId: prepared.nodeId,
      runId: run.runId,
      jobId: run.jobId,
      kind: "text",
      createdAt,
      output: { mediaKind: "text", text },
    });
  };
  return {
    async prepare({ owner, entry, capabilities }) {
      const room = await roomFor(owner, entry.canvasId);
      const canvas = snapshot(room);
      const nodeId = entry.nodeId ?? fail("target-invalid", "缺少文本目标");
      target(canvas, nodeId);
      const bindings: CanvasTaskInputBinding[] = capabilities.imageInput
        ? [
            {
              field: "images",
              semantic: "reference-image",
              valueFormat: "reference",
              roles: ["reference_image"],
              mediaKinds: ["image"],
              mediaTypes: [
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
              ],
              maxItems: capabilities.maxImages,
            },
          ]
        : [];
      // Reuse the upstream text fallback and the exact same mention/carried-input compiler.
      const prompt = resolveImagePrompt({
        canvas,
        nodeId,
        panelKind: "image-generation",
        typed: entry.prompt,
      });
      if (prompt.kind !== "ok" || !prompt.text.trim())
        fail("empty-prompt", "请先输入提示词或连接有效上游文字");
      const direct = resolveNodeReferenceInputs({ canvas, nodeId, bindings });
      if (direct.blockingReasons.length)
        fail("unsupported-reference", direct.blockingReasons.join("；"));
      const compiled = resolveMentionsAndCompile({
        canvas,
        nodeId,
        authored: prompt.text,
        bindings,
        directInputs: direct.inputs,
      });
      if (compiled.kind !== "ok") fail("invalid-mention", compiled.message);
      const assets = compiled.inputs.map(
        (input) =>
          canvas.assets.find((asset) => asset.id === input.assetId) ??
          fail("reference-stale", "冻结参考已失效"),
      );
      const baseline = textContentBaseline(canvas, nodeId);
      return {
        canvasId: entry.canvasId,
        nodeId,
        authoredPrompt: entry.prompt,
        prompt: compiled.providerText,
        capabilities,
        baseline,
        inputs: compiled.inputs,
        assets,
        inputHash: digest([
          compiled.providerText,
          compiled.inputs,
          assets,
          compiled.candidates,
          baseline,
        ]),
      };
    },
    async begin({ owner, prepared, run }) {
      const room = await roomFor(owner, prepared.canvasId);
      const result = await room.submitDerived(
        {
          commandId: run.beginCommandId,
          derive: (canvas) => {
            target(canvas, prepared.nodeId);
            if (
              textContentBaseline(canvas, prepared.nodeId) !== prepared.baseline
            )
              return {
                ok: false,
                code: "content-conflict",
                message: "文本作品已改变，请重新生成",
              };
            const view = canvas;
            const bindings: CanvasTaskInputBinding[] = prepared.capabilities
              .imageInput
              ? [
                  {
                    field: "images",
                    semantic: "reference-image",
                    valueFormat: "reference",
                    roles: ["reference_image"],
                    mediaKinds: ["image"],
                    mediaTypes: [
                      "image/png",
                      "image/jpeg",
                      "image/webp",
                      "image/gif",
                    ],
                    maxItems: prepared.capabilities.maxImages,
                  },
                ]
              : [];
            const prompt = resolveImagePrompt({
              canvas: view,
              nodeId: prepared.nodeId,
              panelKind: "image-generation",
              typed: prepared.authoredPrompt,
            });
            if (prompt.kind !== "ok")
              return {
                ok: false,
                code: "reference-stale",
                message: "冻结文字参考已改变",
              };
            const direct = resolveNodeReferenceInputs({
              canvas: view,
              nodeId: prepared.nodeId,
              bindings,
            });
            const compiled = resolveMentionsAndCompile({
              canvas: view,
              nodeId: prepared.nodeId,
              authored: prompt.text,
              bindings,
              directInputs: direct.inputs,
            });
            if (
              direct.blockingReasons.length ||
              compiled.kind !== "ok" ||
              digest([
                compiled.providerText,
                compiled.inputs,
                prepared.assets,
                compiled.candidates,
                prepared.baseline,
              ]) !== prepared.inputHash
            )
              return {
                ok: false,
                code: "reference-stale",
                message: "冻结输入已改变，请重新生成",
              };
            if (
              prepared.assets.some(
                (asset) =>
                  stableStringify(
                    canvas.assets.find((a) => a.id === asset.id),
                  ) !== stableStringify(asset),
              )
            )
              return {
                ok: false,
                code: "reference-stale",
                message: "冻结参考版本已改变",
              };
            return {
              ok: true,
              batch: {
                protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
                canvasId: prepared.canvasId,
                commandId: run.beginCommandId,
                baseRevision: canvas.revision,
                actorId: owner,
                commands: [
                  {
                    type: "nodeData.patch",
                    nodeId: prepared.nodeId,
                    value: {
                      activeRunId: run.runId,
                      taskStatus: "processing",
                      progress: 0,
                      prompt: prepared.authoredPrompt,
                      panelPrompt: prepared.authoredPrompt,
                      error: null,
                      errorMessage: null,
                    },
                  },
                  {
                    type: "job.upsert",
                    job: {
                      id: run.jobId,
                      nodeId: prepared.nodeId,
                      runId: run.runId,
                      // Legacy job schema requires an identity; this is a domain association, not a Task worker.
                      taskId: run.domainRequestId ?? run.runId,
                      status: "running",
                      updatedAt: new Date().toISOString(),
                    },
                  },
                ],
              },
            };
          },
        },
        { authorize: () => deps.authorize(owner, prepared.canvasId, "write") },
      );
      if (!result.ok) fail(result.code, result.message);
    },
    async commit({ owner, prepared, run, text }) {
      if (!text.trim()) fail("candidate-invalid", "助手未返回有效文本正文");
      if (!deps.history) fail("history-unavailable", "文本版本存储不可用");
      const room = await roomFor(owner, prepared.canvasId);
      const createdAt = new Date().toISOString();
      const result = await room.submitDerived(
        {
          commandId: run.commandId,
          derive: (canvas) => {
            target(canvas, prepared.nodeId);
            const current =
              canvas.nodeData[prepared.nodeId]?.activeRunId === run.runId;
            if (
              (current ||
                canvas.nodeData[prepared.nodeId]?.activeRunId?.startsWith(
                  "history:",
                )) &&
              textContentBaseline(canvas, prepared.nodeId) !== prepared.baseline
            )
              return {
                ok: false,
                code: "content-conflict",
                message: "人工作品已改变，候选不能覆盖当前正文",
              };
            const asset: StoredAsset = {
              id: `assistant-text:${run.runId}`,
              nodeId: prepared.nodeId,
              mediaKind: "text",
              title: "助手文本",
              source: "generated",
              status: "ready",
              text,
              createdAt,
              provenance: {
                runId: run.runId,
                taskNodeId: prepared.nodeId,
                taskKind: "text-generation",
              },
              metadata: { current },
            };
            const commands: CanvasCommand[] = [
              { type: "asset.upsert", asset },
              {
                type: "job.upsert",
                job: {
                  id: run.jobId,
                  nodeId: prepared.nodeId,
                  // Legacy job schema requires an identity; this is a domain association, not a Task worker.
                  taskId: run.domainRequestId ?? run.runId,
                  runId: run.runId,
                  status: "success",
                  updatedAt: createdAt,
                },
              },
            ];
            if (current)
              commands.push({
                type: "nodeData.patch",
                nodeId: prepared.nodeId,
                value: {
                  outputAssetId: asset.id,
                  resourceKind: "text",
                  result: { kind: "text", text },
                  taskStatus: "successed",
                  progress: 100,
                  error: null,
                  errorMessage: null,
                },
              });
            return {
              ok: true,
              batch: {
                protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
                canvasId: prepared.canvasId,
                commandId: run.commandId,
                baseRevision: canvas.revision,
                actorId: owner,
                commands,
              },
            };
          },
        },
        { authorize: () => deps.authorize(owner, prepared.canvasId, "write") },
      );
      if (!result.ok) fail(result.code, result.message);
      const asset = snapshot(room).assets.find(
        (asset) => asset.id === `assistant-text:${run.runId}`,
      );
      if (asset?.text !== text)
        fail("request-id-reused", "原提交命令已绑定其它文本正文");
      await history(prepared, run, text, asset?.createdAt ?? createdAt);
      return receipt(run, result.revision, asset);
    },
    async lookup({ owner, run }) {
      const room = await roomFor(owner, run.canvasId, "read");
      const known = await room.lookupCommand(run.commandId);
      if (!known) return null;
      const asset = snapshot(room).assets.find(
        (asset) => asset.id === `assistant-text:${run.runId}`,
      );
      return receipt(run, known.revision, asset);
    },
    async settle({ prepared, run, status, message }) {
      // Cleanup is a trusted service operation on an already accepted job. Revoking
      // the initiator's write permission must stop execution without stranding it.
      const room =
        (await deps.resolveRoom(prepared.canvasId)) ??
        fail("canvas-unavailable", "画布不可用");
      if (!(await room.lookupCommand(run.beginCommandId))) return;
      if (await room.lookupCommand(run.commandId)) return;
      const result = await room.submitDerived({
        commandId: `${run.beginCommandId}:${status}`,
        derive: (canvas) => {
          const saved = canvas.assets.some(
            (asset) => asset.id === `assistant-text:${run.runId}`,
          );
          const job = canvas.jobs.find(
            (job) =>
              job.id === run.jobId &&
              job.runId === run.runId &&
              job.nodeId === prepared.nodeId,
          );
          const commands: CanvasCommand[] =
            !saved && job
              ? [
                  {
                    type: "job.upsert",
                    job: {
                      ...job,
                      status: "failed",
                      error: message,
                      updatedAt: new Date().toISOString(),
                    },
                  },
                ]
              : [];
          if (
            !saved &&
            job &&
            canvas.nodeData[prepared.nodeId]?.activeRunId === run.runId
          )
            commands.push({
              type: "nodeData.patch",
              nodeId: prepared.nodeId,
              value: {
                taskStatus: status,
                progress: 100,
                error: message,
                errorMessage: message,
              },
            });
          return {
            ok: true,
            batch: {
              protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
              canvasId: prepared.canvasId,
              commandId: `${run.beginCommandId}:${status}`,
              baseRevision: canvas.revision,
              actorId: "assistant-text-service",
              commands,
            },
          };
        },
      });
      if (!result.ok) fail(result.code, result.message);
      if (await room.lookupCommand(run.commandId)) return;
      await deps.history?.registerTaskFailure({
        canvasId: prepared.canvasId,
        nodeId: prepared.nodeId,
        runId: run.runId,
        jobId: run.jobId,
        kind: "text",
        outcome: status,
        message,
        inputSummary: prepared.authoredPrompt,
        createdAt: new Date().toISOString(),
      });
    },
    async readImages({ owner, prepared }) {
      await roomFor(owner, prepared.canvasId);
      return Promise.all(
        prepared.inputs.map(async (input) => {
          if (input.mediaKind !== "image" || !deps.media.read)
            fail("unsupported-reference", "此助手无法传输该参考类型");
          const asset = prepared.assets.find(
            (asset) => asset.id === input.assetId,
          )!;
          const verified = await deps.media.verify(
            input.storageKey,
            asset.metadata,
            { canvasId: prepared.canvasId },
          );
          if (!verified.exists || !verified.matches)
            fail("reference-stale", "冻结参考素材不可取得");
          const image = await deps.media.read(
            input.storageKey,
            prepared.canvasId,
          );
          if (
            !image.bytes.length ||
            image.contentType.split(";")[0] !== input.mediaType
          )
            fail("reference-stale", "冻结参考字节或类型不匹配");
          const checksum =
            asset.metadata?.checksum ?? verified.metadata?.checksum;
          if (
            typeof checksum === "string" &&
            createHash("sha256").update(image.bytes).digest("hex") !== checksum
          )
            fail("reference-stale", "冻结参考内容校验不匹配");
          if (
            typeof asset.metadata?.size === "number" &&
            image.bytes.length !== asset.metadata.size
          )
            fail("reference-stale", "冻结参考长度不匹配");
          return image;
        }),
      );
    },
  };
}
