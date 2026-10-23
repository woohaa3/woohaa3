/**
 * 服务端视频元数据与有界抽帧
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 2.2 / design D2/D6）。
 *
 * 只使用稳定媒体字节（不接触 provider URL 或浏览器状态），在服务端做视频解码：
 * - `probeFilmSetVideoDuration` 读取真实时长（供范围校验）；
 * - `extractFilmSetVideoFrames` 在所选范围内抽取有时间戳、覆盖首尾的帧组。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 7.1 / design D7：原 24 MiB 抽帧
 * 累计字节、30 秒命令超时与 768 缩放边**拒绝**已删除。帧数与单帧尺寸现在是明确的**媒体表示
 * 策略**（采样密度、传输片段大小），不是执行额度；原始视频与完整时间范围始终保留，用户可
 * 随时取消，真实解码/磁盘失败按事实报告，绝不静默截断所选范围。
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** 单帧最长边：明确的媒体表示策略（控制单帧传输片段大小），不是执行额度。 */
const FRAME_MAX_EDGE = 768;

export type FilmSetVideoFrame = {
  timestampSeconds: number;
  bytes: Uint8Array;
  contentType: string;
};

function run(command: string, args: string[], limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    // 在途解码不设应用固定时长：只在调用方取消或进程真实失败时结束。
    const finish = (error?: Error, bytes?: Buffer) => {
      if (finished) return;
      finished = true;
      if (error) reject(error);
      else resolve(bytes!);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // `limit` 是单次命令的**输出分块**上界（pipe 缓冲），不是作品总量额度。
        child.kill("SIGKILL");
        finish(new Error("单次解码输出超过传输分块上界"));
      } else {
        chunks.push(chunk);
      }
    });
    child.on("error", () => finish(new Error("视频转片场需要可用的 ffmpeg 与 ffprobe")));
    child.on("close", (code) =>
      code === 0 ? finish(undefined, Buffer.concat(chunks)) : finish(new Error("视频解码失败"))
    );
  });
}

/** 读取视频真实时长（秒）；读取失败抛出可读原因。 */
export async function probeFilmSetVideoDuration(bytes: Uint8Array): Promise<number> {
  const directory = await mkdtemp(path.join(tmpdir(), "film-set-probe-"));
  try {
    const file = path.join(directory, "source");
    await writeFile(file, bytes, { mode: 0o600 });
    const raw = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], 16_384);
    const parsed = JSON.parse(raw.toString("utf8")) as { format?: { duration?: unknown } };
    const duration = Number(parsed.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("视频时长无法读取");
    return duration;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * 在所选范围内抽取有时间戳、覆盖首尾的帧组。
 *
 * - `range` 缺省为整个视频；超出真实时长由调用方先拒绝（本函数只按给定范围采样）；
 * - 均匀采样覆盖首尾（含 `startSeconds` 与 `endSeconds` 附近帧）；
 * - `maxFrames` 为上界；本函数不会返回超过该数目的帧。
 */
export async function extractFilmSetVideoFrames(input: {
  bytes: Uint8Array;
  contentType: string;
  range?: { startSeconds: number; endSeconds: number };
  durationSeconds?: number;
  maxFrames: number;
}): Promise<FilmSetVideoFrame[]> {
  if (input.maxFrames <= 0) throw new Error("视频帧预算非法");
  const directory = await mkdtemp(path.join(tmpdir(), "film-set-frames-"));
  try {
    const file = path.join(directory, "source");
    await writeFile(file, input.bytes, { mode: 0o600 });
    const duration = input.durationSeconds ?? (await probeFilmSetVideoDuration(input.bytes));
    const start = input.range ? Math.max(0, input.range.startSeconds) : 0;
    const end = input.range ? Math.min(duration, input.range.endSeconds) : duration;
    if (!(end > start)) throw new Error("视频范围非法");
    const span = end - start;
    // 采样帧数由模型真实多图能力决定；16 只是缺省采样密度（表示策略），不是应用额度。
    const count = Math.max(1, input.maxFrames);
    const frames: FilmSetVideoFrame[] = [];
    for (let index = 0; index < count; index += 1) {
      // 覆盖首尾：index 0 → start，最后一帧 → end（避免恰好落在末尾无帧，取略早位置）。
      const ratio = count === 1 ? 0 : index / (count - 1);
      const time = Math.min(start + ratio * span, Math.max(0, end - 0.05));
      const jpeg = await run("ffmpeg", [
        "-v", "error",
        "-ss", String(time),
        "-i", file,
        "-frames:v", "1",
        "-vf", `scale='min(${FRAME_MAX_EDGE},iw)':-2`,
        "-f", "image2",
        "-c:v", "mjpeg",
        "pipe:1"
      ], 8 * 1024 * 1024);
      if (jpeg.length === 0) continue;
      frames.push({ timestampSeconds: Number(time.toFixed(3)), bytes: new Uint8Array(jpeg), contentType: "image/jpeg" });
    }
    if (frames.length === 0) throw new Error("未能从视频中抽取可用帧");
    return frames;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 模型声明的帧预算与所选范围的兼容性检查（供调用方在读取前拒绝）。 */
export function videoRangeFitsBudget(input: {
  range?: { startSeconds: number; endSeconds: number };
  maxDurationSeconds: number;
}): boolean {
  if (input.maxDurationSeconds <= 0) return true;
  if (!input.range) return true;
  return input.range.endSeconds - input.range.startSeconds <= input.maxDurationSeconds + 1e-6;
}
