import { describe, expect, it } from "vitest";
import { parameterPresentation, orderParameterFields, summarizeParameters, migratePresentedParameters, type PresentableParameter } from "./parameter-schema.js";
describe("optional parameter presentation", () => {
  it("ignores invalid members independently and never guesses a key", () => {
    expect(parameterPresentation({ type: "integer", "x-pptask-presentation": { section: "common", order: NaN, summaryOrder: 2, semanticId: "count", control: "switch" } })).toEqual({ section: "common", summaryOrder: 2, semanticId: "count" });
    expect(parameterPresentation({ type: "number", title: "seed" })).toEqual({});
    expect(parameterPresentation({ type: "string", "x-pptask-control": "resolution" })).toMatchObject({ section: "common", semanticId: "pptask.resolution" });
    expect(orderParameterFields([{ key: "a", presentation: { order: 2 } }, { key: "b", presentation: { order: 1 } }, { key: "c", presentation: { order: 2 } }]).map(f => f.key)).toEqual(["b", "a", "c"]);
  });
  it("caps key values at three and counts boolean/number/text without linked duplicates", () => {
    const fields: PresentableParameter[] = [
      ...["a", "b", "c", "d"].map((key, summaryOrder) => ({ key, label: key, type: "text", presentation: { summaryOrder } })),
      { key: "flag", label: "flag", type: "boolean", defaultValue: false }, { key: "seed", label: "seed", type: "number", defaultValue: 1 },
      { key: "text", label: "text", type: "text", defaultValue: "" },
      { key: "bg", label: "背景", type: "select", requiresByValue: { transparent: { format: "png" } } }, { key: "format", label: "格式", defaultValue: "jpeg" },
    ];
    expect(summarizeParameters(fields, { a: "A", b: "B", c: "C", d: "D", flag: true, seed: 2, text: "note", bg: "transparent", format: "png" })).toBe("a：A · b：B · c：C · +5");
  });
  it("migrates only validated matching semantics and units, never just the same key", () => {
    const source = [{ key: "size", label: "size", type: "number", unit: "秒", presentation: { semanticId: "duration" } }];
    expect(migratePresentedParameters(source, [{ ...source[0]!, presentation: { semanticId: "pixels" } }], { size: 5 })).toEqual({});
    expect(migratePresentedParameters(source, [{ ...source[0]!, key: "duration", maximum: 4 }], { size: 5 })).toEqual({});
    expect(migratePresentedParameters(source, [{ ...source[0]!, key: "duration", maximum: 10 }], { size: 5 })).toEqual({ duration: 5 });
  });
});
