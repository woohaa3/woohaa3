import type {
  Experimental_VideoModelV4Result,
  ImageModelV4Result,
  JSONValue,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import type { PptaskAudioOutput, PptaskAudioResult } from '../../core/types.ts';
import { base64ToBytes, bytesToBase64 } from './http.ts';
import { isRecord } from './input.ts';
import { providerMetadata } from './types.ts';

export async function imageResult(
  providerId: string,
  modelId: string,
  output: unknown,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
  metadata: Record<string, JSONValue> = {},
): Promise<ImageModelV4Result> {
  const values = extractOutputValues(output);
  const images = await Promise.all(values.map(value => imageData(value, fetchImpl, signal)));
  if (!images.length) throw new Error(`${providerId} returned no image output`);
  return {
    images,
    warnings: [],
    providerMetadata: {
      [providerId]: {
        images: values.map(value => outputMetadata(value)),
        ...metadata,
        ...(extractUsage(output) ? { usage: extractUsage(output) } : {}),
      },
    },
    response: { timestamp: new Date(), modelId, headers: undefined },
  };
}

export function videoResult(
  providerId: string,
  modelId: string,
  output: unknown,
  metadata: Record<string, JSONValue> = {},
): Experimental_VideoModelV4Result {
  const values = extractOutputValues(output);
  const videos = values.map(value => {
    if (value.kind === 'base64') {
      return { type: 'base64' as const, data: value.value, mediaType: value.mediaType ?? 'video/mp4' };
    }
    return { type: 'url' as const, url: value.value, mediaType: value.mediaType ?? videoMediaType(value.value) };
  });
  if (!videos.length) throw new Error(`${providerId} returned no video output`);
  return {
    videos,
    warnings: [],
    providerMetadata: providerMetadata(providerId, {
      ...metadata,
      ...(extractUsage(output) ? { usage: extractUsage(output) } : {}),
    }),
    response: { timestamp: new Date(), modelId, headers: undefined },
  };
}

export async function audioResult(
  providerId: string,
  modelId: string,
  output: unknown,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
  metadata: Record<string, JSONValue> = {},
): Promise<PptaskAudioResult> {
  const values = await audioOutputValues(output);
  if (!values.length) throw new Error(`${providerId} returned no audio output`);
  const audios: PptaskAudioOutput[] = values.map(value => value.kind === 'base64'
    ? { type: 'base64' as const, data: value.value, mediaType: audioMediaType(value) }
    : { type: 'url' as const, url: value.value, mediaType: audioMediaType(value) });
  const first = values[0]!;
  // The AI SDK decodes a string `audio` as base64 and has no URL branch, so a
  // URL output must be downloaded here rather than passed through.
  const audio = first.kind === 'base64'
    ? first.value
    : bytesToBase64(await audioBytes(first.value, fetchImpl, signal));
  return {
    audio,
    audios,
    warnings: [],
    providerMetadata: providerMetadata(providerId, {
      ...metadata,
      ...(extractUsage(output) ? { usage: extractUsage(output) } : {}),
    }),
    response: { timestamp: new Date(), modelId, headers: undefined },
  };
}

async function audioBytes(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`Failed to download audio output (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Raw bytes arrive unwrapped from text-to-speech endpoints. */
async function byteOutputValue(value: unknown): Promise<OutputValue | undefined> {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return { kind: 'base64', value: bytesToBase64(new Uint8Array(await value.arrayBuffer())), mediaType: value.type || undefined };
  }
  if (value instanceof ArrayBuffer) return { kind: 'base64', value: bytesToBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return { kind: 'base64', value: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  return undefined;
}

const AUDIO_OUTPUT_KEYS = ['audios', 'audio', 'audio_urls', 'audioUrls', 'audio_url', 'audioUrl'] as const;

/**
 * Audio payloads are less regular than image/video ones: an endpoint may
 * return raw bytes, a bare base64 string, a data URL, or several URLs under
 * an `audios`/`audio` key. Enumerate those before falling back to the generic
 * recursive scan (which handles e.g. kie's `resultJson.audio_url`).
 */
async function audioOutputValues(output: unknown): Promise<OutputValue[]> {
  const direct = await byteOutputValue(output);
  if (direct) return [direct];

  const source = isRecord(output) ? output : undefined;
  const values: OutputValue[] = [];
  if (source) {
    for (const key of AUDIO_OUTPUT_KEYS) {
      const candidate = source[key];
      if (candidate === undefined) continue;
      for (const item of Array.isArray(candidate) ? candidate : [candidate]) {
        const bytes = await byteOutputValue(item);
        if (bytes) values.push(bytes);
        else if (typeof item === 'string') {
          const normalized = normalizeAudioString(item);
          if (normalized) values.push(normalized);
        }
      }
    }
  }
  if (values.length) return unique(values);
  return extractOutputValues(output);
}

function normalizeAudioString(value: string): OutputValue | undefined {
  if (/^https?:\/\//i.test(value)) return { kind: 'url', value };
  const dataUrl = /^data:([^;,]+);base64,(.+)$/i.exec(value);
  if (dataUrl) return { kind: 'base64', value: dataUrl[2]!, mediaType: dataUrl[1] };
  const compacted = value.replace(/\s+/g, '');
  if (compacted.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(compacted)) {
    return { kind: 'base64', value: compacted };
  }
  return undefined;
}

function audioMediaType(value: OutputValue): string {
  if (value.mediaType) return value.mediaType;
  if (value.kind === 'url') {
    if (/\.wav(?:$|\?)/i.test(value.value)) return 'audio/wav';
    if (/\.(mp3|mpeg)(?:$|\?)/i.test(value.value)) return 'audio/mpeg';
    if (/\.(m4a|mp4)(?:$|\?)/i.test(value.value)) return 'audio/mp4';
    if (/\.ogg(?:$|\?)/i.test(value.value)) return 'audio/ogg';
  }
  return 'audio/mpeg';
}

function extractUsage(output: unknown): Record<string, JSONValue> | undefined {
  if (!isRecord(output)) return undefined;
  const usage = output.usage ?? output.usageMetadata ?? output.usage_metadata;
  if (!isRecord(usage)) return undefined;
  return usage as Record<string, JSONValue>;
}

export function languageResult(
  providerId: string,
  modelId: string,
  output: unknown,
  metadata: Record<string, JSONValue> = {},
): LanguageModelV4GenerateResult {
  const text = extractText(output);
  const usage = isRecord(output) && isRecord(output.usage) ? output.usage : {};
  const inputTokens = numberValue(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokenCount);
  const outputTokens = numberValue(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokenCount);
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: String(first(output, ['finish_reason', 'stop_reason']) ?? 'stop') },
    usage: {
      inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
      raw: isRecord(usage) ? usage : undefined,
    },
    warnings: [],
    providerMetadata: providerMetadata(providerId, metadata),
    response: { timestamp: new Date(), modelId, body: output },
  };
}

type OutputValue = { kind: 'url' | 'base64'; value: string; mediaType?: string };

export function extractOutputValues(output: unknown): OutputValue[] {
  const results: OutputValue[] = [];
  visitOutput(output, results, new Set<object>());
  return unique(results);
}

function visitOutput(value: unknown, results: OutputValue[], seen: Set<object>): void {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) results.push({ kind: 'url', value });
    else if (/^data:/i.test(value)) {
      const match = /^data:([^;,]+);base64,(.+)$/i.exec(value);
      if (match) results.push({ kind: 'base64', value: match[2], mediaType: match[1] });
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitOutput(item, results, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['url', 'uri', 'video_url', 'videoUrl', 'download_url', 'downloadUrl', 'result_url', 'resultUrl', 'audio_url', 'audio_urls', 'audioUrl', 'firstFrameUrl', 'lastFrameUrl', 'gridUrl']) {
    visitOutput(record[key], results, seen);
  }
  for (const key of ['b64_json', 'base64', 'data']) {
    if (typeof record[key] === 'string' && !/^https?:\/\//i.test(record[key] as string)) {
      results.push({
        kind: 'base64',
        value: record[key] as string,
        mediaType: typeof record.mimeType === 'string'
          ? record.mimeType
          : typeof record.mime_type === 'string' ? record.mime_type : undefined,
      });
    }
  }
  for (const key of ['output', 'outputs', 'result', 'results', 'resultUrls', 'media_urls', 'image_urls', 'video_urls', 'audio_urls', 'images', 'videos', 'audios', 'audio', 'data', 'task', 'content', 'artifacts', 'files', 'tracks', 'generations']) {
    visitOutput(record[key], results, seen);
  }
  const candidates = record.candidates;
  if (Array.isArray(candidates)) visitOutput(candidates, results, seen);
  const parts = record.parts ?? (isRecord(record.content) ? record.content.parts : undefined);
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!isRecord(part)) continue;
      const inline = part.inlineData ?? part.inline_data;
      if (isRecord(inline) && typeof inline.data === 'string') {
        results.push({
          kind: 'base64',
          value: inline.data,
          mediaType: String(inline.mimeType ?? inline.mime_type ?? 'image/png'),
        });
      }
    }
  }
}

async function imageData(
  value: OutputValue,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (value.kind === 'base64') return base64ToBytes(value.value);
  const response = await fetchImpl(value.value, { signal });
  if (!response.ok) throw new Error(`Failed to download image output (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function extractText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!isRecord(output)) return JSON.stringify(output);
  const direct = first(output, ['text', 'output_text', 'content']);
  if (typeof direct === 'string') return direct;
  const choices = output.choices;
  if (Array.isArray(choices)) {
    const texts = choices.flatMap(choice => {
      if (!isRecord(choice)) return [];
      const message = isRecord(choice.message) ? choice.message.content : undefined;
      const text = choice.text ?? message;
      return typeof text === 'string' ? [text] : [];
    });
    if (texts.length) return texts.join('');
  }
  if (Array.isArray(output.output)) {
    const texts: string[] = [];
    for (const item of output.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (isRecord(content) && typeof content.text === 'string') texts.push(content.text);
      }
    }
    if (texts.length) return texts.join('');
  }
  return JSON.stringify(output);
}

function first(value: unknown, fields: string[]): unknown {
  if (!isRecord(value)) return undefined;
  for (const field of fields) if (value[field] !== undefined) return value[field];
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function outputMetadata(value: OutputValue): JSONValue {
  return value.kind === 'url'
    ? { url: value.value, mediaType: value.mediaType ?? null }
    : { mediaType: value.mediaType ?? null };
}

function unique(values: OutputValue[]): OutputValue[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = `${value.kind}:${value.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function videoMediaType(url: string): string {
  if (/\.webm(?:$|\?)/i.test(url)) return 'video/webm';
  if (/\.mov(?:$|\?)/i.test(url)) return 'video/quicktime';
  return 'video/mp4';
}
