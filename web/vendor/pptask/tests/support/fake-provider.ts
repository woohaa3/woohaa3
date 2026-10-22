import type { ImageModelV4CallOptions, ImageModelV4Result } from '@ai-sdk/provider';
import {
  createMemoryJobRepository,
  createPptaskProvider,
  type PptaskAudioResult,
  type PptaskJobRepository,
  type PptaskProvider,
} from '../../src/index.ts';

export type FakeProviderController = {
  starts: number;
  statuses: number;
  cancels: number;
  completeAfter: number;
  statusErrors?: number;
};

export function createFakeProvider(options: {
  store?: PptaskJobRepository;
  controller?: FakeProviderController;
  pollIntervalMs?: number;
} = {}): { provider: PptaskProvider; controller: FakeProviderController } {
  const controller = options.controller ?? {
    starts: 0,
    statuses: 0,
    cancels: 0,
    completeAfter: 2,
    statusErrors: 0,
  };

  const provider = createPptaskProvider({
    providerId: 'fake',
    jobRepository: options.store ?? createMemoryJobRepository(),
    pollIntervalMs: options.pollIntervalMs ?? 1,
    imageModel: modelId => ({
      maxImagesPerCall: 1,
      async doStart(_input: ImageModelV4CallOptions) {
        controller.starts += 1;
        return { operation: { id: `operation-${controller.starts}` } };
      },
      async doStatus(): Promise<any> {
        controller.statuses += 1;
        if ((controller.statusErrors ?? 0) > 0) {
          controller.statusErrors = (controller.statusErrors ?? 0) - 1;
          throw new Error('temporary status error');
        }
        if (controller.statuses < controller.completeAfter) {
          return { status: 'pending', phase: 'running', progress: 0.5 };
        }
        const result: ImageModelV4Result = {
          images: [new Uint8Array([1, 2, 3])],
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
        return { status: 'completed', ...result };
      },
      async doCancel() {
        controller.cancels += 1;
      },
      async doDescribe() {
        return {
          providerId: 'fake',
          modelId,
          modelType: 'image' as const,
          title: `Fake ${modelId}`,
        };
      },
    }),
    videoModel: modelId => ({
      maxVideosPerCall: 1,
      async doStart() {
        controller.starts += 1;
        return {
          operation: { id: `video-operation-${controller.starts}` },
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
      },
      async doStatus() {
        controller.statuses += 1;
        if (controller.statuses < controller.completeAfter) {
          return {
            status: 'pending' as const,
            response: { timestamp: new Date(), modelId, headers: undefined },
          };
        }
        return {
          status: 'completed' as const,
          videos: [{ type: 'base64' as const, data: 'AQID', mediaType: 'video/mp4' }],
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
      },
      async doCancel() {
        controller.cancels += 1;
      },
    }),
    audioModel: modelId => ({
      async doGenerate(): Promise<PptaskAudioResult> {
        controller.starts += 1;
        return {
          audio: 'AQID',
          audios: [{ type: 'base64', data: 'AQID', mediaType: 'audio/mpeg' }],
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
      },
      async doDescribe() {
        return {
          providerId: 'fake',
          modelId,
          modelType: 'audio' as const,
          title: `Fake ${modelId}`,
        };
      },
    }),
  });

  return { provider, controller };
}
