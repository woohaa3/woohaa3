import type {
  Experimental_VideoModelV4CallOptions,
  ImageModelV4CallOptions,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  JSONValue,
  SpeechModelV4CallOptions,
} from '@ai-sdk/provider';
import { emitPptaskExecution, type PptaskExecutionReporter } from './execution.ts';
import { createId, delay, serializeError, tagModel, throwIfAborted } from './internal.ts';
import type {
  PptaskAudioModel,
  PptaskAudioModelImplementation,
  PptaskImageModel,
  PptaskImageModelImplementation,
  PptaskLanguageModel,
  PptaskLanguageModelImplementation,
  PptaskModel,
  PptaskOperationContext,
  PptaskOperationStartResult,
  PptaskOperationStatusResult,
  PptaskVideoModel,
  PptaskVideoModelImplementation,
} from './types.ts';

export type PptaskModelExecutionContext = {
  executionId: string;
  jobId?: string;
  /** Job metadata (e.g. `taskKey`) forwarded onto execution facts. */
  metadata?: Record<string, unknown>;
  reporter?: PptaskExecutionReporter;
};

type PptaskModelExecutor = {
  generate(options: unknown, context: PptaskModelExecutionContext): Promise<unknown>;
};

const MODEL_EXECUTOR = Symbol.for('@sdppp/pptask/model-executor');

export function executePptaskModelGenerate(
  model: PptaskModel,
  options: unknown,
  context: PptaskModelExecutionContext,
): Promise<unknown> {
  const executor = (model as Record<PropertyKey, unknown>)[MODEL_EXECUTOR] as PptaskModelExecutor | undefined;
  if (executor) return Promise.resolve(executor.generate(options, context));
  if (!model.doGenerate) throw new Error('Model does not support generation');
  return Promise.resolve(model.doGenerate(options as never));
}

export function createLanguageModel(
  providerId: string,
  modelId: string,
  implementation: PptaskLanguageModelImplementation,
  pollIntervalMs: number,
  reporter?: PptaskExecutionReporter,
): PptaskLanguageModel {
  const generate = (options: LanguageModelV4CallOptions, context?: PptaskModelExecutionContext) =>
    reportGenerate(
      reporter,
      'language',
      providerId,
      modelId,
      options,
      context,
      execution => implementation.doGenerate
        ? Promise.resolve(implementation.doGenerate(options))
        : runOperation(implementation, options, pollIntervalMs, execution, providerId, modelId, 'language', reporter),
    );
  const doGenerate = async (options: LanguageModelV4CallOptions) => generate(options);
  const doStream = implementation.doStream
    ? (options: LanguageModelV4CallOptions) => reportStream(
      reporter,
      'language',
      providerId,
      modelId,
      options,
      Promise.resolve(implementation.doStream!(options)),
    )
    : async (options: LanguageModelV4CallOptions) => {
    const result = await generate(options);
    return {
      stream: streamLanguageResult(result),
      request: result.request,
      response: result.response ? { headers: result.response.headers } : undefined,
    };
  };

  const model = tagModel({
    specificationVersion: 'v4' as const,
    provider: providerId,
    modelId,
    supportedUrls: implementation.supportedUrls,
    doGenerate,
    doStream,
    doStart: implementation.doStart,
    doStatus: implementation.doStatus,
    doCancel: implementation.doCancel,
    doDescribe: implementation.doDescribe,
  }, 'language');
  return attachExecutor(model, generate) as PptaskLanguageModel;
}

export function createImageModel(
  providerId: string,
  modelId: string,
  implementation: PptaskImageModelImplementation,
  pollIntervalMs: number,
  reporter?: PptaskExecutionReporter,
): PptaskImageModel {
  const generate = (options: ImageModelV4CallOptions, context?: PptaskModelExecutionContext) =>
    reportGenerate(
      reporter,
      'image',
      providerId,
      modelId,
      options,
      context,
      execution => implementation.doGenerate
        ? Promise.resolve(implementation.doGenerate(options))
        : runOperation(implementation, options, pollIntervalMs, execution, providerId, modelId, 'image', reporter),
    );
  const model = tagModel({
    specificationVersion: 'v4' as const,
    provider: providerId,
    modelId,
    maxImagesPerCall: implementation.maxImagesPerCall,
    doGenerate: async (options: ImageModelV4CallOptions) => generate(options),
    doStart: implementation.doStart,
    doStatus: implementation.doStatus,
    doCancel: implementation.doCancel,
    doDescribe: implementation.doDescribe,
  }, 'image');
  return attachExecutor(model, generate) as PptaskImageModel;
}

