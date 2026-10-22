import { describe, expect, it } from 'vitest';
import * as pptask from '../../src/index.ts';
import type { PptaskModel, PptaskModelType, PptaskProvider } from '../../src/index.ts';

type LiveCase = {
  id: string;
  create(options: Record<string, any>): PptaskProvider;
  apiKeyRequired?: boolean;
};

const factories = pptask as unknown as Record<string, (options: Record<string, any>) => PptaskProvider>;
const primary = ['Replicate', 'Runninghub', 'Crun', 'Kie', 'Apiframe', 'Grsai', 'Ppio', 'Novita', 'Ark', 'Comfy', 'OpenAI', 'Gemini'];
const modern = ['Fish', 'Deepinfra', 'Openrouter', 'Tavus', 'Scenario', 'Xai', 'Cloudflare', 'Vertex', 'Bedrock', 'Azure', 'Nvidia', 'Leonardo', 'Heygen', 'Did', 'Cartesia', 'Deepgram', 'Fireworks'];
const cases: LiveCase[] = [...primary, ...modern].map(name => ({
  id: name.toLowerCase(),
  create: factories[`create${name}Provider`],
  apiKeyRequired: name !== 'Comfy',
}));

const enabled = process.env.PPTASK_INTEGRATION === '1';

describe.skipIf(!enabled)('live provider integrations', () => {
  for (const testCase of cases) {
    const prefix = `PPTASK_${testCase.id.toUpperCase()}`;
    const apiKey = process.env[`${prefix}_API_KEY`];
    const modelId = process.env[`${prefix}_MODEL_ID`];
    const runnable = Boolean(modelId && (apiKey || !testCase.apiKeyRequired));

    it.skipIf(!runnable)(testCase.id, async () => {
      const modelType = (process.env[`${prefix}_MODEL_TYPE`] ?? 'image') as PptaskModelType;
      const input = parseJson(process.env[`${prefix}_INPUT`]) ?? {
        prompt: `PPTask AI SDK integration smoke test for ${testCase.id}`,
        n: 1,
        providerOptions: {},
      };
      const provider = testCase.create({
        apiKey,
        baseURL: process.env[`${prefix}_BASE_URL`],
        operationPath: process.env[`${prefix}_OPERATION_PATH`],
        accountId: process.env[`${prefix}_ACCOUNT_ID`],
        pollIntervalMs: Number(process.env.PPTASK_INTEGRATION_POLL_MS ?? 3000),
      });
      const model = selectModel(provider, modelType, modelId!);
      const description = await provider.describe(model);
      expect(description).toMatchObject({ providerId: testCase.id, modelId, modelType });

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Number(process.env.PPTASK_INTEGRATION_TIMEOUT_MS ?? 600_000),
      );
      try {
        const job = await provider.jobs.start({ model, input });
        const result = await job.wait({ signal: controller.signal });
        expect(result).toBeDefined();
      } finally {
        clearTimeout(timeout);
      }
    }, 620_000);
  }
});

function selectModel(provider: PptaskProvider, type: PptaskModelType, modelId: string): PptaskModel {
  if (type === 'language') return provider.languageModel(modelId);
  if (type === 'video') return provider.videoModel(modelId);
  return provider.imageModel(modelId);
}

function parseJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PPTASK_*_INPUT must be a JSON object');
  }
  return parsed;
}
