/**
 * 音频请求字段翻译的契约测试。
 *
 * 钉住两条：语义键 `outputFormat` 必须落成上游的 `response_format`；
 * 只发上游认识的字段，语速按公开区间夹住。
 */
import { describe, expect, it } from "vitest";
import { audioRequestFields } from "./audio-parameters.js";

describe("audioRequestFields", () => {
  it("outputFormat 落成 response_format，大小写归一", () => {
    expect(audioRequestFields({ voice: "nova", outputFormat: "WAV", speed: 1 })).toEqual({
      voice: "nova",
      response_format: "wav",
      speed: 1
    });
  });

  it("认历史键 response_format / responseFormat / format", () => {
    expect(audioRequestFields({ response_format: "opus" }).response_format).toBe("opus");
    expect(audioRequestFields({ responseFormat: "flac" }).response_format).toBe("flac");
    expect(audioRequestFields({ format: "pcm" }).response_format).toBe("pcm");
  });

  it("语速夹到 0.25–4；非法值不发", () => {
    expect(audioRequestFields({ speed: 9 }).speed).toBe(4);
    expect(audioRequestFields({ speed: 0 }).speed).toBe(0.25);
    expect(audioRequestFields({ speed: "fast" }).speed).toBeUndefined();
    expect(audioRequestFields({})).toEqual({});
  });

  it("只发上游认识的字段：outputFormat / prompt / 未知键都不透传", () => {
    const fields = audioRequestFields({
      prompt: "hello",
      outputFormat: "mp3",
      watermark: true,
      seed: 42
    });
    expect(fields).toEqual({ response_format: "mp3" });
  });
});
