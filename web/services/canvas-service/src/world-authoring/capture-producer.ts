/** Trusted immutable world capture → native renderer → verified Media save pipeline. */
import { parseGlbModel, type WorldCaptureProducer, type WorldCaptureProducerOutcome } from "@woohaa3/contracts";
import { executeSceneIr, type ScriptExecutorOptions } from "../model-mcp/script-executor.js";
import type { RendererClient, RendererSceneRequest } from "../model-renderer/client.js";
import type { CanvasMediaClient } from "../clients/media-client.js";
import type { CanvasRoom } from "../sync/room.js";

export function createWorldCaptureProducer(options: {
  renderer: RendererClient;
  resolveRoom(canvasId: string): Promise<CanvasRoom | null>;
  media?: CanvasMediaClient | null;
  scriptExecutor?: ScriptExecutorOptions;
}): WorldCaptureProducer {
  return {
    producerId: "native-world-camera-v1",
    async capture(request, captureOptions): Promise<WorldCaptureProducerOutcome> {
      const signal = captureOptions?.signal;
      const identity = { requestId: request.requestId, key: request.key, contentFingerprint: request.contentFingerprint };
      const cancelled = () => ({ ...identity, status: "cancelled" as const });
      if (signal?.aborted) return cancelled();
      if (request.subject.kind === "bound-missing") return { ...identity, status: "unavailable", reason: "bound-target-missing" };
      if (!options.renderer.available()) return { ...identity, status: "unavailable", reason: "renderer-unavailable" };
      const subject = request.subject;
      const instances = subject.kind === "world" ? subject.instances : [subject.instance];
      const contents = subject.kind === "world" ? subject.contents : [{ instanceId: subject.instanceId, content: subject.content }];
      const renderedInstances: NonNullable<RendererSceneRequest["world"]>["instances"] = [];
      try {
        for (const instance of instances) {
          if (signal?.aborted) return cancelled();
          const content = contents.find(entry => entry.instanceId === instance.instanceId)?.content;
          if (!content) return { ...identity, status: "failed", code: "content-mismatch" };
          if (content.kind === "script") {
            const definition = content.definition;
            const result = await executeSceneIr(definition.modelScript, definition.modelScriptVersion, { ...options.scriptExecutor, signal });
            if (signal?.aborted) return cancelled();
            if (!result.ok) return { ...identity, status: "failed", code: "render-failed" };
            renderedInstances.push({ instance, ops: result.ops });
          } else {
            // Resolve the pinned immutable asset id, never the node's latest model.
            const room = await options.resolveRoom(request.key.canvasId);
            const exported = room?.exportCanvas();
            const asset = exported?.ok ? exported.canvas.assets.find(asset => asset.id === content.reference.assetId) : null;
            const key = asset?.metadata?.storageKey;
            if (typeof key !== "string" || !options.media?.read) return { ...identity, status: "unavailable", reason: "content-unavailable" };
            const raw = await options.media.read(key, request.key.canvasId);
            const parsed = parseGlbModel(raw.bytes);
            if (!parsed.ok) return { ...identity, status: "failed", code: "render-failed" };
            renderedInstances.push({ instance, ops: parsed.ops, textures: parsed.textures.map(texture => ({
              id: texture.id, mimeType: texture.mimeType, bytesBase64: Buffer.from(texture.bytes).toString("base64")
            })) });
          }
        }
        if (signal?.aborted) return cancelled();
        const result = await options.renderer.render({
          requestId: request.requestId, sceneVersion: "woohaa-model-scene-ir-v2",
          signature: request.contentFingerprint, extent: 1, ops: [],
          capture: { width: request.output.width, height: request.output.height, background: "#f6f8f7", cameraPreset: "dimetric" },
          world: { camera: request.camera, instances: renderedInstances }
        });
        if (signal?.aborted) return cancelled();
        if (!result.ok) return result.code === "renderer-unavailable" || result.code === "unsupported-protocol-version"
          ? { ...identity, status: "unavailable", reason: "renderer-unavailable" }
          : { ...identity, status: "failed", code: "render-failed" };
        return { ...identity, status: "image", image: { bytes: result.png, contentType: "image/png", width: request.output.width, height: request.output.height } };
      } catch {
        return signal?.aborted ? cancelled() : { ...identity, status: "failed", code: "render-failed" };
      }
    }
  };
}
