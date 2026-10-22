import type {
  Experimental_VideoModelV4CallOptions,
  ImageModelV4CallOptions,
  LanguageModelV4CallOptions,
  SpeechModelV4CallOptions,
} from '@ai-sdk/provider';
import { createPptaskProvider } from '../../core/provider.ts';
import type {
  PptaskAudioModelImplementation,
  PptaskImageModelImplementation,
  PptaskLanguageModelImplementation,
  PptaskModelType,
  PptaskProvider,
  PptaskVideoModelImplementation,
} from '../../core/types.ts';
import { audioInput, imageInput, languageInput, videoInput } from './input.ts';
import { audioResult, imageResult, languageResult, videoResult } from './output.ts';
import { providerMetadata, type CommonProviderOptions, type HttpProviderProtocol } from './types.ts';

export function createHttpProvider(
  protocol: HttpProviderProtocol,
  options: CommonProviderOptions,
): PptaskProvider {
  const supports = (type: PptaskModelType) => !protocol.modelTypes || protocol.modelTypes.includes(type);
  const common = {
    providerId: protocol.providerId,
    files: protocol.files,
    jobRepository: options.jobRepository,
    pollIntervalMs: options.pollIntervalMs,
  };
  return createPptaskProvider({
    ...common,
    languageModel: supports('language') ? modelId => languageModel(protocol, modelId) : undefined,
    imageModel: supports('image') ? modelId => imageModel(protocol, modelId) : undefined,
    videoModel: supports('video') ? modelId => videoModel(protocol, modelId) : undefined,
    audioModel: supports('audio') ? modelId => audioModel(protocol, modelId) : undefined,
  });
}

function languageModel(
  protocol: HttpProviderProtocol,
  modelId: string,
): PptaskLanguageModelImplementation {
  const modelType = 'language' as const;
  protocol.validateModel?.(modelId, modelType);
  const mode = protocol.mode(modelId, modelType);
  return {
    supportedUrls: {},
    ...(mode === 'sync'
      ? {
          async doGenerate(options: LanguageModelV4CallOptions) {
            if (!protocol.execute) throw new Error(`${protocol.providerId} does not support synchronous execution`);
            const output = await protocol.execute(context(modelId, modelType, languageInput(protocol.providerId, options), options));
            return languageResult(protocol.providerId, modelId, output);
          },
        }
      : operationMethods(protocol, modelId, modelType, languageInput)),
    doDescribe: protocol.describe ? () => protocol.describe!(modelId, modelType) : undefined,
  } as PptaskLanguageModelImplementation;
}

function imageModel(
  protocol: HttpProviderProtocol,
  modelId: string,
): PptaskImageModelImplementation {
  const modelType = 'image' as const;
  protocol.validateModel?.(modelId, modelType);
  const mode = protocol.mode(modelId, modelType);
  return {
    maxImagesPerCall: undefined,
    ...(mode === 'sync'
      ? {
          async doGenerate(options: ImageModelV4CallOptions) {
            if (!protocol.execute) throw new Error(`${protocol.providerId} does not support synchronous execution`);
            const output = await protocol.execute(context(modelId, modelType, imageInput(protocol.providerId, options), options));
            return imageResult(protocol.providerId, modelId, output, protocol.fetch, options.abortSignal);
          },
        }
      : operationMethods(protocol, modelId, modelType, imageInput)),
    doDescribe: protocol.describe ? () => protocol.describe!(modelId, modelType) : undefined,
  } as PptaskImageModelImplementation;
}

function audioModel(
  protocol: HttpProviderProtocol,
  modelId: string,
): PptaskAudioModelImplementation {
  const modelType = 'audio' as const;
  protocol.validateModel?.(modelId, modelType);
  const mode = protocol.mode(modelId, modelType);
  return {
    ...(mode === 'sync'
      ? {
          async doGenerate(options: SpeechModelV4CallOptions) {
            if (!protocol.execute) throw new Error(`${protocol.providerId} does not support synchronous execution`);
            const output = await protocol.execute(context(modelId, modelType, audioInput(protocol.providerId, options), options));
            return audioResult(protocol.providerId, modelId, output, protocol.fetch, options.abortSignal);
          },
        }
      : operationMethods(protocol, modelId, modelType, audioInput)),
    doDescribe: protocol.describe ? () => protocol.describe!(modelId, modelType) : undefined,
  } as PptaskAudioModelImplementation;
}

