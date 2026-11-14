import { prepareSomaMotion, type PreparedSomaMotion } from '@woohaa3/contracts';

const MAX_BYTES = 128 * 1024 * 1024;
async function readBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`动作资源读取失败 (${response.status})`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('动作资源过大');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('动作资源响应为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_BYTES) throw new Error('动作资源过大');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function loadSomaMotion(url: string, signal: AbortSignal, fps: number, expectedFrameCount?: number, expectedChecksum?: string): Promise<PreparedSomaMotion> {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error("动作缺少有效采样率");
  const skinUrl = `${import.meta.env.BASE_URL}soma/skin_standard.npz`;
  const [skin, motion] = await Promise.all([readBytes(skinUrl, signal), readBytes(url, signal)]);
  signal.throwIfAborted();
  if (expectedChecksum) {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', motion as Uint8Array<ArrayBuffer>)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== expectedChecksum.toLowerCase().replace(/^sha256:/, '')) throw new Error('动作资源校验失败');
  }
  const prepared = await prepareSomaMotion(skin, motion, { fps });
  signal.throwIfAborted();
  if (expectedFrameCount !== undefined && (!Number.isInteger(expectedFrameCount) || expectedFrameCount < 1 || prepared.frameCount !== expectedFrameCount)) throw new Error("动作帧数与生成记录不一致");
  return prepared;
}
