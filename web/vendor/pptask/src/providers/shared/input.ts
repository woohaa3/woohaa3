import type {
  Experimental_VideoModelV4CallOptions,
  ImageModelV4CallOptions,
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  SpeechModelV4CallOptions,
} from '@ai-sdk/provider';
import { bytesToBase64 } from './http.ts';

export function imageInput(
  providerId: string,
  options: ImageModelV4CallOptions,
): Record<string, unknown> {
  return compact({
    ...extraInput(options, ['prompt', 'n', 'size', 'aspectRatio', 'seed', 'files', 'mask']),
    ...customInput(providerId, options.providerOptions),
    ...compact({
      prompt: options.prompt,
      n: options.n,
      size: options.size,
      aspect_ratio: options.aspectRatio,
      seed: options.seed,
    }),
    ...(options.files?.length ? { images: options.files.map(fileInput) } : {}),
    ...(options.mask ? { mask: fileInput(options.mask) } : {}),
  });
}

export function videoInput(
  providerId: string,
  options: Experimental_VideoModelV4CallOptions,
): Record<string, unknown> {
  return compact({
    ...extraInput(options, ['prompt', 'n', 'aspectRatio', 'resolution', 'duration', 'fps', 'seed', 'generateAudio', 'image', 'inputReferences']),
    ...customInput(providerId, options.providerOptions),
    ...compact({
      prompt: options.prompt,
      n: options.n,
      aspect_ratio: options.aspectRatio,
      resolution: options.resolution,
      duration: options.duration,
      fps: options.fps,
      seed: options.seed,
      generate_audio: options.generateAudio,
    }),
    ...(options.image ? { image: fileInput(options.image) } : {}),
    ...(options.inputReferences?.length
      ? { input_references: options.inputReferences.map(fileInput) }
      : {}),
  });
}

export function languageInput(
  providerId: string,
  options: LanguageModelV4CallOptions,
): Record<string, unknown> {
  return compact({
    ...extraInput(options, ['prompt', 'maxOutputTokens', 'temperature', 'topP', 'stopSequences', 'presencePenalty', 'frequencyPenalty']),
    ...customInput(providerId, options.providerOptions),
    ...compact({
      messages: options.prompt,
      max_tokens: options.maxOutputTokens,
      temperature: options.temperature,
      top_p: options.topP,
      stop: options.stopSequences,
      presence_penalty: options.presencePenalty,
      frequency_penalty: options.frequencyPenalty,
    }),
  });
}

export function audioInput(
  providerId: string,
  options: SpeechModelV4CallOptions,
): Record<string, unknown> {
  return compact({
    ...extraInput(options, ['text', 'voice', 'outputFormat', 'instructions', 'speed', 'language']),
    ...customInput(providerId, options.providerOptions),
    ...compact({
      text: options.text,
      voice: options.voice,
      output_format: options.outputFormat,
      instructions: options.instructions,
      speed: options.speed,
      language: options.language,
    }),
  });
}

/** Convert the AI SDK's internal prompt shape to the OpenAI-shaped payloads
 * used by providers that expose both Responses and Chat Completions APIs. */
export function normalizeLanguagePrompt(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.messages)) return input;

  const prompt = input.messages as LanguageModelV4Prompt;
  const responsesInput = prompt.map(message => normalizeResponsesMessage(message));
  return {
    ...input,
    messages: prompt.map(message => normalizeChatMessage(message)),
    input: input.input ?? simpleResponsesInput(prompt, responsesInput),
  };
}

function normalizeChatMessage(message: LanguageModelV4Prompt[number]): Record<string, unknown> {
  if (message.role === 'system') return { role: 'system', content: message.content };
  const content = normalizeMessageContent(message.content).map(chatContentPart);
  return { role: message.role, content: content.length === 1 && content[0]!.type === 'text' ? content[0]!.text : content };
}

/**
 * 内部归一部件 → OpenAI Chat Completions 的 content part。
 *
 * 图片必须写成 `{ type: 'image_url', image_url: { url } }`：`{ type: 'image', url }`
 * 是 Responses 一侧的中间形状，直接发到 `/v1/chat/completions` 会被判为非法 part
 * （tokenhub / grsai 的 openAIMessage 做的就是这一步转换）。
 */
function chatContentPart(part: NormalizedContentPart): Record<string, unknown> {
  return part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image_url', image_url: { url: part.url } };
}

