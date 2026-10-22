import type { PptaskDescription } from '@sdppp/pptask';
import { normalizeLanguagePrompt } from '@sdppp/pptask/providers/shared';
import { ARK_PROVIDER_ID } from './catalog.js';

/** Chat Completions 请求体。已经是 OpenAI 消息形状的内容原样转发。 */
export function buildArkChatRequestBody(
  modelId: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: modelId,
    messages: chatMessages(input),
    max_tokens: positiveInt(input.max_tokens ?? input.maxTokens, 2048),
  };
  if (input.jsonMode === true || input.json_mode === true) body.response_format = { type: 'json_object' };
  return body;
}

export function describeArkLanguage(modelId: string, title: string): PptaskDescription {
  return {
    providerId: ARK_PROVIDER_ID,
    modelId,
    modelType: 'language',
    title,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', title: '提示词', 'x-component': 'Input.TextArea' },
        system: { type: 'string', title: '系统提示词', 'x-component': 'Input.TextArea' },
        urls: {
          type: 'array',
          title: '参考图',
          maxItems: 14,
          'x-pptask-semantic': 'reference-image',
          'x-component': 'Upload',
        },
        maxTokens: { type: 'number', title: '最大输出 Token', default: 2048, 'x-component': 'NumberPicker' },
        jsonMode: { type: 'boolean', title: 'JSON 输出', default: false, 'x-component': 'Switch' },
      },
    },
    defaultInput: { system: '', urls: [], maxTokens: 2048, jsonMode: false },
    capabilities: { mediaKind: 'text', operations: ['text-generation'], cancel: false },
  };
}

function chatMessages(input: Record<string, unknown>): unknown[] {
  const raw = Array.isArray(input.messages) ? input.messages : undefined;
  let list: unknown[];
  if (raw && looksLikeChat(raw)) list = raw.map((message) => message);
  else if (raw) list = normalizeLanguagePrompt({ messages: raw }).messages as unknown[];
  else if (typeof input.prompt === 'string' && input.prompt.trim()) list = [{ role: 'user', content: input.prompt.trim() }];
  else list = [];

  const system = typeof input.system === 'string' ? input.system.trim() : '';
  if (system && !list.some((message) => record(message)?.role === 'system')) {
    list.unshift({ role: 'system', content: system });
  }
  const urls = referenceUrls(input);
  if (urls.length) attachImages(list, urls);
  if (!list.length) throw new Error('提示词不能为空');
  return list;
}

function looksLikeChat(messages: unknown[]): boolean {
  return messages.length > 0 && messages.every((message) => {
    const row = record(message);
    if (!row || typeof row.role !== 'string') return false;
    if (typeof row.content === 'string') return true;
    if (!Array.isArray(row.content)) return false;
    return row.content.every((part) => {
      const item = record(part);
      return item?.type === 'text' || item?.type === 'image_url' || item?.type === 'video_url' || item?.type === 'audio_url';
    });
  });
}

function attachImages(messages: unknown[], urls: string[]): void {
  const target = [...messages].reverse().find((message) => record(message)?.role === 'user');
  if (!target) {
    messages.push({ role: 'user', content: urls.map(imagePart) });
    return;
  }
  const row = target as Record<string, unknown>;
  const content = Array.isArray(row.content)
    ? [...row.content]
    : typeof row.content === 'string' ? [{ type: 'text', text: row.content }] : [];
  const existing = new Set(content.flatMap((part) => {
    const item = record(part);
    const url = record(item?.image_url)?.url ?? item?.url;
    return typeof url === 'string' ? [url] : [];
  }));
  for (const url of urls) {
    if (!existing.has(url)) content.push(imagePart(url));
  }
  row.content = content;
}

function imagePart(url: string): Record<string, unknown> {
  return { type: 'image_url', image_url: { url } };
}

function referenceUrls(input: Record<string, unknown>): string[] {
  const raw = input.urls ?? input.images;
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return values.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 14);
}

function positiveInt(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? Math.min(8192, number) : fallback;
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