export function createAudioModel(
  providerId: string,
  modelId: string,
  implementation: PptaskAudioModelImplementation,
  pollIntervalMs: number,
  reporter?: PptaskExecutionReporter,
): PptaskAudioModel {
  const generate = (
    options: SpeechModelV4CallOptions,
    context?: PptaskModelExecutionContext,
  ) =>
    reportGenerate(
      reporter,
      'audio',
      providerId,
      modelId,
      options,
      context,
      execution => implementation.doGenerate
        ? Promise.resolve(implementation.doGenerate(options))
        : runOperation(implementation, options, pollIntervalMs, execution, providerId, modelId, 'audio', reporter),
    );
  const model = tagModel({
    specificationVersion: 'v4' as const,
    provider: providerId,
    modelId,
    doGenerate: async (options: SpeechModelV4CallOptions) => generate(options),
    doStart: implementation.doStart,
    doStatus: implementation.doStatus,
    doCancel: implementation.doCancel,
    doDescribe: implementation.doDescribe,
  }, 'audio');
  return attachExecutor(model, generate) as PptaskAudioModel;
}

export function createVideoModel(
  providerId: string,
  modelId: string,
  implementation: PptaskVideoModelImplementation,
  reporter?: PptaskExecutionReporter,
): PptaskVideoModel {
  const generate = implementation.doGenerate
    ? (options: Experimental_VideoModelV4CallOptions, context?: PptaskModelExecutionContext) => reportGenerate(
      reporter,
      'video',
      providerId,
      modelId,
      options,
      context,
      () => Promise.resolve(implementation.doGenerate!(options)),
    )
    : undefined;
  const model = tagModel({
    ...implementation,
    specificationVersion: 'v4' as const,
    provider: providerId,
    modelId,
    ...(generate ? { doGenerate: async (options: Experimental_VideoModelV4CallOptions) => generate(options) } : {}),
  }, 'video') as PptaskVideoModel;
  return generate ? attachExecutor(model, generate) as PptaskVideoModel : model;
}

function attachExecutor<T extends object, OPTIONS>(
  model: T,
  generate: (options: OPTIONS, context?: PptaskModelExecutionContext) => Promise<unknown>,
): T {
  Object.defineProperty(model, MODEL_EXECUTOR, {
    value: { generate: (options: unknown, context: PptaskModelExecutionContext) => generate(options as OPTIONS, context) },
    enumerable: false,
  });
  return model;
}

function reportGenerate<OPTIONS, RESULT>(
  reporter: PptaskExecutionReporter | undefined,
  modelType: 'language' | 'image' | 'video' | 'audio',
  providerId: string,
  modelId: string,
  options: OPTIONS,
  context: PptaskModelExecutionContext | undefined,
  execute: (context: PptaskModelExecutionContext) => PromiseLike<RESULT>,
): Promise<RESULT> {
  const execution: PptaskModelExecutionContext = context ?? { executionId: createId('execution') };
  const eventReporter = context?.reporter ?? reporter;
  emitPptaskExecution(eventReporter, {
    type: 'started',
    executionId: execution.executionId,
    jobId: execution.jobId,
    metadata: execution.metadata,
    providerId,
    modelType,
    modelId,
    at: new Date().toISOString(),
    detail: context?.jobId
      ? { hasInput: options !== undefined, transition: 'submitting' }
      : { hasInput: options !== undefined },
  });
  return Promise.resolve(execute(execution)).then(result => {
    emitPptaskExecution(eventReporter, {
      type: 'succeeded',
      executionId: execution.executionId,
      jobId: execution.jobId,
      metadata: execution.metadata,
      providerId,
      modelType,
      modelId,
      at: new Date().toISOString(),
      detail: context?.jobId ? { transition: 'succeeded' } : undefined,
      result,
    });
    return result;
  }, error => {
    emitPptaskExecution(eventReporter, {
      type: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed',
      executionId: execution.executionId,
      jobId: execution.jobId,
      metadata: execution.metadata,
      providerId,
      modelType,
      modelId,
      at: new Date().toISOString(),
      detail: context?.jobId ? { transition: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed' } : undefined,
      error: serializeError(error),
    });
    throw error;
  });
}

async function reportStream<RESULT extends { stream: ReadableStream<unknown> }>(
  reporter: PptaskExecutionReporter | undefined,
  modelType: 'language' | 'image' | 'video',
  providerId: string,
  modelId: string,
  options: unknown,
  resultPromise: PromiseLike<RESULT>,
): Promise<RESULT> {
  const executionId = createId('execution');
  const eventReporter = reporter;
  emitPptaskExecution(eventReporter, {
    type: 'started', executionId, providerId, modelType, modelId,
    at: new Date().toISOString(), detail: { hasInput: options !== undefined },
  });
  try {
    const result = await resultPromise;
    return {
      ...result,
      stream: observeStream(result.stream, () => emitPptaskExecution(eventReporter, {
        type: 'succeeded', executionId, providerId, modelType, modelId, at: new Date().toISOString(),
      }), error => emitPptaskExecution(eventReporter, {
        type: 'failed', executionId, providerId, modelType, modelId, at: new Date().toISOString(), error: serializeError(error),
      }), reason => emitPptaskExecution(eventReporter, {
        type: 'cancelled', executionId, providerId, modelType, modelId, at: new Date().toISOString(), error: serializeError(reason),
      })),
    } as RESULT;
  } catch (error) {
    emitPptaskExecution(eventReporter, {
      type: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed', executionId, providerId, modelType, modelId,
      at: new Date().toISOString(), error: serializeError(error),
    });
    throw error;
  }
}

function observeStream<T>(
  stream: ReadableStream<T>,
  onComplete: () => void,
  onError: (error: unknown) => void,
  onCancel: (reason: unknown) => void,
): ReadableStream<T> {
  let settled = false;
  const settle = (callback: () => void) => {
    if (settled) return;
    settled = true;
    callback();
  };
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settle(onComplete);
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        settle(() => onError(error));
        controller.error(error);
      }
    },
    async cancel(reason) {
      settle(() => onCancel(reason));
      await reader.cancel(reason);
    },
  });
}