function normalizeResponsesMessage(message: LanguageModelV4Prompt[number]): Record<string, unknown> {
  if (message.role === 'system') return { role: 'system', content: [{ type: 'input_text', text: message.content }] };
  const parts = normalizeMessageContent(message.content);
  return {
    role: message.role,
    content: parts.map(part => part.type === 'text'
      ? { type: 'input_text', text: part.text }
      : { type: 'input_image', image_url: part.url }),
  };
}

/**
 * 内部归一部件：文本天然共享；媒体先归一成 `{ type: 'image', url }`，
 * 再由 Responses / Chat Completions 各自的映射写出各自 wire 形状。
 *
 * 接受的输入形状（按来源）：
 * - AI SDK v4 `file` part（`data` 为字符串、字节或 v4 tagged union）——片场转换等库内调用；
 * - OpenAI 风格的 `image_url` part——Task Service 组装的画布多模态输入（签名 HTTPS URL，
 *   需要 JSON 可序列化落 `params_json`，所以不能换成 `URL` 对象或裸字节）。
 *
 * 不认识的 part 仍丢弃：归一化只对**已知**形状负责，避免把未知字段猜成媒体。
 */
type NormalizedContentPart = { type: 'text'; text: string } | { type: 'image'; url: string };

function normalizeMessageContent(content: unknown): NormalizedContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): NormalizedContentPart[] => {
    if (!part || typeof part !== 'object') return [];
    const value = part as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') {
      return [{ type: 'text' as const, text: value.text }];
    }
    if (value.type === 'image_url') {
      const url = readImageUrl(value.image_url);
      return url ? [{ type: 'image' as const, url }] : [];
    }
    if (value.type === 'file') return fileImagePart(value);
    return [];
  });
}

/** `image_url` 字段既可能是 `{ url }`，也可能是裸字符串。 */
function readImageUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (value instanceof URL) return value.toString();
  if (value && typeof value === 'object') {
    const url = (value as Record<string, unknown>).url;
    if (typeof url === 'string' && url !== '') return url;
    if (url instanceof URL) return url.toString();
  }
  return undefined;
}

/** AI SDK `file` part：只接受图片媒体；其余媒体类型不在这里伪装成图片。 */
function fileImagePart(value: Record<string, unknown>): NormalizedContentPart[] {
  const mediaType = typeof value.mediaType === 'string' ? value.mediaType : '';
  if (!mediaType.startsWith('image')) return [];
  const data = value.data;
  if (typeof data === 'string') return [{ type: 'image', url: toImageDataUrl(data, mediaType) }];
  if (data instanceof Uint8Array) return [{ type: 'image', url: toImageDataUrl(bytesToBase64(data), mediaType) }];
  if (data && typeof data === 'object') {
    const tagged = data as Record<string, unknown>;
    // v4 SharedV4FileData：{ type: 'url', url } | { type: 'data', data }
    if (tagged.type === 'url') {
      const url = readImageUrl(tagged.url);
      return url ? [{ type: 'image', url }] : [];
    }
    if (tagged.type === 'data') return fileImagePart({ ...value, data: tagged.data });
  }
  return [];
}

function toImageDataUrl(data: string, mediaType: string): string {
  return data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`;
}

function simpleResponsesInput(
  prompt: LanguageModelV4Prompt,
  messages: Array<Record<string, unknown>>,
): string | Array<Record<string, unknown>> {
  if (prompt.length === 1 && prompt[0]?.role === 'user') {
    const content = messages[0]?.content;
    if (Array.isArray(content) && content.length === 1) {
      const part = content[0] as Record<string, unknown>;
      if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
    }
  }
  return messages;
}

export function customInput(
  providerId: string,
  providerOptions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const value = providerOptions?.[providerId];
  if (!isRecord(value)) return {};
  return isRecord(value.input) ? value.input : value;
}

export function fileInput(file: {
  type: 'url';
  url: string;
} | {
  type: 'file';
  data: string | Uint8Array;
  mediaType: string;
}): string {
  if (file.type === 'url') return file.url;
  const data = typeof file.data === 'string' ? file.data : bytesToBase64(file.data);
  return data.startsWith('data:') ? data : `data:${file.mediaType};base64,${data}`;
}

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extraInput(value: object, standardFields: string[]): Record<string, unknown> {
  const excluded = new Set([...standardFields, 'providerOptions', 'abortSignal', 'headers']);
  return Object.fromEntries(
    Object.entries(value).filter(([key, item]) => !excluded.has(key) && item !== undefined),
  );
}
