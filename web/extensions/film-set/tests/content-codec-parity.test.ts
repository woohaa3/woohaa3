import { describe, expect, it } from "vitest";
import { decodeFilmSetContent as decodeFromContracts, emptyFilmSetContent } from "@woohaa3/contracts";
import { decodeFilmSetContent as decodeFromShared } from "../src/state/shared/content/codec.js";

describe("片场内容 codec 只有一份实现", () => {
  it("契约再导出与扩展 shared 对同一组输入得到相同结果", () => {
    const samples = [undefined, null, {}, { schemaVersion: 4, items: [] }, { schemaVersion: 1, items: [{ id: "坏" }] }];
    for (const sample of samples) {
      expect(decodeFromShared(sample)).toEqual(decodeFromContracts(sample));
    }
    expect(decodeFromShared(undefined)).toEqual({ ok: true, value: emptyFilmSetContent() });
    expect(decodeFromShared).toBe(decodeFromContracts);
  });
});
