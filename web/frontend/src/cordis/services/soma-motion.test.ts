import { afterEach, expect, it, vi } from 'vitest';
import { loadSomaMotion } from './soma-motion.js';
const prepare = vi.hoisted(() => vi.fn());
vi.mock('@woohaa3/contracts', () => ({ prepareSomaMotion: prepare }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('读取受控媒体与随包皮肤，并传递采样率', async () => {
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(new Uint8Array([1,2,3])));
  vi.stubGlobal('fetch', fetcher);
  prepare.mockResolvedValue({ frameCount: 4 });
  const signal = new AbortController().signal;
  await expect(loadSomaMotion('/api/media/motion', signal, 24)).resolves.toEqual({ frameCount: 4 });
  expect(fetcher.mock.calls[0][0]).toContain('soma/skin_standard.npz');
  expect(fetcher.mock.calls[1][0]).toBe('/api/media/motion');
  expect(prepare).toHaveBeenCalledWith(new Uint8Array([1,2,3]), new Uint8Array([1,2,3]), { fps: 24 });
});
it('HTTP 失败和超过预算的资源不进入解码器', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  await expect(loadSomaMotion('/missing', new AbortController().signal, 30)).rejects.toThrow('404');
  expect(prepare).not.toHaveBeenCalled();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-length': String(129 * 1024 * 1024) } })));
  await expect(loadSomaMotion('/huge', new AbortController().signal, 30)).rejects.toThrow('过大');
});
it('解码期间取消不会发布 prepared motion', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
  const abort = new AbortController();
  prepare.mockImplementation(async () => { abort.abort(); return {}; });
  await expect(loadSomaMotion('/motion', abort.signal, 30)).rejects.toThrow();
});

it('缺少或非法采样率在读取前拒绝', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(loadSomaMotion('/motion', new AbortController().signal, NaN)).rejects.toThrow('采样率');
  expect(fetcher).not.toHaveBeenCalled();
});

it('拒绝生成记录帧数与实际 NPZ 不一致', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
  prepare.mockResolvedValue({frameCount:90});
  await expect(loadSomaMotion('/motion', new AbortController().signal, 30, 91)).rejects.toThrow('帧数');
  await expect(loadSomaMotion('/motion', new AbortController().signal, 30, 90)).resolves.toEqual({frameCount:90});
});

it('校验原始动作字节，哈希不符时不解码', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1,2,3]))));
  prepare.mockResolvedValue({frameCount:2});
  await expect(loadSomaMotion('/motion', new AbortController().signal, 30, 2, '0'.repeat(64))).rejects.toThrow('校验');
  expect(prepare).not.toHaveBeenCalled();
  await expect(loadSomaMotion('/motion', new AbortController().signal, 30, 2, '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81')).resolves.toEqual({frameCount:2});
});
