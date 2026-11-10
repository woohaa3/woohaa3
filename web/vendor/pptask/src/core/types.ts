import type {
  Experimental_VideoModelV4,
  Experimental_VideoModelV4CallOptions,
  Experimental_VideoModelV4OperationStartResult,
  Experimental_VideoModelV4Result,
  FilesV4,
  FilesV4UploadFileCallOptions,
  FilesV4UploadFileResult,
  ImageModelV4,
  ImageModelV4CallOptions,
  ImageModelV4Result,
  JSONValue,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
  ProviderV4,
  SharedV4ProviderMetadata,
  SharedV4Warning,
  SpeechModelV4,
  SpeechModelV4CallOptions,
  SpeechModelV4Result,
} from '@ai-sdk/provider';
import type { PptaskExecutionReporter } from './execution.ts';

export type PptaskModelType = 'language' | 'image' | 'video' | 'audio';
export type PptaskJobState =
  | 'creating'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type PptaskOperationStartResult = {
  operation: JSONValue;
  warnings?: SharedV4Warning[];
  providerMetadata?: SharedV4ProviderMetadata;
  response?: {
    timestamp?: Date;
    modelId?: string;
    headers?: Record<string, string | undefined>;
  };
};

export type PptaskOperationStatusResult<RESULT extends object> =
  | {
      status: 'pending';
      phase?: 'queued' | 'running';
      progress?: number;
      providerMetadata?: SharedV4ProviderMetadata;
    }
  | ({ status: 'completed' } & RESULT)
  | {
      status: 'error';
      error: string;
      /**
       * 稳定失败码（provider 声明时才有）。会随任务记录一起落到错误里，
       * 让"同一个正文、不同处置"的失败可区分（如 `worker-lost` vs `unavailable`）。
       */
      code?: string;
      /**
       * 该失败值不值得重新提交。只有 provider 明确表态时才带：
       * 缺省表示"按错误正文推断"，`false` 表示重试也没用。
       */
      retryable?: boolean;
      providerMetadata?: SharedV4ProviderMetadata;
    };

export type PptaskOperationContext = {
  jobId: string;
};

export type PptaskOperationMethods<CALL_OPTIONS, RESULT extends object> = {
  doStart?: (
    options: CALL_OPTIONS,
    context?: PptaskOperationContext,
  ) => PromiseLike<PptaskOperationStartResult>;
  doStatus?: (options: {
    operation: JSONValue;
    abortSignal?: AbortSignal;
    headers?: Record<string, string | undefined>;
  }) => PromiseLike<PptaskOperationStatusResult<RESULT>>;
  doCancel?: (options: {
    operation: JSONValue;
    abortSignal?: AbortSignal;
    headers?: Record<string, string | undefined>;
  }) => PromiseLike<void>;
  doDescribe?: () => PromiseLike<PptaskDescription>;
};

export type PptaskLanguageModel = LanguageModelV4 &
  PptaskOperationMethods<LanguageModelV4CallOptions, LanguageModelV4GenerateResult>;
export type PptaskImageModel = ImageModelV4 &
  PptaskOperationMethods<ImageModelV4CallOptions, ImageModelV4Result>;
export type PptaskVideoModel = Omit<Experimental_VideoModelV4, 'doStart'> & {
  doStart?: (
    options: Experimental_VideoModelV4CallOptions & { webhookUrl?: string },
    context?: PptaskOperationContext,
  ) => PromiseLike<Experimental_VideoModelV4OperationStartResult>;
  doCancel?: PptaskOperationMethods<
    Experimental_VideoModelV4CallOptions,
    Experimental_VideoModelV4Result
  >['doCancel'];
  doDescribe?: () => PromiseLike<PptaskDescription>;
};

// pptask: audio extension (fork). Upstream pptask has no audio model kind; the
// shape is anchored on the AI SDK's SpeechModelV4 so an audio model stays
// usable by `ai`'s generateSpeech / customProvider({ speechModels }).
export type PptaskAudioOutput =
  | { type: 'url'; url: string; mediaType?: string }
  | { type: 'base64'; data: string; mediaType?: string };

/**
 * `SpeechModelV4Result` plus every generated output. `audio` mirrors the first
 * entry of `audios` and is materialised to base64/bytes — the AI SDK treats a
 * string `audio` as base64 and has no URL branch, so it must never hold a URL.
 */
