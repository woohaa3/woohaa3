/** Trusted immutable world capture → native renderer → verified Media save pipeline. */
import {
  decodeSceneAreaData,
  decodeWorldCamera,
  executeWorldAnimationScript,
  parseGlbModel,
  quatMul,
  sampleWorldAnimationInArea,
  worldCaptureDynamicFrameCount,
  worldCaptureFrameTime,
  worldCameraShotContext,
  type WorldCaptureDynamicProducerOutcome,
  type WorldCaptureDynamicRequest,
  type WorldCaptureProducer,
  type WorldCaptureProducerOutcome
} from "@woohaa3/contracts";
import { executeSceneIr, type ScriptExecutorOptions } from "../model-mcp/script-executor.js";
import type { RendererClient, RendererSceneRequest } from "../model-renderer/client.js";
import type { VideoEncoderClient } from "../model-renderer/video-encoder.js";
import type { CanvasMediaClient } from "../clients/media-client.js";
import type { CanvasRoom } from "../sync/room.js";

type RenderedInstance = NonNullable<RendererSceneRequest["world"]>["instances"][number];

export function createWorldCaptureProducer(options: {
  renderer: RendererClient;
  resolveRoom(canvasId: string): Promise<CanvasRoom | null>;
  media?: CanvasMediaClient | null;
  scriptExecutor?: ScriptExecutorOptions;
  /** 动态镜头的真实视频编码器；缺失时 `captureVideo` 不注册，服务显式不可用。 */
  videoEncoder?: VideoEncoderClient;
}): WorldCaptureProducer {
  /** 解析冻结请求涉及的模型内容并按顺序渲染到场景 IR。 */
  async function resolveRenderedInstances(
    request: { key: { canvasId: string }; contentFingerprint: string; subject: import("@woohaa3/contracts").WorldCaptureSubject | import("@woohaa3/contracts").WorldCaptureDynamicSubject },
    signal: AbortSignal | undefined
  ): Promise<
    | { ok: true; instances: RenderedInstance[] }
    | { ok: false; code: "bound-target-missing" | "cancelled" | "content-mismatch" | "content-unavailable" | "render-failed" }
  > {
    const subject = request.subject;
    if (subject.kind === "bound-missing") {
      return { ok: false, code: "bound-target-missing" };
    }
    const instances = subject.kind === "world" ? subject.instances : [subject.instance];
    const contents = subject.kind === "world" ? subject.contents : [{ instanceId: subject.instanceId, content: subject.content }];
    const rendered: RenderedInstance[] = [];
    for (const instance of instances) {
      if (signal?.aborted) {
        return { ok: false, code: "cancelled" };
      }
      const content = contents.find((entry) => entry.instanceId === instance.instanceId)?.content;
      if (!content) {
        return { ok: false, code: "content-mismatch" };
      }
      if (content.kind === "script") {
        const definition = content.definition;
        const result = await executeSceneIr(definition.modelScript, definition.modelScriptVersion, {
          ...options.scriptExecutor,
          signal
        });
        if (signal?.aborted) {
          return { ok: false, code: "cancelled" };
        }
        if (!result.ok) {
          return { ok: false, code: "render-failed" };
        }
        rendered.push({ instance, ops: result.ops });
      } else {
        // Resolve the pinned immutable asset id, never the node's latest model.
        const room = await options.resolveRoom(request.key.canvasId);
        const exported = room?.exportCanvas();
        const asset = exported?.ok
          ? exported.canvas.assets.find((entry) => entry.id === content.reference.assetId)
          : null;
        const key = asset?.metadata?.storageKey;
        if (typeof key !== "string" || !options.media?.read) {
          return { ok: false, code: "content-unavailable" };
        }
        const raw = await options.media.read(key, request.key.canvasId);
        const parsed = parseGlbModel(raw.bytes);
        if (!parsed.ok) {
          return { ok: false, code: "render-failed" };
        }
        rendered.push({
          instance,
          ops: parsed.ops,
          textures: parsed.textures.map((texture) => ({
            id: texture.id,
            mimeType: texture.mimeType,
            bytesBase64: Buffer.from(texture.bytes).toString("base64")
          }))
        });
      }
    }
    return { ok: true, instances: rendered };
  }

  const producer: {
    producerId: string;
    capture: WorldCaptureProducer["capture"];
    captureVideo?: NonNullable<WorldCaptureProducer["captureVideo"]>;
  } = {
    producerId: "native-world-camera-v1",
    async capture(request, captureOptions): Promise<WorldCaptureProducerOutcome> {
      const signal = captureOptions?.signal;
      const identity = { requestId: request.requestId, key: request.key, contentFingerprint: request.contentFingerprint };
      const cancelled = () => ({ ...identity, status: "cancelled" as const });
      if (signal?.aborted) return cancelled();
      if (request.subject.kind === "bound-missing") return { ...identity, status: "unavailable", reason: "bound-target-missing" };
      if (!options.renderer.available()) return { ...identity, status: "unavailable", reason: "renderer-unavailable" };
      const resolved = await resolveRenderedInstances(request, signal);
      if (!resolved.ok) {
        if (resolved.code === "cancelled") return cancelled();
        if (resolved.code === "bound-target-missing") return { ...identity, status: "unavailable", reason: "bound-target-missing" };
        if (resolved.code === "content-unavailable") return { ...identity, status: "unavailable", reason: "content-unavailable" };
        return { ...identity, status: "failed", code: resolved.code };
      }
      try {
        if (signal?.aborted) return cancelled();
        const result = await options.renderer.render({
          requestId: request.requestId,
          sceneVersion: "woohaa-model-scene-ir-v2",
          signature: request.contentFingerprint,
          extent: 1,
          ops: [],
          capture: { width: request.output.width, height: request.output.height, background: "#f6f8f7", cameraPreset: "dimetric" },
          world: { camera: request.camera, instances: resolved.instances }
        });
        if (signal?.aborted) return cancelled();
        if (!result.ok) {
          return result.code === "renderer-unavailable" || result.code === "unsupported-protocol-version"
            ? { ...identity, status: "unavailable", reason: "renderer-unavailable" }
            : { ...identity, status: "failed", code: "render-failed" };
        }
        return { ...identity, status: "image", image: { bytes: result.png, contentType: "image/png", width: request.output.width, height: request.output.height } };
      } catch {
        return signal?.aborted ? cancelled() : { ...identity, status: "failed", code: "render-failed" };
      }
    }
  };

  if (options.videoEncoder) {
    producer.captureVideo = async (
      request: WorldCaptureDynamicRequest,
      captureOptions?: { readonly signal?: AbortSignal }
    ) => {
      const signal = captureOptions?.signal;
      const identity = { requestId: request.requestId, key: request.key, contentFingerprint: request.contentFingerprint };
      const cancelled = (): WorldCaptureDynamicProducerOutcome => ({ ...identity, status: "cancelled" });
      if (signal?.aborted) return cancelled();
      if (request.subject.kind === "bound-missing") return { ...identity, status: "unavailable", reason: "bound-target-missing" };
      if (!options.renderer.available()) return { ...identity, status: "unavailable", reason: "renderer-unavailable" };
      if (!options.videoEncoder?.available()) {
        return { ...identity, status: "unavailable", reason: "dynamic-encoder-unavailable" };
      }

      // 动画脚本必须与请求冻结的 revision/sourceHash 一致；不能拿当前脚本冒充旧版本。
      const room = await options.resolveRoom(request.key.canvasId);
      const exported = room?.exportCanvas();
      if (!exported?.ok) return { ...identity, status: "unavailable", reason: "content-unavailable" };
      const canvas = exported.canvas;
      const shot = worldCameraShotContext(canvas, request.key.cameraId);
      const animation = shot?.animation;
      const areaNode = animation
        ? (canvas.nodeData as Record<string, { sceneArea?: unknown }>)[animation.areaNodeId]
        : undefined;
      const area = decodeSceneAreaData(areaNode?.sceneArea);
      if (
        !animation ||
        !area.ok ||
        !area.value.animationScript ||
        animation.areaId !== request.key.animation.areaId ||
        area.value.animationScript.revision !== request.key.animation.scriptRevision ||
        area.value.animationScript.sourceHash !== request.key.animation.sourceHash
      ) {
        return { ...identity, status: "failed", code: "content-mismatch" };
      }
      const compiled = executeWorldAnimationScript(area.value.animationScript.script, {
        duration: area.value.animationScript.duration,
        loop: area.value.animationScript.loop
      });
      if (!compiled.ok) return { ...identity, status: "failed", code: "render-failed" };
      // 当前镜头配置也必须仍是冻结版本。
      const currentNode = canvas.document.nodes.find((node) => node.id === shot.cameraNodeId);
      const currentCamera = decodeWorldCamera(
        (canvas.nodeData as Record<string, { worldCamera?: unknown }>)[currentNode?.id ?? ""]?.worldCamera
      );
      if (!currentCamera.ok || currentCamera.value.settingsVersion !== request.camera.settingsVersion) {
        return { ...identity, status: "failed", code: "content-mismatch" };
      }

      const resolved = await resolveRenderedInstances(request, signal);
      if (!resolved.ok) {
        if (resolved.code === "cancelled") return cancelled();
        if (resolved.code === "bound-target-missing") return { ...identity, status: "unavailable", reason: "bound-target-missing" };
        if (resolved.code === "content-unavailable") return { ...identity, status: "unavailable", reason: "content-unavailable" };
        return { ...identity, status: "failed", code: resolved.code };
      }
      const baseInstances = resolved.instances;
      const frameCount = worldCaptureDynamicFrameCount(request.key);

      const frames = async function* (): AsyncGenerator<Uint8Array> {
        for (let index = 0; index < frameCount; index += 1) {
          if (signal?.aborted) return;
          const time = worldCaptureFrameTime(request.key, index);
          const sample = sampleWorldAnimationInArea(compiled.ir, time, animation.origin, animation.quarterTurns);
          const cameraSample = sample.cameras.get(request.key.cameraId);
          const camera = cameraSample
            ? {
                ...request.camera,
                ...(cameraSample.position ? { position: cameraSample.position } : {}),
                ...(cameraSample.rotation
                  ? { rotation: quatMul([...request.camera.rotation] as import("@woohaa3/contracts").Quat, [...cameraSample.rotation] as import("@woohaa3/contracts").Quat) }
                  : {}),
                ...(cameraSample.zoom !== undefined
                  ? { projection: zoomedProjection(request.camera.projection, cameraSample.zoom) }
                  : {})
              }
            : request.camera;
          const instances = baseInstances.map((entry) => {
            const motion = sample.instances.get(entry.instance.instanceId);
            if (!motion) return entry;
            return {
              ...entry,
              instance: {
                ...entry.instance,
                transform: {
                  ...entry.instance.transform,
                  ...(motion.position ? { position: motion.position } : {}),
                  ...(motion.rotation
                    ? { rotation: quatMul([...entry.instance.transform.rotation] as import("@woohaa3/contracts").Quat, [...motion.rotation] as import("@woohaa3/contracts").Quat) }
                    : {}),
                  ...(motion.scale !== undefined ? { scale: motion.scale } : {})
                }
              }
            };
          });
          const result = await options.renderer.render({
            requestId: `${request.requestId}:frame:${index}`,
            sceneVersion: "woohaa-model-scene-ir-v2",
            signature: request.contentFingerprint,
            extent: 1,
            ops: [],
            capture: {
              width: request.output.width,
              height: request.output.height,
              background: "#f6f8f7",
              cameraPreset: "dimetric",
              format: "rgba"
            },
            world: { camera, instances }
          });
          if (!result.ok || !result.rgba) {
            throw new Error(result.ok ? "renderer returned no rgba frame" : result.message);
          }
          yield result.rgba;
        }
      };

      try {
        const encoded = await options.videoEncoder.encode({
          width: request.output.width,
          height: request.output.height,
          fps: request.key.fps,
          frames: frames(),
          ...(signal ? { signal } : {})
        });
        if (signal?.aborted) return cancelled();
        if (!encoded.ok) {
          return encoded.code === "video-encoder-unavailable"
            ? { ...identity, status: "unavailable", reason: "dynamic-encoder-unavailable" }
            : { ...identity, status: "failed", code: encoded.code };
        }
        return {
          ...identity,
          status: "video",
          video: {
            bytes: new Uint8Array(encoded.mp4),
            contentType: "video/mp4",
            width: encoded.width,
            height: encoded.height,
            durationSeconds: encoded.durationSeconds,
            fps: encoded.fps
          }
        };
      } catch {
        return signal?.aborted ? cancelled() : { ...identity, status: "failed", code: "render-failed" };
      }
    };
  }

  return producer;
}

function zoomedProjection(projection: import("@woohaa3/contracts").WorldCameraProjection, zoom: number): import("@woohaa3/contracts").WorldCameraProjection {
  if (!Number.isFinite(zoom) || zoom <= 0) return projection;
  if (projection.kind === "perspective") {
    return { ...projection, verticalFovRadians: Math.max(0.01, Math.min(Math.PI * 0.9, projection.verticalFovRadians * zoom)) };
  }
  return { ...projection, verticalSizeMeters: Math.max(0.01, projection.verticalSizeMeters * zoom) };
}
