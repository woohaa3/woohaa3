/**
 * 远端托管生成的结果必须能进执行历史（回归：2026-11-10「产物在 COS 里但画布说没有产物」）。
 *
 * 根因链：provider 成功时返回稳定媒体信封 `{ media: { locator, contentType, size, checksum } }`，
 * 而 history 的 `outputs()` 只认 `images`/`videos`/`outputs`/`content`，于是抽出的 outputs 是空的；
 * history 里这条成功记录没有任何产物，画布投影只能判成「成功但无产物」。
 *
 * 这里锁住两件事：
 * 1. `extractExecutionResult` 能从 `media` 信封抽出带 locator 的输出；
 * 2. `readSafeResult` 把 locator 与 metadata 原样带进历史摘要（不再降级成 `{ mediaKind }` 占位）。
 */
import { describe, expect, it } from "vitest";
import { extractExecutionResult } from "@sdppp/pptask-worker-server/history";
import { readSafeResult } from "./execution-projection.js";

const CHECKSUM = "69bf546f4d6505bf55ee8d5f1642cba651fb9691a4f080355771b7a7e928ec01";
const LOCATOR = "media://server/canvas-1/media/generation-outputs/task-355aa4cd.png";

/** remote-server / GPU worker 成功终态的真实形状：只有稳定位置，没有 URL 或字节。 */
function stableMediaValue(overrides: Record<string, unknown> = {}) {
  return {
    media: {
      locator: LOCATOR,
      // 注意：worker 链的 storageKey 由任务 id 派生，不满足内容寻址契约，可能是空串。
      storageKey: "",
      contentType: "image/png",
      size: 1913800,
      checksum: CHECKSUM,
      ...overrides
    }
  };
}

function record(result: unknown) {
  return {
    id: "run-7383e057-6c02-432d-90df-552013f11bc9",
    state: "succeeded" as const,
    providerId: "remote-server",
    modelType: "image" as const,
    result
  };
}

describe("稳定媒体信封进执行历史", () => {
  it("extractExecutionResult 从 media 信封抽出带 locator 的产物", () => {
    const extracted = extractExecutionResult(stableMediaValue());
    expect(extracted.outputCount).toBe(1);
    expect(extracted.outputs[0]).toMatchObject({
      kind: "image",
      locator: LOCATOR,
      mediaType: "image/png",
      size: 1913800,
      checksum: CHECKSUM
    });
  });

  it("readSafeResult 把 locator 与 metadata 带进历史摘要", () => {
    const summary = readSafeResult(record(extractExecutionResult(stableMediaValue())) as never);
    expect(summary).toMatchObject({
      mediaKind: "image",
      locator: LOCATOR,
      contentType: "image/png",
      size: 1913800,
      checksum: CHECKSUM
    });
  });

  it("只有 storageKey（无 locator）时同样能落历史", () => {
    const value = stableMediaValue();
    const summary = readSafeResult(record(extractExecutionResult({
      media: { ...value.media, locator: "", storageKey: `generation-outputs/${CHECKSUM}.png` }
    })) as never);
    expect(summary).toMatchObject({ mediaKind: "image", storageKey: `generation-outputs/${CHECKSUM}.png` });
  });

  it("位置完全缺失时不算产物（不伪造成功）", () => {
    const extracted = extractExecutionResult({
      media: { storageKey: "", contentType: "image/png", size: 10 }
    });
    expect(extracted.outputCount).toBe(0);
    // 没有位置就没有产物：readSafeResult 返回 undefined，投影侧走可见失败。
    expect(readSafeResult(record(extracted) as never)).toBeUndefined();
  });

  it("URL 形态的 provider 输出仍只留媒体类型占位（不写地址）", () => {
    const summary = readSafeResult(record(extractExecutionResult({
      images: ["https://provider.example/tmp/abc.png"]
    })) as never);
    expect(summary).toEqual({ mediaKind: "image" });
  });

  it("文本结果不受影响", () => {
    const summary = readSafeResult(record(extractExecutionResult({ text: "结果文本" })) as never);
    expect(summary).toEqual({ mediaKind: "text", text: "结果文本" });
  });
});
