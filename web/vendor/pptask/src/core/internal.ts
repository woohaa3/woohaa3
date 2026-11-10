import type { PptaskModel, PptaskModelType } from './types.ts';

const MODEL_TYPE = Symbol.for('@sdppp/pptask/model-type');

export function tagModel<T extends object>(model: T, modelType: PptaskModelType): T {
  Object.defineProperty(model, MODEL_TYPE, {
    value: modelType,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return model;
}

export function getModelType(model: PptaskModel): PptaskModelType {
  const modelType = (model as Record<PropertyKey, unknown>)[MODEL_TYPE];
  if (
    modelType === 'language' ||
    modelType === 'image' ||
    modelType === 'video' ||
    modelType === 'audio'
  ) {
    return modelType;
  }
  throw new Error('Model was not created by a Pptask provider');
}

export function createId(prefix: string): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (randomUUID) return `${prefix}-${randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function serializeError(error: unknown): {
  name?: string;
  message: string;
  stack?: string;
  status?: number;
  code?: string;
  retryable?: boolean;
} {
  if (error instanceof Error) {
    // ProviderHttpError 之类携带结构化字段的错误要把 status/code 带出去，
    // 否则历史只剩一句拼接字符串，无法区分鉴权失败/限流/参数错。
    const structured = error as Error & { status?: unknown; code?: unknown; retryable?: unknown };
    const status = typeof structured.status === 'number' && Number.isFinite(structured.status)
      ? structured.status
      : undefined;
    const code = typeof structured.code === 'string' && structured.code !== '' ? structured.code : undefined;
    // 只有 provider 明确表态时才带 retryable：缺省仍按错误正文推断，不能把
    // "没判断过"写成 true/false。
    const retryable = typeof structured.retryable === 'boolean' ? structured.retryable : undefined;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(status !== undefined ? { status } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
    };
  }
  return { message: String(error) };
}

export function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError',
  );
}

export function createAbortError(message: string): Error {
  try {
    return new DOMException(message, 'AbortError');
  } catch {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError('Operation aborted');
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError('Operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function sanitizePersistedInput(input: unknown): unknown {
  return sanitizeValue(input, new WeakSet<object>());
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    return value;
  }
  if (value instanceof Date || value instanceof Blob || value instanceof ArrayBuffer) return value;
  if (value instanceof URL) return value.toString();
  if (ArrayBuffer.isView(value)) return value;
  if (seen.has(value)) throw new Error('Job input must not contain circular references');
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => sanitizeValue(item, seen));
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'abortSignal' || key === 'headers') continue;
    if (isSensitiveKey(key)) continue;
    const sanitized = sanitizeValue(item, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  seen.delete(value);
  return result;
}

function isSensitiveKey(key: string): boolean {
  return /^(api[-_]?key|authorization|access[-_]?token|secret|token)$/i.test(key);
}
