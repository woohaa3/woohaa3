/** 与 scripts/lib/extension-descriptor.mjs 的 semver 子集逐条一致（D1：range 语义只有一套规则）。 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { compareSemver, isSemver, maxSatisfying, satisfiesRange } from "./semver";

const VERSIONS = ["0.0.1", "0.0.2", "0.1.0", "0.1.5", "0.2.0", "1.0.0", "1.0.0-beta.1", "1.2.3", "1.2.9", "1.3.0", "2.0.0", "10.0.0", "1.2", "v1.0.0", "01.0.0"];
const RANGES = ["*", "x", "1", "1.x", "1.2.x", "1.2.3", "=1.2.3", "^1.2.3", "^0.1.0", "^0.0.1", "^0", "~1.2.3", "~1", ">=1.2.0", ">1.2.3", "<=1.2.3", "<2", ">=1.0.0 <2.0.0", "^1 || ^2", "1.0.0 ||", "", "  ", "garbage", "^a.b", ">=1.2.0-rc.1"];

describe("semver 子集", () => {
  it("与 scripts/lib 的 JS 实现逐条一致", async () => {
    const lib = (await import(pathToFileURL(path.resolve(__dirname, "../../../../../scripts/lib/extension-descriptor.mjs")).href)) as {
      satisfiesRange(version: string, range: string): boolean | null;
      isSemver(value: unknown): boolean;
    };
    for (const version of VERSIONS) {
      expect(isSemver(version), version).toBe(lib.isSemver(version));
      for (const range of RANGES) expect(satisfiesRange(version, range), `${version} ∈ ${range}`).toBe(lib.satisfiesRange(version, range));
    }
  });

  it("maxSatisfying 选最高满足版本", () => {
    expect(maxSatisfying(["1.0.0", "1.2.9", "1.3.0", "2.0.0"], "^1.2.0")).toBe("1.3.0");
    expect(maxSatisfying(["1.0.0", "10.0.0", "2.0.0"], "*")).toBe("10.0.0");
    expect(maxSatisfying(["1.0.0"], "^2")).toBeNull();
    expect(maxSatisfying(["bad"], "*")).toBeNull();
    expect(compareSemver("1.2.10", "1.2.9")).toBe(1);
  });
});
