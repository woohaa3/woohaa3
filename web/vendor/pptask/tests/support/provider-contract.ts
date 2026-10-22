import { expect } from 'vitest';
import type {
  PptaskModel,
  PptaskModelType,
  PptaskProvider,
} from '../../src/index.ts';

export type ProviderContractCase = {
  provider: PptaskProvider;
  providerId: string;
  modelId: string;
  modelType: PptaskModelType;
  upload?: boolean;
};

export async function assertProviderContract(testCase: ProviderContractCase): Promise<void> {
  const { provider, providerId, modelId, modelType } = testCase;
  expect(provider.providerId).toBe(providerId);
  expect(provider.jobs).toEqual(expect.objectContaining({
    start: expect.any(Function), resume: expect.any(Function), status: expect.any(Function),
    watch: expect.any(Function), wait: expect.any(Function), cancel: expect.any(Function),
    list: expect.any(Function),
  }));
  expect(provider.describe).toEqual(expect.any(Function));
  expect(provider.upload).toEqual(expect.any(Function));

  const model = modelFor(provider, modelType, modelId);
  expect(model).toEqual(expect.objectContaining({
    specificationVersion: 'v4', provider: providerId, modelId,
  }));
  expect(typeof model.doDescribe).toBe('function');
  if (modelType === 'video') {
    expect(typeof model.doStart).toBe('function');
    expect(typeof model.doStatus).toBe('function');
  } else {
    expect(typeof model.doGenerate).toBe('function');
  }

  const description = await provider.describe(model);
  expect(description).toEqual(expect.objectContaining({ providerId, modelId, modelType }));
  expect(JSON.stringify(description)).not.toContain(`${providerId}://`);
}

function modelFor(
  provider: PptaskProvider,
  modelType: PptaskModelType,
  modelId: string,
): PptaskModel {
  if (modelType === 'language') return provider.languageModel(modelId);
  if (modelType === 'video') return provider.videoModel(modelId);
  if (modelType === 'audio') return provider.audioModel(modelId);
  if (modelType === 'image') return provider.imageModel(modelId);
  throw new Error(`Unsupported model type: ${String(modelType)}`);
}
