import type {
  FilesV4,
  JSONValue,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import type {
  PptaskDescription,
  PptaskJobRepository,
  PptaskModelType,
  PptaskOperationContext,
} from '../../core/types.ts';

export type CommonProviderOptions = {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  jobRepository?: PptaskJobRepository;
  pollIntervalMs?: number;
};

export type HttpRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: BodyInit | null;
};

export type HttpExecutionContext = {
  modelId: string;
  modelType: PptaskModelType;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string | undefined>;
  operationContext?: PptaskOperationContext;
};

/**
 * 已完成的异步结果交给 Provider 做最终定形时的上下文。
 *
 * 默认归一化（`languageResult` / `imageResult` / `audioResult` / `videoResult`）只认识
 * URL / base64 输出；需要返回稳定引用的本机 Provider（例如 `{ media }`）在这里接手，
 * 不必把字节塞进 AI SDK 的输出数组。
 */
export type HttpCompletedResultContext = HttpExecutionContext & {
  /** Provider 自己的原始输出（通常是 `status.output`）。 */
  output: unknown;
  metadata?: Record<string, JSONValue>;
  /** 与本次执行同一个 fetch（出网守卫、超时与凭据都由它负责）。 */
  fetch: typeof globalThis.fetch;
  /** 可持久化的执行句柄，供完成钩子补取内容或读取上游 metadata。 */
  operation?: JSONValue;
};

export type HttpStatus =
  | {
      state: 'pending';
      phase?: 'queued' | 'running';
      progress?: number;
      metadata?: Record<string, JSONValue>;
    }
  | {
      state: 'completed';
      output: unknown;
      metadata?: Record<string, JSONValue>;
    }
  | {
      state: 'failed';
      error: string;
      metadata?: Record<string, JSONValue>;
    };

export type HttpProviderProtocol = {
  providerId: string;
  fetch: typeof globalThis.fetch;
  modelTypes?: readonly PptaskModelType[];
  validateModel?(modelId: string, modelType: PptaskModelType): void;
  mode(modelId: string, modelType: PptaskModelType): 'sync' | 'async';
  execute?(context: HttpExecutionContext): Promise<unknown>;
  start?(context: HttpExecutionContext): Promise<{
    operation: JSONValue;
    metadata?: Record<string, JSONValue>;
  }>;
  status(context: HttpExecutionContext & { operation: JSONValue }): Promise<HttpStatus>;
  /**
   * 异步任务进入 `completed` 时的结果钩子。
   *
   * 返回非 `undefined` 时原样作为 completed 结果（例如稳定媒体引用 `{ media }`），
   * 不再走内置的 `languageResult` / `imageResult` / `audioResult` / `videoResult`
   * 归一化；缺省或返回 `undefined` 时完全保持原有行为。
   */
  completeResult?(context: HttpCompletedResultContext): Promise<unknown | undefined> | unknown;
  cancel?(context: HttpExecutionContext & { operation: JSONValue }): Promise<void>;
  describe?(modelId: string, modelType: PptaskModelType): Promise<PptaskDescription>;
  files?: FilesV4;
};

export type NormalizedProviderConfig = {
  apiKey?: string;
  baseURL: string;
  fetch: typeof globalThis.fetch;
  headers: Record<string, string>;
};

export function providerMetadata(
  providerId: string,
  value: Record<string, JSONValue> = {},
): SharedV4ProviderMetadata {
  return { [providerId]: value };
}
