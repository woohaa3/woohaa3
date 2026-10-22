import { customProvider } from 'ai';
import type { FilesV4 } from '@ai-sdk/provider';
import { createJobs } from './jobs.ts';
import { registerPptaskJobs } from './registry.ts';
import { getModelType } from './internal.ts';
import { createAudioModel, createImageModel, createLanguageModel, createVideoModel } from './model.ts';
import { createMemoryJobRepository } from '../stores/index.ts';
import type {
  CreatePptaskProviderOptions,
  PptaskAudioModel,
  PptaskImageModel,
  PptaskLanguageModel,
  PptaskModel,
  PptaskModelType,
  PptaskProvider,
  PptaskVideoModel,
} from './types.ts';

export function createPptaskProvider(options: CreatePptaskProviderOptions): PptaskProvider {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const languageModels = lazyModelRecord<PptaskLanguageModel>(modelId => {
    if (!options.languageModel) return undefined;
    return createLanguageModel(options.providerId, modelId, options.languageModel(modelId), pollIntervalMs, options.executionReporter);
  });
  const imageModels = lazyModelRecord<PptaskImageModel>(modelId => {
    if (!options.imageModel) return undefined;
    return createImageModel(options.providerId, modelId, options.imageModel(modelId), pollIntervalMs, options.executionReporter);
  });
  const videoModels = lazyModelRecord<PptaskVideoModel>(modelId => {
    if (!options.videoModel) return undefined;
    return createVideoModel(options.providerId, modelId, options.videoModel(modelId), options.executionReporter);
  });
  const audioModels = lazyModelRecord<PptaskAudioModel>(modelId => {
    if (!options.audioModel) return undefined;
    return createAudioModel(options.providerId, modelId, options.audioModel(modelId), pollIntervalMs, options.executionReporter);
  });

  const sdkProvider = customProvider({
    languageModels,
    imageModels,
    videoModels,
    speechModels: audioModels,
    files: options.files,
  });

  const resolveModel = (type: PptaskModelType, modelId: string): PptaskModel => {
    if (type === 'language') return sdkProvider.languageModel(modelId) as PptaskLanguageModel;
    if (type === 'image') return sdkProvider.imageModel(modelId) as PptaskImageModel;
    if (type === 'video') return sdkProvider.videoModel(modelId) as PptaskVideoModel;
    if (type === 'audio') return sdkProvider.speechModel(modelId) as PptaskAudioModel;
    throw new Error(`Unsupported model type: ${String(type)}`);
  };
  const jobs = createJobs({
    providerId: options.providerId,
    store: options.jobRepository ?? createMemoryJobRepository(),
    pollIntervalMs,
    maxStatusErrors: options.maxStatusErrors ?? 3,
    resolveModel,
    reporter: options.executionReporter,
  });
  registerPptaskJobs(jobs);

  return Object.assign(sdkProvider, {
    providerId: options.providerId,
    jobs,
    audioModel: (modelId: string) => sdkProvider.speechModel(modelId) as PptaskAudioModel,
    async describe(model: PptaskModel) {
      const modelType = getModelType(model);
      if (model.doDescribe) return model.doDescribe();
      return {
        providerId: options.providerId,
        modelId: model.modelId,
        modelType,
        title: model.modelId,
      };
    },
    async upload(uploadOptions: Parameters<FilesV4['uploadFile']>[0]) {
      if (!options.files) throw new Error(`Provider ${options.providerId} does not support file uploads`);
      return options.files.uploadFile(uploadOptions);
    },
  }) as unknown as PptaskProvider;
}

function lazyModelRecord<T extends object>(factory: (modelId: string) => T | undefined): Record<string, T> {
  const cache = new Map<string, T>();
  return new Proxy(Object.create(null) as Record<string, T>, {
    has(_target, property) {
      if (typeof property !== 'string') return false;
      if (cache.has(property)) return true;
      const model = factory(property);
      if (!model) return false;
      cache.set(property, model);
      return true;
    },
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (!cache.has(property)) {
        const model = factory(property);
        if (model) cache.set(property, model);
      }
      return cache.get(property);
    },
  });
}