export type PptaskAudioResult = SpeechModelV4Result & {
  audios?: PptaskAudioOutput[];
};

export type PptaskAudioModel = Omit<SpeechModelV4, 'doGenerate'> &
  PptaskOperationMethods<SpeechModelV4CallOptions, PptaskAudioResult> & {
    doGenerate(
      options: SpeechModelV4CallOptions,
    ): PromiseLike<PptaskAudioResult>;
  };
export type PptaskModel =
  | PptaskLanguageModel
  | PptaskImageModel
  | PptaskVideoModel
  | PptaskAudioModel;

export type PptaskLanguageModelImplementation = Pick<LanguageModelV4, 'supportedUrls'> &
  Partial<Pick<LanguageModelV4, 'doGenerate' | 'doStream'>> &
  PptaskOperationMethods<LanguageModelV4CallOptions, LanguageModelV4GenerateResult>;
export type PptaskImageModelImplementation = Pick<ImageModelV4, 'maxImagesPerCall'> &
  Partial<Pick<ImageModelV4, 'doGenerate'>> &
  PptaskOperationMethods<ImageModelV4CallOptions, ImageModelV4Result>;
export type PptaskVideoModelImplementation = Omit<
  Experimental_VideoModelV4,
  'specificationVersion' | 'provider' | 'modelId' | 'doStart'
> & {
  doStart?: PptaskVideoModel['doStart'];
  doCancel?: PptaskVideoModel['doCancel'];
  doDescribe?: () => PromiseLike<PptaskDescription>;
};

export type PptaskAudioModelImplementation = Partial<
  Pick<SpeechModelV4, 'doGenerate'>
> &
  PptaskOperationMethods<SpeechModelV4CallOptions, PptaskAudioResult>;

export type PptaskDescription = {
  providerId: string;
  modelId: string;
  modelType: PptaskModelType;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  defaultInput?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  providerMetadata?: SharedV4ProviderMetadata;
};

export type PptaskSerializedError = {
  name?: string;
  message: string;
  stack?: string;
  /** 上游 HTTP 状态码（ProviderHttpError 才有）。 */
  status?: number;
  /** 上游业务错误码（ProviderHttpError 才有）。 */
  code?: string;
  /**
   * 是否值得重试。只有 provider 明确表态时才带：
   * 缺省表示"按错误正文推断"（沿用既有的瞬时错误判定），`false` 表示重试也没用。
   */
  retryable?: boolean;
};

export type PptaskJobRecord<RESULT = unknown> = {
  schemaVersion: 1;
  id: string;
  providerId: string;
  modelType: PptaskModelType;
  modelId: string;
  state: PptaskJobState;
  input: unknown;
  metadata?: Record<string, unknown>;
  operation?: JSONValue;
  progress?: number;
  result?: RESULT;
  error?: PptaskSerializedError;
  startedAt?: string;
  finishedAt?: string;
  transitions?: PptaskJobTransition[];
  createdAt: string;
  updatedAt: string;
};

export type PptaskJobTransition = {
  at: string;
  type: 'created' | 'submitting' | 'accepted' | 'progress' | 'succeeded' | 'failed' | 'cancelled';
  state: PptaskJobState;
  progress?: number;
};

export type PptaskJobFilter = {
  states?: PptaskJobState[];
  providerId?: string;
  modelId?: string;
};

/**
 * In-process storage boundary for the jobs engine. Implementations are
 * ephemeral by design: durability and recovery belong to the scheduling layer
 * above (the worker), which snapshots records into its own store and
 * rehydrates them here. `create` is a plain insert — dedup is a scheduling
 * policy, not a job-repository concern.
 */
export type PptaskJobRepository = {
  get<RESULT = unknown>(id: string): Promise<PptaskJobRecord<RESULT> | undefined>;
  create(record: PptaskJobRecord): Promise<{
    record: PptaskJobRecord;
    created: boolean;
  }>;
  put(record: PptaskJobRecord): Promise<void>;
  update<RESULT = unknown>(
    id: string,
    updater: (record: PptaskJobRecord<RESULT>) => PptaskJobRecord<RESULT>,
  ): Promise<PptaskJobRecord<RESULT>>;
  list(filter?: PptaskJobFilter): Promise<PptaskJobRecord[]>;
  delete(id: string): Promise<void>;
  subscribe?(listener: (change: PptaskJobRepositoryChange) => void): () => void;
};

