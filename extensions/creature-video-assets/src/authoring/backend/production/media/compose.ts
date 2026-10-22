import { dirname } from 'node:path';
import sharp from 'sharp';
import { ValidationError } from '../../../../state/shared/creature/errors.js';
import { mkdir } from 'node:fs/promises';
const ensureDir = (path:string) => mkdir(path,{recursive:true});
import { readAlpha, readMask, type AlphaPlane } from './pixels.js';

export interface ComposeOptions {
  rgb: string;
  alpha: string;
  output: string;
  alphaFloor: number;
  /** AlphaHint 通常是灰度 PNG；显式 alpha 通道用于下游已经合成过的 RGBA。 */
  alphaChannel?: 'luma' | 'alpha';
}

/** 原始解码 RGB + 线性 straight Alpha 合成；禁止生成、修补或混合 RGB。 */
export async function composeRgba(options: ComposeOptions): Promise<void> {
  await ensureDir(dirname(options.output));
  const rgb = sharp(options.rgb, { failOn: 'error' });
  const metadata = await rgb.metadata();
  if (!metadata.width || !metadata.height) throw new ValidationError(`RGB 尺寸不可读：${options.rgb}`);
  const plane = options.alphaChannel === 'alpha' ? await readAlpha(options.alpha) : await readLumaPlane(options.alpha);
  if (plane.width !== metadata.width || plane.height !== metadata.height) {
    throw new ValidationError(`RGB 与 Alpha 尺寸不一致：${options.rgb} vs ${options.alpha}`);
  }
  const alpha = Uint8Array.from(plane.data, value => (value < options.alphaFloor ? 0 : value));
  const rgbRaw = await rgb.removeAlpha().raw().toBuffer();
  await sharp(rgbRaw, { raw: { width: metadata.width, height: metadata.height, channels: 3 } })
    .joinChannel(Buffer.from(alpha), { raw: { width: metadata.width, height: metadata.height, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(options.output);
}

export interface EnvelopeOptions {
  samMask: string;
  alphaHint: string;
  output: string;
  envelopePx: number;
  alphaFloor: number;
}

export interface EnvelopeResult {
  outsideEnvelopePixels: number;
  flooredPixels: number;
  totalPixels: number;
}

/**
 * 用 SAM 外扩后的语义安全包络清理远端噪声；不做 SAM 硬裁，
 * 因此包络内保留 VideoMaMa 的软 Alpha。
 */
export async function applySemanticEnvelope(options: EnvelopeOptions): Promise<EnvelopeResult> {
  await ensureDir(dirname(options.output));
  const mask = await readMask(options.samMask);
  const hint = await readLumaPlane(options.alphaHint);
  if (mask.width !== hint.width || mask.height !== hint.height) {
    throw new ValidationError('SAM mask 与 AlphaHint 尺寸不一致');
  }
  const envelope = options.envelopePx > 0 ? dilate(mask, options.envelopePx) : mask;
  const out = new Uint8Array(hint.data.length);
  let outside = 0;
  let floored = 0;
  for (let index = 0; index < hint.data.length; index += 1) {
    const value = hint.data[index] as number;
    if (envelope.data[index] === 0) {
      outside += 1;
      out[index] = 0;
      continue;
    }
    if (value < options.alphaFloor) {
      floored += 1;
      out[index] = 0;
      continue;
    }
    out[index] = value;
  }
  await sharp(Buffer.from(out), { raw: { width: hint.width, height: hint.height, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(options.output);
  return { outsideEnvelopePixels: outside, flooredPixels: floored, totalPixels: hint.data.length };
}

export function dilate(mask: AlphaPlane, radius: number): AlphaPlane {
  const horizontal = new Uint8Array(mask.data.length);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      let value = 0;
      for (let offset = -radius; offset <= radius && value === 0; offset += 1) {
        const sampleX = x + offset;
        if (sampleX < 0 || sampleX >= mask.width) continue;
        value = mask.data[y * mask.width + sampleX] as number;
      }
      horizontal[y * mask.width + x] = value;
    }
  }
  const output = new Uint8Array(mask.data.length);
  for (let x = 0; x < mask.width; x += 1) {
    for (let y = 0; y < mask.height; y += 1) {
      let value = 0;
      for (let offset = -radius; offset <= radius && value === 0; offset += 1) {
        const sampleY = y + offset;
        if (sampleY < 0 || sampleY >= mask.height) continue;
        value = horizontal[sampleY * mask.width + x] as number;
      }
      output[y * mask.width + x] = value;
    }
  }
  return { data: output, width: mask.width, height: mask.height };
}

export async function compositeOnBackground(rgbaFile: string, background: string, output: string): Promise<void> {
  await sharp({ create: { width: 1, height: 1, channels: 4, background } })
    .resize(await imageSize(rgbaFile))
    .composite([{ input: rgbaFile }])
    .removeAlpha()
    .toFile(output);
}

async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const metadata = await sharp(file).metadata();
  if (!metadata.width || !metadata.height) throw new ValidationError(`图片尺寸不可读：${file}`);
  return { width: metadata.width, height: metadata.height };
}

async function readLumaPlane(file: string): Promise<AlphaPlane> {
  const { data, info } = await sharp(file, { failOn: 'error' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}