function videoModel(
  protocol: HttpProviderProtocol,
  modelId: string,
): PptaskVideoModelImplementation {
  const modelType = 'video' as const;
  protocol.validateModel?.(modelId, modelType);
  if (protocol.mode(modelId, modelType) !== 'async') {
    throw new Error(`${protocol.providerId} video models must use an asynchronous operation`);
  }
  return {
    maxVideosPerCall: 1,
    ...videoOperationMethods(protocol, modelId),
    doDescribe: protocol.describe ? () => protocol.describe!(modelId, modelType) : undefined,
  };
}

function operationMethods<OPTIONS extends { abortSignal?: AbortSignal; headers?: Record<string, string | undefined> }>(
  protocol: HttpProviderProtocol,
  modelId: string,
  modelType: 'language' | 'image' | 'audio',
  convert: (providerId: string, options: OPTIONS) => Record<string, unknown>,
) {
  return {
    async doStart(options: OPTIONS, operationContext?: any) {
      if (!protocol.start) throw new Error(`${protocol.providerId} does not support job creation`);
      const started = await protocol.start({
        ...context(modelId, modelType, convert(protocol.providerId, options), options),
        operationContext,
      });
      return {
        operation: started.operation,
        warnings: [],
        providerMetadata: providerMetadata(protocol.providerId, started.metadata),
      };
    },
    async doStatus(options: any) {
      const status = await protocol.status({
        modelId,
        modelType,
        input: {},
        operation: options.operation,
        signal: options.abortSignal,
        headers: options.headers,
      });
      if (status.state === 'pending') {
        return {
          status: 'pending' as const,
          phase: status.phase,
          progress: status.progress,
          providerMetadata: providerMetadata(protocol.providerId, status.metadata),
        };
      }
      if (status.state === 'failed') {
        return {
          status: 'error' as const,
          error: status.error,
          providerMetadata: providerMetadata(protocol.providerId, status.metadata),
        };
      }
      const result = modelType === 'image'
        ? await imageResult(protocol.providerId, modelId, status.output, protocol.fetch, options.abortSignal, status.metadata)
        : modelType === 'audio'
          ? await audioResult(protocol.providerId, modelId, status.output, protocol.fetch, options.abortSignal, status.metadata)
          : languageResult(protocol.providerId, modelId, status.output, status.metadata);
      return { status: 'completed' as const, ...result };
    },
    ...(protocol.cancel ? {
      async doCancel(options: any) {
        await protocol.cancel!({
          modelId,
          modelType,
          input: {},
          operation: options.operation,
          signal: options.abortSignal,
          headers: options.headers,
        });
      },
    } : {}),
  };
}

function videoOperationMethods(protocol: HttpProviderProtocol, modelId: string) {
  return {
    async doStart(options: Experimental_VideoModelV4CallOptions, operationContext?: any) {
      if (!protocol.start) throw new Error(`${protocol.providerId} does not support job creation`);
      const started = await protocol.start({
        ...context(modelId, 'video', videoInput(protocol.providerId, options), options),
        operationContext,
      });
      return {
        operation: started.operation,
        warnings: [],
        providerMetadata: providerMetadata(protocol.providerId, started.metadata),
        response: { timestamp: new Date(), modelId, headers: undefined },
      };
    },
    async doStatus(options: any) {
      const status = await protocol.status({
        modelId,
        modelType: 'video',
        input: {},
        operation: options.operation,
        signal: options.abortSignal,
        headers: options.headers,
      });
      const response = { timestamp: new Date(), modelId, headers: undefined };
      if (status.state === 'pending') {
        return {
          status: 'pending' as const,
          ...(status.phase ? { phase: status.phase } : {}),
          ...(status.progress !== undefined ? { progress: status.progress } : {}),
          providerMetadata: providerMetadata(protocol.providerId, status.metadata),
          response,
        };
      }
      if (status.state === 'failed') {
        return {
          status: 'error' as const,
          error: status.error,
          providerMetadata: providerMetadata(protocol.providerId, status.metadata),
          response,
        };
      }
      return { status: 'completed' as const, ...videoResult(protocol.providerId, modelId, status.output, status.metadata) };
    },
    ...(protocol.cancel ? {
      async doCancel(options: any) {
        await protocol.cancel!({
          modelId,
          modelType: 'video',
          input: {},
          operation: options.operation,
          signal: options.abortSignal,
          headers: options.headers,
        });
      },
    } : {}),
  };
}

function context(
  modelId: string,
  modelType: PptaskModelType,
  input: Record<string, unknown>,
  options: { abortSignal?: AbortSignal; headers?: Record<string, string | undefined> },
) {
  return { modelId, modelType, input, signal: options.abortSignal, headers: options.headers };
}
