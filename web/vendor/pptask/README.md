# PPTask

`@sdppp/pptask` extends Vercel AI SDK providers with remote job execution.
Every factory returns one provider that supports both the standard AI SDK model
methods and an explicit in-process `jobs` API. Job state is ephemeral: it lives
for the lifetime of the process, and durability plus recovery belong to the
scheduling layer (`@sdppp/pptask-worker`).

## Core API

```ts
import { generateImage } from 'ai';
import { createReplicateProvider } from '@sdppp/pptask';

const replicate = createReplicateProvider({ apiKey: 'REPLICATE_API_TOKEN' });
const model = replicate.imageModel('black-forest-labs/flux-schnell');

// In-process jobs API. The drive runs while this process is alive.
const job = await replicate.jobs.start({
  model,
  input: { prompt: 'A clean product photograph', n: 1, providerOptions: {} },
});
const result = await job.wait();

// Standard AI SDK API. The same model waits for the remote operation internally.
const sdkResult = await generateImage({
  model,
  prompt: 'A clean product photograph',
});
```

Models add four operation methods while retaining their AI SDK interfaces:

- `doStart`: creates the remote operation.
- `doStatus`: polls the remote operation and returns pending/completed/error.
- `doCancel`: cancels when the upstream platform supports it.
- `doDescribe`: returns model metadata and input schema.

The provider adds:

- `provider.describe(model)`
- `provider.upload(options)` using AI SDK `FilesV4`
- `provider.jobs.start/resume/status/watch/wait/cancel/list`

Every provider also reports execution facts through the process-wide feed. This
covers both the durable `jobs` API and standard AI SDK calls such as
`generateText`, `generateImage`, and `streamText`:

```ts
import { subscribePptaskExecutions } from '@sdppp/pptask';

const unsubscribe = subscribePptaskExecutions(event => {
  // Forward the event to an execution history or application-owned sink.
});
```

Applications that need a private sink can pass `executionReporter` when creating
a provider. Pptask reports facts only; retention, projection, and presentation
belong to the consumer. Durable jobs remain the replayable source for recovery,
while direct AI SDK calls are observable for the lifetime of the process.

Model IDs are plain provider model IDs. The library does not use URL locators to
encode provider, model, operation, or credentials.

## Job State

The engine's job repository is an in-process boundary (`createMemoryJobRepository`
by default; inject a custom one via the provider's `jobRepository` option).
Records are not durable across restarts and the engine performs no dedup —
every `jobs.start` call creates an independent job. Durability, dedup, and
recovery belong to the worker (`@sdppp/pptask-worker`), whose task store is the
single source of truth.

Before records are written, request headers, abort signals, API keys, access
tokens, secrets, and other credential fields are removed from job input.

## Provider Factories

Primary factories:

```text
createReplicateProvider     createRunninghubProvider
createCrunProvider          createKieProvider
createApiframeProvider      createGrsaiProvider
createPpioProvider          createNovitaProvider
createArkProvider           createComfyProvider
createOpenAIProvider        createGeminiProvider
```

Modern platform factories:

```text
createFishProvider          createDeepinfraProvider
createOpenrouterProvider    createTavusProvider
createScenarioProvider      createXaiProvider
createCloudflareProvider    createVertexProvider
createBedrockProvider       createAzureProvider
createNvidiaProvider        createLeonardoProvider
createHeygenProvider        createDidProvider
createCartesiaProvider      createDeepgramProvider
createFireworksProvider
```

Each primary provider is also available from a tree-shakeable subpath such as
`@sdppp/pptask/providers/replicate`. Modern factories are exported from
`@sdppp/pptask/providers/modern`.

RunningHub accepts `api/<model-path>` and `app/<webapp-id>` model IDs. ComfyUI
receives its server in `baseURL` and uses `modelId` as the workflow identifier.
Modern providers whose API operation cannot be inferred from the model require
`operationPath` in their provider options.

## Custom Providers

Use `createPptaskProvider` to implement a platform directly with AI SDK-shaped
models. Asynchronous image and language models can implement `doStart` and
`doStatus`; `doGenerate` is synthesized for official AI SDK calls. Video models
use the AI SDK's native `doStart` and `doStatus` operation shape.

```ts
import { createPptaskProvider } from '@sdppp/pptask';

const provider = createPptaskProvider({
  providerId: 'example',
  imageModel: modelId => ({
    maxImagesPerCall: 1,
    async doStart(options, context) {
      return { operation: { taskId: await createRemoteTask(modelId, options, context) } };
    },
    async doStatus({ operation, abortSignal }) {
      return checkRemoteTask(operation, abortSignal);
    },
  }),
});
```

Provider implementations are private to each factory; there is no public
backend-adapter registry or externally supplied job runtime.

## Tests

```bash
pnpm test             # unit, provider protocol, and contract tests
pnpm typecheck
pnpm build
```

Live integrations are opt-in because they require credentials and may incur
provider costs:

```bash
PPTASK_INTEGRATION=1 \
PPTASK_REPLICATE_API_KEY=... \
PPTASK_REPLICATE_MODEL_ID=owner/model \
PPTASK_REPLICATE_MODEL_TYPE=image \
pnpm test:integration
```

Every provider uses the same variable pattern:
`PPTASK_<PROVIDER>_API_KEY`, `PPTASK_<PROVIDER>_MODEL_ID`, optional
`PPTASK_<PROVIDER>_MODEL_TYPE`, `PPTASK_<PROVIDER>_BASE_URL`,
`PPTASK_<PROVIDER>_OPERATION_PATH`, and JSON `PPTASK_<PROVIDER>_INPUT`.
