import { describe, expect, it } from 'vitest';
import { normalizeLanguagePrompt } from '../../src/providers/shared/input.ts';

type ChatMessage = { role: string; content: unknown };
type ChatPart = Record<string, unknown>;

function messagesOf(input: Record<string, unknown>): ChatMessage[] {
  return input.messages as ChatMessage[];
}

function partsOf(input: Record<string, unknown>): ChatPart[] {
  return messagesOf(input)[0]!.content as ChatPart[];
}

function promptWith(content: unknown[]): Record<string, unknown> {
  return { messages: [{ role: 'user', content }] };
}

describe('normalizeLanguagePrompt 多模态（画布 text 节点接图片）', () => {
  it('保留 Task Service 组装的 image_url part，并写出 chat-completions 的 image_url', () => {
    const signed = 'https://cos.example/ref.png?q-signature=abc';
    const input = normalizeLanguagePrompt(promptWith([
      { type: 'text', text: '这个图里面有什么' },
      { type: 'image_url', image_url: { url: signed } },
    ]));

    expect(partsOf(input)).toEqual([
      { type: 'text', text: '这个图里面有什么' },
      { type: 'image_url', image_url: { url: signed } },
    ]);
    // Responses 一侧仍写 input_image，不跟随 chat 形状。
    const responses = input.input as Array<{ content: ChatPart[] }>;
    expect(responses[0]!.content[1]).toEqual({ type: 'input_image', image_url: signed });
  });

  it('接受裸字符串 image_url', () => {
    const input = normalizeLanguagePrompt(promptWith([
      { type: 'image_url', image_url: 'https://cos.example/a.png' },
    ]));
    expect(partsOf(input)).toEqual([{ type: 'image_url', image_url: { url: 'https://cos.example/a.png' } }]);
  });

  it('file part（片场转换路径）的字节 / v4 tag / URL 都归一为 image_url', () => {
    const bytes = normalizeLanguagePrompt(promptWith([
      { type: 'text', text: '描述' },
      { type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) },
    ]));
    expect(partsOf(bytes)[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } });

    const taggedUrl = normalizeLanguagePrompt(promptWith([
      { type: 'file', mediaType: 'image/webp', data: { type: 'url', url: new URL('https://cos.example/b.webp') } },
    ]));
    expect(partsOf(taggedUrl)[0]).toEqual({ type: 'image_url', image_url: { url: 'https://cos.example/b.webp' } });

    const taggedData = normalizeLanguagePrompt(promptWith([
      { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'AQID' } },
    ]));
    expect(partsOf(taggedData)[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } });
  });

  it('纯文本消息仍折叠成字符串；非图片 file 与未知 part 不会被伪装成图片', () => {
    const text = normalizeLanguagePrompt(promptWith([
      { type: 'text', text: '你好' },
      { type: 'unsupported', value: 1 },
    ]));
    expect(messagesOf(text)[0]!.content).toBe('你好');

    const pdf = normalizeLanguagePrompt(promptWith([
      { type: 'text', text: '总结' },
      { type: 'file', mediaType: 'application/pdf', data: 'AQID' },
    ]));
    expect(messagesOf(pdf)[0]!.content).toBe('总结');
  });
});
