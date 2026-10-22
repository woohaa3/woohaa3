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
