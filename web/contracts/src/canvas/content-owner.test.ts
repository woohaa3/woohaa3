import { describe, expect, it } from "vitest";
import { ContentContributionRegistry, decideContentWrite, type ContentNodeDataCodec } from "./content-contribution.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { normalizeCanvas } from "./domain/normalization.js";
import { filmSetContentContribution } from "./film-set-content.js";

function filmCanvas(content: unknown) {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-10-27T00:00:00.000Z");
  canvas.document.nodes = [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 }, measured: undefined, data: {} } as never];
  canvas.nodeData = { film: { extensionId: "film-set", filmSetContent: content } as never };
  return canvas;
}

describe("owner codec 分派", () => {
  it("注册片场 codec 后，规范化结果与缺省路径一致", () => {
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    const valid = { schemaVersion: 4, items: [] };
    const invalid = { schemaVersion: 99, items: [] };
    expect(normalizeCanvas(filmCanvas(valid), { content: registry }).nodeData.film).toEqual(normalizeCanvas(filmCanvas(valid)).nodeData.film);
    expect(normalizeCanvas(filmCanvas(invalid), { content: registry }).nodeData.film).toEqual(normalizeCanvas(filmCanvas(invalid)).nodeData.film);
    expect(normalizeCanvas(filmCanvas(invalid)).nodeData.film).not.toHaveProperty("filmSetContent");
  });

  it("未知或伪造身份稳定拒绝，codec 异常不带出异常文本", () => {
    const registry = new ContentContributionRegistry();
    registry.register(filmSetContentContribution);
    expect(decideContentWrite("creature-video-assets", {}, { filmSetContent: { schemaVersion: 4, items: [] } }, registry)).toEqual({
      ok: false,
      extensionId: "creature-video-assets",
      code: "content-owner-unavailable"
    });
    const rejected = decideContentWrite("film-set", {}, { filmSetContent: { schemaVersion: 99 } }, registry);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe("film-set-content-invalid");
    const throwing: ContentNodeDataCodec = {
      decode: () => ({ ok: true, value: {} }),
      validatePatch: () => { throw new Error("secret decoder detail"); },
      normalize: (data) => data,
      sanitizeRuntime: (data) => data,
      copy: (data) => ({ data, assetRefs: [], remap: {} }),
      diff: (before, after) => ({ ok: true, forward: after, inverse: before })
    };
    const broken = new ContentContributionRegistry();
    broken.register({ extensionId: "film-set", nodeData: throwing });
    expect(decideContentWrite("film-set", {}, {}, broken)).toEqual({ ok: false, extensionId: "film-set", code: "content-codec-failed" });
  });
});
