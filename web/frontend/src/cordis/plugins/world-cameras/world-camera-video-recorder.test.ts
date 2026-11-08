import { afterEach, expect, it, vi } from "vitest";
import { encodeWorldCameraVideo, worldCameraVideoEncodingAvailable } from "./world-camera-video-recorder.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function codec(options: { drop?: boolean; stuck?: boolean } = {}) {
  const close = vi.fn();
  let flushes = 0;
  vi.stubGlobal("VideoFrame", class { close() {} });
  vi.stubGlobal("VideoEncoder", class {
    static async isConfigSupported() { return { supported: true }; }
    state = "configured";
    encodeQueueSize = 0;
    constructor(private init: { output: (chunk: unknown, metadata: unknown) => void }) {}
    configure() {}
    encode() { this.encodeQueueSize++; }
    close = close;
    flush() {
      flushes++;
      if (options.stuck) return new Promise<void>(() => {});
      const count = this.encodeQueueSize;
      this.encodeQueueSize = 0;
      for (let i = 0; i < count - (options.drop ? 1 : 0); i++) {
        this.init.output({ byteLength: 1, type: "key", copyTo: (out: Uint8Array) => out.fill(1) },
          { decoderConfig: { description: new Uint8Array([1, 66, 0, 31]).buffer } });
      }
      return Promise.resolve();
    }
  });
  return { close, flushes: () => flushes };
}
async function* frames(count = 12) { for (let i = 0; i < count; i++) yield new Uint8Array(32 * 32 * 4); }
const input = () => ({ width: 32, height: 32, fps: 24, frames: frames() });

it("checks the encoder's static capability before consuming unsupported frames", async () => {
  const supported = vi.fn(async function(this: unknown) {
    expect(this).toBe(UnsupportedEncoder);
    return { supported: false };
  });
  const constructed = vi.fn();
  class UnsupportedEncoder {
    static isConfigSupported = supported;
    constructor() { constructed(); }
  }
  vi.stubGlobal("VideoEncoder", UnsupportedEncoder);
  vi.stubGlobal("VideoFrame", class {});
  const next = vi.fn();
  async function* unsupportedFrames() { next(); yield new Uint8Array(); }
  expect(await encodeWorldCameraVideo({ ...input(), frames: unsupportedFrames() })).toMatchObject({
    ok: false, code: "dynamic-capture-unsupported"
  });
  expect(supported).toHaveBeenCalledWith(expect.objectContaining({ width: 32, height: 32, framerate: 24 }));
  expect(constructed).not.toHaveBeenCalled();
  expect(next).not.toHaveBeenCalled();
});

it("reports unavailable when the browser rejects the capability query", async () => {
  vi.stubGlobal("VideoEncoder", class {
    static async isConfigSupported() { throw new TypeError("unsupported configuration"); }
  });
  vi.stubGlobal("VideoFrame", class {});
  expect(await worldCameraVideoEncodingAvailable(32, 32, 24)).toBe(false);
});

it("selects an AVC level that can contain the output instead of rejecting 2K/4K as level 3.1", async () => {
  const support = vi.fn(async () => ({ supported: true }));
  vi.stubGlobal("VideoEncoder", class { static isConfigSupported = support; });
  vi.stubGlobal("VideoFrame", class {});
  for (const [width, height, fps, codec] of [
    [1024, 576, 24, "avc1.42001f"], [1920, 1080, 30, "avc1.420028"],
    [2048, 1152, 24, "avc1.420033"], [3840, 2160, 24, "avc1.420033"],
    [3840, 2160, 60, "avc1.420034"]
  ] as const) {
    expect(await worldCameraVideoEncodingAvailable(width, height, fps)).toBe(true);
    expect(support).toHaveBeenLastCalledWith(expect.objectContaining({ width, height, framerate: fps,
      codec, hardwareAcceleration: "prefer-software" }));
  }
});

it("drains a buffered encoder without polling forever and preserves every sampled frame", async () => {
  const encoder = codec();
  const result = await encodeWorldCameraVideo(input());
  expect(result).toMatchObject({ ok: true, frames: 12, durationSeconds: 0.5 });
  expect(encoder.flushes()).toBeGreaterThan(1);
  expect(encoder.close).toHaveBeenCalledOnce();
});
it("rejects incomplete encoded output instead of publishing a shorter ready video", async () => {
  codec({ drop: true });
  expect(await encodeWorldCameraVideo(input())).toMatchObject({ ok: false, code: "capture-encode-failed" });
});
it("cancels a stalled encoder and releases it without waiting for the batch timeout", async () => {
  const encoder = codec({ stuck: true });
  const abort = new AbortController();
  const pending = encodeWorldCameraVideo({ ...input(), signal: abort.signal });
  await vi.waitFor(() => expect(encoder.flushes()).toBe(1));
  abort.abort();
  expect(await pending).toMatchObject({ ok: false, code: "cancelled" });
  expect(encoder.close).toHaveBeenCalledOnce();
});
