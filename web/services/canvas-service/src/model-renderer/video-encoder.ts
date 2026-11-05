/**
 * 动态镜头视频编码子进程 client（change: 2026-11-05-camera-shot-as-video）。
 *
 * 编码由 `world-video-encoder`（Rust + OpenH264，纯 CPU）完成，宿主只通过 framed
 * stdio 流式发送逐帧 RGBA 并接收 MP4。未配置命令时明确不可用：
 * 动态取景不会退回静态图片，也不会把预览纹理当资产。
 */
import { spawn } from "node:child_process";

export const VIDEO_ENCODER_MAX_JSON_BYTES = 16 * 1024;
export const VIDEO_ENCODER_MAX_FRAME_BYTES = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export type VideoEncodeInput = {
  width: number;
  height: number;
  fps: number;
  /** 逐帧自顶向下 RGBA，长度必须为 width*height*4。 */
  frames: AsyncIterable<Uint8Array>;
  signal?: AbortSignal;
};

export type VideoEncodeResult =
  | {
      ok: true;
      mp4: Buffer;
      width: number;
      height: number;
      fps: number;
      frames: number;
      durationSeconds: number;
    }
  | { ok: false; code: string; message: string };

export type VideoEncoderClient = {
  available(): boolean;
  encode(input: VideoEncodeInput): Promise<VideoEncodeResult>;
  close(): Promise<void>;
};

export type VideoEncoderClientOptions = {
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
  logger?: (event: Record<string, unknown>) => void;
};

export function createVideoEncoderClient(options: VideoEncoderClientOptions = {}): VideoEncoderClient {
  const command = options.command;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.logger ?? (() => undefined);
  let closed = false;

  const encode = (input: VideoEncodeInput): Promise<VideoEncodeResult> => {
    if (closed || command === undefined) {
      return Promise.resolve({
        ok: false,
        code: "video-encoder-unavailable",
        message: "未配置原生视频编码器，动态镜头暂不可用"
      });
    }
    if (
      !Number.isInteger(input.width) ||
      !Number.isInteger(input.height) ||
      input.width <= 0 ||
      input.height <= 0 ||
      !Number.isInteger(input.fps) ||
      input.fps <= 0
    ) {
      return Promise.resolve({ ok: false, code: "invalid-video", message: "视频尺寸或帧率不合法" });
    }

    return new Promise<VideoEncodeResult>((resolve) => {
      const child = spawn(command, [...(options.args ?? [])], { stdio: ["pipe", "pipe", "pipe"] });
      let settled = false;
      let stderr = "";
      let buffer = Buffer.alloc(0);
      let expected: "json" | "mp4" | null = null;
      let expectedLength = 0;
      let finishedMeta: Extract<VideoEncodeResult, { ok: true }> | null = null;

      const finish = (result: VideoEncodeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        resolve(result);
      };
      const fail = (code: string, message: string) =>
        finish({ ok: false, code, message: `${message}${stderr ? `：${stderr.slice(-400)}` : ""}` });

      const timer = setTimeout(() => fail("video-encode-timeout", "视频编码超时"), timeoutMs);
      const onAbort = () => fail("cancelled", "视频编码已取消");
      input.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => fail("video-encoder-unavailable", error.message));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("exit", () => {
        if (!settled) fail("video-encode-failed", "视频编码进程提前退出");
      });

      child.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (expected === "json") {
            if (buffer.length < 4) return;
            const length = buffer.readUInt32BE(0);
            if (length === 0 || length > VIDEO_ENCODER_MAX_JSON_BYTES) {
              fail("video-encode-failed", "编码器响应长度非法");
              return;
            }
            if (buffer.length < 4 + length) return;
            const json = buffer.subarray(4, 4 + length).toString("utf8");
            buffer = buffer.subarray(4 + length);
            let parsed: {
              ok?: boolean; code?: string; message?: string; mp4Len?: number;
              width?: number; height?: number; fps?: number; frames?: number; durationSeconds?: number;
            };
            try { parsed = JSON.parse(json); } catch { fail("video-encode-failed", "编码器响应不是合法 JSON"); return; }
            if (parsed.ok !== true) {
              fail(parsed.code ?? "video-encode-failed", parsed.message ?? "视频编码失败");
              return;
            }
            if (parsed.mp4Len !== undefined) {
              finishedMeta = {
                ok: true,
                mp4: Buffer.alloc(0),
                width: parsed.width ?? input.width,
                height: parsed.height ?? input.height,
                fps: parsed.fps ?? input.fps,
                frames: parsed.frames ?? 0,
                durationSeconds: parsed.durationSeconds ?? 0
              };
              expected = "mp4";
              expectedLength = parsed.mp4Len;
            } else {
              expected = null;
            }
            continue;
          }
          if (expected === "mp4") {
            if (buffer.length < 4 + expectedLength) return;
            const bytes = buffer.subarray(4, 4 + expectedLength);
            buffer = buffer.subarray(4 + expectedLength);
            if (!finishedMeta) { fail("video-encode-failed", "缺少编码结果元数据"); return; }
            finish({ ...finishedMeta, mp4: Buffer.from(bytes) });
            return;
          }
          return;
        }
      });

      const writeMessage = (json: string) => {
        const payload = Buffer.from(json, "utf8");
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.length, 0);
        child.stdin.write(Buffer.concat([header, payload]));
      };

      void (async () => {
        writeMessage(JSON.stringify({ width: input.width, height: input.height, fps: input.fps }));
        expected = "json";
        for await (const frame of input.frames) {
          if (settled || input.signal?.aborted) {
            fail("cancelled", "视频编码已取消");
            return;
          }
          if (frame.byteLength !== input.width * input.height * 4) {
            fail("invalid-video", "帧字节数与尺寸不一致");
            return;
          }
          writeMessage(JSON.stringify({ frameLength: frame.byteLength }));
          child.stdin.write(Buffer.from(frame));
        }
        if (settled) return;
        writeMessage(JSON.stringify({ finish: true }));
      })().catch((error) => fail("video-encode-failed", error instanceof Error ? error.message : String(error)));

      child.once("close", () => {
        input.signal?.removeEventListener("abort", onAbort);
        log({ event: "world-video-encode", ok: settled && finishedMeta !== null });
      });
    });
  };

  return {
    available: () => !closed && command !== undefined,
    encode,
    close: async () => {
      closed = true;
    }
  };
}