async function runOperation<OPTIONS, RESULT extends object>(
  implementation: {
    doStart?: (
      options: OPTIONS,
      context?: PptaskOperationContext,
    ) => PromiseLike<PptaskOperationStartResult>;
    doStatus?: (options: {
      operation: JSONValue;
      abortSignal?: AbortSignal;
      headers?: Record<string, string | undefined>;
    }) => PromiseLike<
      PptaskOperationStatusResult<RESULT>
    >;
  },
  options: OPTIONS & {
    abortSignal?: AbortSignal;
    headers?: Record<string, string | undefined>;
  },
  pollIntervalMs: number,
  execution: PptaskModelExecutionContext,
  providerId: string,
  modelId: string,
  modelType: 'language' | 'image' | 'audio',
  reporter?: PptaskExecutionReporter,
): Promise<RESULT> {
  if (!implementation.doStart || !implementation.doStatus) {
    throw new Error('Model must implement doGenerate or both doStart and doStatus');
  }
  const started = await implementation.doStart(options, {
    jobId: execution.executionId,
  });
  emitPptaskExecution(execution.reporter ?? reporter, {
    type: 'progress',
    executionId: execution.executionId,
    jobId: execution.jobId,
    providerId,
    modelType,
    modelId,
    at: new Date().toISOString(),
    state: 'pending',
    detail: { phase: 'accepted' },
    operation: started.operation,
  });
  while (true) {
    throwIfAborted(options.abortSignal);
    const status = await implementation.doStatus({
      operation: started.operation,
      abortSignal: options.abortSignal,
      headers: options.headers,
    });
    if (status.status === 'completed') {
      const { status: _status, ...result } = status;
      return result as RESULT;
    }
    if (status.status === 'error') throw new Error(status.error);
    emitPptaskExecution(execution.reporter ?? reporter, {
      type: 'progress',
      executionId: execution.executionId,
      jobId: execution.jobId,
      providerId,
      modelType,
      modelId,
      at: new Date().toISOString(),
      progress: status.progress,
      state: status.phase,
      detail: { phase: status.phase },
    });
    await delay(pollIntervalMs, options.abortSignal);
  }
}

function streamLanguageResult(result: LanguageModelV4GenerateResult): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: result.warnings });
      if (result.response) {
        controller.enqueue({
          type: 'response-metadata',
          id: result.response.id,
          timestamp: result.response.timestamp,
          modelId: result.response.modelId,
        });
      }
      for (const content of result.content) enqueueContent(controller, content);
      controller.enqueue({
        type: 'finish',
        usage: result.usage,
        finishReason: result.finishReason,
        providerMetadata: result.providerMetadata,
      });
      controller.close();
    },
  });
}

function enqueueContent(
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
  content: LanguageModelV4Content,
): void {
  if (content.type === 'text') {
    const id = createId('text');
    controller.enqueue({ type: 'text-start', id, providerMetadata: content.providerMetadata });
    controller.enqueue({ type: 'text-delta', id, delta: content.text, providerMetadata: content.providerMetadata });
    controller.enqueue({ type: 'text-end', id, providerMetadata: content.providerMetadata });
    return;
  }
  if (content.type === 'reasoning') {
    const id = createId('reasoning');
    controller.enqueue({ type: 'reasoning-start', id, providerMetadata: content.providerMetadata });
    controller.enqueue({ type: 'reasoning-delta', id, delta: content.text, providerMetadata: content.providerMetadata });
    controller.enqueue({ type: 'reasoning-end', id, providerMetadata: content.providerMetadata });
    return;
  }
  controller.enqueue(content);
}
