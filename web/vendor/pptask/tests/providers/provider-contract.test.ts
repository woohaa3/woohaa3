import { describe, it, vi } from 'vitest';
import {
  createApiframeProvider,
  createAzureProvider,
  createBedrockProvider,
  createCartesiaProvider,
  createCloudflareProvider,
  createComfyProvider,
  createDeepgramProvider,
  createDeepinfraProvider,
  createDidProvider,
  createFireworksProvider,
  createFishProvider,
  createGeminiProvider,
  createGrsaiProvider,
  createHeygenProvider,
  createKieProvider,
  createLeonardoProvider,
  createNvidiaProvider,
  createOpenAIProvider,
  createOpenrouterProvider,
  createScenarioProvider,
  createTavusProvider,
  createVertexProvider,
  createXaiProvider,
  type PptaskModelType,
  type PptaskProvider
} from '../../src/index.ts';
import { assertProviderContract } from '../support/provider-contract.ts';

const fetchMock = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes('/models/owner/model')) return Response.json({ name: 'owner/model' });
  return Response.json({});
}) as unknown as typeof fetch;

type Entry = [string, () => PptaskProvider, PptaskModelType, string];
const common = { apiKey: 'test-key', fetch: fetchMock };
const modern = { ...common, baseURL: 'https://provider.test', operationPath: '/run' };

const cases: Entry[] = [
  ['kie', () => createKieProvider(common), 'image', 'seedream/5-pro-text-to-image'],
  ['apiframe', () => createApiframeProvider(common), 'image', 'flux-2-pro'],
  ['grsai', () => createGrsaiProvider({ ...common, baseURL: 'https://grsai.test' }), 'image', 'nano-banana-fast'],
  ['comfy', () => createComfyProvider({ baseURL: 'https://comfy.test', fetch: fetchMock }), 'image', 'workflow-1'],
  ['openai', () => createOpenAIProvider(common), 'image', 'gpt-image-1'],
  ['gemini', () => createGeminiProvider(common), 'image', 'gemini-3-pro-image-preview'],
  ['fish', () => createFishProvider(modern), 'audio', 'tts'],
  ['deepinfra', () => createDeepinfraProvider(modern), 'image', 'owner/model'],
  ['openrouter', () => createOpenrouterProvider(modern), 'language', 'openai/gpt'],
  ['tavus', () => createTavusProvider(modern), 'video', 'replica'],
  ['scenario', () => createScenarioProvider(modern), 'image', 'model'],
  ['xai', () => createXaiProvider(modern), 'language', 'grok'],
  ['cloudflare', () => createCloudflareProvider({ ...modern, accountId: 'account' }), 'image', '@cf/model'],
  ['vertex', () => createVertexProvider(modern), 'image', 'model'],
  ['bedrock', () => createBedrockProvider(modern), 'image', 'model'],
  ['azure', () => createAzureProvider(modern), 'language', 'deployment'],
  ['nvidia', () => createNvidiaProvider(modern), 'language', 'model'],
  ['leonardo', () => createLeonardoProvider(modern), 'video', 'model'],
  ['heygen', () => createHeygenProvider(modern), 'video', 'avatar'],
  ['did', () => createDidProvider(modern), 'video', 'presenter'],
  ['cartesia', () => createCartesiaProvider(modern), 'audio', 'voice'],
  ['deepgram', () => createDeepgramProvider(modern), 'audio', 'aura'],
  ['fireworks', () => createFireworksProvider(modern), 'image', 'model'],
];

describe('provider factory contract', () => {
  for (const [providerId, create, modelType, modelId] of cases) {
    it(providerId, async () => {
      await assertProviderContract({ provider: create(), providerId, modelType, modelId });
    });
  }
});
