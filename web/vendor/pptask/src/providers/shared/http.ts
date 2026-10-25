import type { FilesV4UploadFileCallOptions } from '@ai-sdk/provider';
import type { CommonProviderOptions, HttpRequest, NormalizedProviderConfig } from './types.ts';

export function normalizeProviderConfig(
  providerId: string,
  options: CommonProviderOptions,
  defaultBaseURL: string,
  requireApiKey = true,
): NormalizedProviderConfig {
  const apiKey = options.apiKey?.trim();
  if (requireApiKey && !apiKey) throw new Error(`${providerId} apiKey is required`);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error(`${providerId} provider requires fetch`);
  return {
    apiKey,
    baseURL: (options.baseURL ?? defaultBaseURL).replace(/\/+$/, ''),
    fetch: fetchImpl,
    headers: { ...options.headers },
  };
}

/**
 * 上游 HTTP 失败的结构化错误。
 *
 * 历史/排障需要 status 与上游业务码本身，而不是从拼接字符串里正则反推
 * （重试判定曾经依赖 message 正则，body 里出现 429 字样会被误判）。
 * 响应体只保留有界摘要，绝不整包透传。
 */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly bodyText?: string;
  constructor(providerId: string, status: number, bodyText: string, statusText: string) {
    super(`${providerId} request failed (${status}): ${bodyText || statusText}`);
    this.name = 'ProviderHttpError';
    this.status = status;
    const code = extractUpstreamCode(bodyText);
    if (code !== undefined) this.code = code;
    const trimmed = bodyText.trim();
    if (trimmed !== '') this.bodyText = trimmed.slice(0, MAX_ERROR_BODY_CHARS);
  }
}

/** 错误体保留上限：够看清上游错误，又不会把整包响应写进历史。 */
const MAX_ERROR_BODY_CHARS = 2_000;

/** 从上游错误体里提取稳定业务码（各家用不同字段名，取第一个字符串/数字命中）。 */
function extractUpstreamCode(bodyText: string): string | undefined {
  const text = bodyText.trim();
  if (text === '' || !text.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const root = parsed as Record<string, unknown>;
  const nested = typeof root.error === 'object' && root.error !== null ? (root.error as Record<string, unknown>) : undefined;
  const baseResp = typeof root.base_resp === 'object' && root.base_resp !== null
    ? (root.base_resp as Record<string, unknown>)
    : undefined;
  const candidates = [
    root.code,
    root.error_code,
    root.errorCode,
    root.status_code,
    nested?.code,
    nested?.type,
    baseResp?.status_code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().slice(0, 120);
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return undefined;
}

export async function request(
  fetchImpl: typeof globalThis.fetch,
  providerId: string,
  descriptor: HttpRequest,
  signal?: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(descriptor.url, {
      method: descriptor.method,
      headers: definedHeaders(descriptor.headers),
      body: descriptor.body,
      signal,
    });
  } catch (error) {
    // Host credential fencing is an execution-control fact, not a retryable network failure.
    if (error && typeof error === 'object' && (error as { sourceStale?: boolean }).sourceStale) throw error;
    const nested = error && typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined;
    const cause = nested instanceof Error
      ? nested.message
      : error instanceof Error ? error.message : String(error);
    const target = new URL(descriptor.url).origin;
    throw new Error(`${providerId} request could not reach ${target}: ${cause}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderHttpError(providerId, response.status, body, response.statusText);
  }
  return response;
}

export async function requestJson<T = any>(
  fetchImpl: typeof globalThis.fetch,
  providerId: string,
  descriptor: HttpRequest,
  signal?: AbortSignal,
): Promise<T> {
  const response = await request(fetchImpl, providerId, descriptor, signal);
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${providerId} returned invalid JSON (${response.status})`);
  }
}

export async function uploadBlob(options: FilesV4UploadFileCallOptions): Promise<Blob> {
  if (options.data.type === 'text') {
    return new Blob([options.data.text], { type: options.mediaType });
  }
  if (options.data.type === 'data') {
    const data = typeof options.data.data === 'string'
      ? base64ToBytes(options.data.data)
      : options.data.data;
    return new Blob([data as BlobPart], { type: options.mediaType });
  }
  const blob = await new Response(options.data.stream).blob();
  return blob.type ? blob : new Blob([blob], { type: options.mediaType });
}

export function definedHeaders(
  headers?: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function mergeHeaders(
  ...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (value !== undefined) result[key] = value;
    }
  }
  return result;
}

export function jsonRequest(
  url: string,
  body: unknown,
  headers?: Record<string, string | undefined>,
  method = 'POST',
): HttpRequest {
  return {
    url,
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(normalized);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

export function basicAuth(value: string): string {
  return `Basic ${bytesToBase64(new TextEncoder().encode(value))}`;
}
