/** Native frame preparation uses only stable media bytes, never a provider URL or browser state. */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { filmSetMediaPlanesForNode, canonicalFilmSetFields, type FilmSetNodeData, type StoredAsset, type BevyNativeMediaFrame } from "@woohaa3/contracts";

export type FilmSetNativeMediaFrame = BevyNativeMediaFrame;
export type FilmSetMediaReader = (storageKey: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
function run(command: string, args: string[], limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = []; let size = 0, finished = false;
    const finish = (error?: Error, bytes?: Buffer) => { if (finished) return; finished = true; clearTimeout(timeout); error ? reject(error) : resolve(bytes!); };
    const timeout = setTimeout(() => { process.kill("SIGKILL"); finish(new Error("原生媒体帧解码超时")); }, 15_000);
    process.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > limit) { process.kill("SIGKILL"); finish(new Error("原生媒体帧超出预算")); } else chunks.push(chunk); });
    process.on("error", () => finish(new Error("原生媒体预览需要可用的 ffmpeg 和 ffprobe")));
    process.on("close", code => code === 0 ? finish(undefined, Buffer.concat(chunks)) : finish(new Error("原生媒体帧解码失败")));
  });
}
export async function prepareFilmSetNativeMedia(input: {
  nodeId: string; animation: FilmSetNodeData; assets: readonly StoredAsset[]; timeSeconds: number; contentExtent: number; read: FilmSetMediaReader;
}): Promise<FilmSetNativeMediaFrame[]> {
  const planes = filmSetMediaPlanesForNode({ nodeId: input.nodeId, data: canonicalFilmSetFields(input.animation) as never, contentExtent: input.contentExtent, readyPlaneIds: new Set(input.animation.filmSetContent.items.map(item => `${input.nodeId}::${item.id}`)) });
  const frames: FilmSetNativeMediaFrame[] = [];
  let totalBytes = 0;
  const directory = await mkdtemp(path.join(tmpdir(), "film-set-native-frame-"));
  try {
    for (const plane of planes) {
      const item = input.animation.filmSetContent.items.find(item => item.id === plane.itemId);
      if (!item || (item.kind !== "image" && item.kind !== "video")) throw new Error("片场媒体身份无法解析");
      const asset = input.assets.find(asset => asset.id === item.assetId);
      const storageKey = asset?.metadata?.storageKey;
      if (asset?.status !== "ready" || typeof storageKey !== "string") throw new Error("片场媒体资产尚未就绪");
      const media = await input.read(storageKey);
      if (!media.contentType.startsWith(`${item.kind}/`) || !media.bytes.length || media.bytes.length > 16 * 1024 * 1024) throw new Error("片场媒体类型或字节预算非法");
      const file = path.join(directory, `source-${frames.length}`);
      await writeFile(file, media.bytes, { mode: 0o600 });
      const ratio = item.aspectRatio;
      const width = Math.max(1, Math.round(ratio >= 1 ? 512 : 512 * ratio));
      const height = Math.max(1, Math.round(ratio >= 1 ? 512 / ratio : 512));
      let time = 0;
      if (item.kind === "video") {
        const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], 16_384)).toString("utf8"));
        const duration = Number(probe.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("片场视频时长无法读取");
        time = Math.min(Math.max(0, input.timeSeconds), Math.max(0, duration - 0.001));
      }
      const expectedBytes = width * height * 4;
      totalBytes += expectedBytes;
      if (totalBytes > 2 * 1024 * 1024) throw new Error("完整片场媒体帧超过原生请求预算");
      const rgba = await run("ffmpeg", ["-v", "error", "-i", file, ...(item.kind === "video" ? ["-ss", String(time)] : []), "-frames:v", "1", "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], expectedBytes);
      if (rgba.length !== expectedBytes) throw new Error("片场媒体帧不完整，拒绝输出缺失媒体的预览");
      frames.push({ plane, width, height, rgba: Array.from(rgba) });
    }
    return frames;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
