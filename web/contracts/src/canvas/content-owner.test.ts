import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, decideContentWrite, type ContentNodeDataCodec } from "./content-contribution.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { normalizeCanvas } from "./domain/normalization.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const demoCodec: ContentNodeDataCodec = {
  decode: (data) => isRecord(data) && isRecord(data.demo)
    ? { ok: true, value: data.demo }
    : { ok: false, code: "invalid", reason: "demo 缺失" },
  validatePatch: () => null,
  normalize: (data) => {
    if (!isRecord(data)) return data;
    const demo = isRecord(data.demo) ? data.demo : undefined;
    if (demo?.version !== 1) {
      const { demo: _drop, ...rest } = data;
      return rest;
    }
    return data;
  },
  sanitizeRuntime: (data) => data,
  copy: (data) => ({ data, assetRefs: [], remap: {} }),
  diff: (before, after) => ({ ok: true, forward: after, inverse: before })
};

function demoCanvas(content: unknown) {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-27T00:00:00.000Z");
  canvas.document.nodes = [{ id: "demo", type: "composite-asset", position: { x: 0, y: 0 } }];
  canvas.nodeData = { demo: { extensionId: "demo-content", demo: content } as never };
  return canvas;
}

describe("owner codec 分派", () => {
  it("注册 codec 后按 owner 归一化内容", () => {
    const registry = new ContentContributionRegistry();
    registry.register({ extensionId: "demo-content", nodeData: demoCodec });
    const valid = { version: 1, text: "ok" };
    const invalid = { version: 99 };
    expect(normalizeCanvas(demoCanvas(valid), { content: registry }).nodeData.demo).toEqual(demoCanvas(valid).nodeData.demo);
    expect(normalizeCanvas(demoCanvas(invalid), { content: registry }).nodeData.demo).toEqual({ extensionId: "demo-content" });
  });

  it("未知或伪造身份稳定拒绝，codec 异常不带出异常文本", () => {
    const registry = new ContentContributionRegistry();
    registry.register({ extensionId: "demo-content", nodeData: demoCodec });
    expect(decideContentWrite("other-content", {}, { demo: { version: 1 } }, registry)).toEqual({
      ok: false,
      extensionId: "other-content",
      code: "content-owner-unavailable"
    });
    const throwing: ContentNodeDataCodec = {
      decode: () => ({ ok: true, value: {} }),
      validatePatch: () => { throw new Error("secret decoder detail"); },
      normalize: (data) => data,
      sanitizeRuntime: (data) => data,
      copy: (data) => ({ data, assetRefs: [], remap: {} }),
      diff: (before, after) => ({ ok: true, forward: after, inverse: before })
    };
    const broken = new ContentContributionRegistry();
    broken.register({ extensionId: "demo-content", nodeData: throwing });
    expect(decideContentWrite("demo-content", {}, {}, broken)).toEqual({ ok: false, extensionId: "demo-content", code: "content-codec-failed" });
  });
});