export type PptaskJobRepositoryChange = {
  type: 'created' | 'updated' | 'deleted';
  job: PptaskJobRecord;
};

export type PptaskJobEvent<RESULT = unknown> = {
  type: 'state';
  job: PptaskJobRecord<RESULT>;
};

export type PptaskJobListener = (event: PptaskJobEvent) => void;

export type PptaskJobHandle<RESULT = unknown> = {
  readonly id: string;
  readonly record: PptaskJobRecord<RESULT>;
  status(options?: PptaskJobCallOptions): Promise<PptaskJobRecord<RESULT>>;
  watch(options?: PptaskJobCallOptions): AsyncIterable<PptaskJobEvent<RESULT>>;
  wait(options?: PptaskJobCallOptions): Promise<RESULT>;
  cancel(options?: PptaskJobCallOptions): Promise<void>;
};

export type PptaskJobCallOptions = {
  signal?: AbortSignal;
  headers?: Record<string, string | undefined>;
};

export type PptaskJobs = {
  start<RESULT = unknown>(options: {
    model: PptaskModel;
    input: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<PptaskJobHandle<RESULT>>;
  resume<RESULT = unknown>(jobId: string): Promise<PptaskJobHandle<RESULT>>;
  status<RESULT = unknown>(jobId: string, options?: PptaskJobCallOptions): Promise<PptaskJobRecord<RESULT>>;
  watch<RESULT = unknown>(jobId: string, options?: PptaskJobCallOptions): AsyncIterable<PptaskJobEvent<RESULT>>;
  wait<RESULT = unknown>(jobId: string, options?: PptaskJobCallOptions): Promise<RESULT>;
  updateResult<RESULT = unknown>(jobId: string, result: RESULT): Promise<PptaskJobRecord<RESULT>>;
  cancel(jobId: string, options?: PptaskJobCallOptions): Promise<void>;
  list(filter?: PptaskJobFilter): Promise<PptaskJobRecord[]>;
  subscribe(listener: PptaskJobListener): () => void;
};

export type PptaskUploadOptions = FilesV4UploadFileCallOptions;
export type PptaskUploadResult = FilesV4UploadFileResult;

/**
 * Scheduling-side execution facts, emitted by a worker around its claim,
 * retry, and settle decisions. Pure type contract shared between the worker
 * (emitter) and execution-history (projector); core itself has no worker.
 */
export type PptaskSchedulingStage =
  | 'enqueued'
  | 'claimed'
  | 'lease-lost'
  | 'provider-missing'
  | 'transient-retry'
  | 'unfail-retry'
  | 'task-completed'
  | 'task-failed'
  | 'task-cancelled';

export type PptaskSchedulingEvent = {
  stage: PptaskSchedulingStage;
  jobId: string;
  providerId: string;
  attempt?: number;
  consecutiveFailures?: number;
  detail?: unknown;
  at: string;
};

export type CreatePptaskProviderOptions = {
  providerId: string;
  languageModel?: (modelId: string) => PptaskLanguageModelImplementation;
  imageModel?: (modelId: string) => PptaskImageModelImplementation;
  videoModel?: (modelId: string) => PptaskVideoModelImplementation;
  audioModel?: (modelId: string) => PptaskAudioModelImplementation;
  files?: FilesV4;
  /** Persistence adapter for durable Pptask jobs. */
  jobRepository?: PptaskJobRepository;
  pollIntervalMs?: number;
  maxStatusErrors?: number;
  /** Receives execution facts in addition to the process-wide Pptask feed. */
  executionReporter?: PptaskExecutionReporter;
};

export type PptaskProvider = Omit<
  ProviderV4,
  'languageModel' | 'imageModel' | 'videoModel'
> & {
  readonly providerId: string;
  languageModel(modelId: string): PptaskLanguageModel;
  imageModel(modelId: string): PptaskImageModel;
  videoModel(modelId: string): PptaskVideoModel;
  audioModel(modelId: string): PptaskAudioModel;
  describe(model: PptaskModel): Promise<PptaskDescription>;
  upload(options: PptaskUploadOptions): Promise<PptaskUploadResult>;
  jobs: PptaskJobs;
};

export type PptaskLanguageGenerateResult = LanguageModelV4GenerateResult;
export type PptaskLanguageStreamResult = LanguageModelV4StreamResult;
