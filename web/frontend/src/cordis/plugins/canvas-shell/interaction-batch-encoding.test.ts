import { describe, expect, it } from "vitest";
import { encodeInteractionBatch } from "./interaction-batch-encoding";

describe("interaction upload byte budgets", () => {
  it.each([false, true])("bounds UTF-8 and preserves sample order (closing=%s)", (closing) => {
    const original = Array.from({ length: 256 }, (_, index) => ({ index, text: "模型".repeat(200) }));
    const pending = [...original];
    const sent: typeof original = [];
    while (pending.length) {
      const payload = { samples: pending.splice(0), metadata: { name: "画布" } };
      const encoded = encodeInteractionBatch(payload, closing);
      expect(new TextEncoder().encode(encoded.body).byteLength).toBeLessThanOrEqual((closing ? 60 : 120) * 1024);
      sent.push(...JSON.parse(encoded.body).samples);
      pending.push(...encoded.remainder);
    }
    expect(sent).toEqual(original);
  });
  it("rejects one oversized sample", () => {
    expect(() => encodeInteractionBatch({ samples: ["x".repeat(130 * 1024)] }, false)).toThrow();
  });
});
