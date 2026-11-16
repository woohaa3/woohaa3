import { describe, expect, it } from "vitest";
import {
  filterModelRoutesForRegion,
  isEndpointAvailableInRegion,
  type RunningHubEndpointAvailability
} from "../src/model-availability.js";

/** 集合表示“明确不可用”，不是可用白名单。 */
const availability: RunningHubEndpointAvailability = {
  ai: new Set(["dola-Seedream-5.0-flash/text-to-image", "both/missing"]),
  cn: new Set(["seedream-v5-flash/text-to-image", "both/missing"])
};

describe("RunningHub 区域可用性", () => {
  it("只隐藏该区域有证据不可用的端点", () => {
    expect(isEndpointAvailableInRegion("ai", "dola-Seedream-5.0-flash/text-to-image", availability)).toBe(false);
    expect(isEndpointAvailableInRegion("cn", "dola-Seedream-5.0-flash/text-to-image", availability)).toBe(true);
    expect(isEndpointAvailableInRegion("cn", "seedream-v5-flash/text-to-image", availability)).toBe(false);
    expect(isEndpointAvailableInRegion("ai", "seedream-v5-flash/text-to-image", availability)).toBe(true);
  });

  it("两边都不可用或未知时按各自清单处理", () => {
    expect(isEndpointAvailableInRegion("ai", "both/missing", availability)).toBe(false);
    expect(isEndpointAvailableInRegion("cn", "both/missing", availability)).toBe(false);
    expect(isEndpointAvailableInRegion("ai", "unknown/endpoint", availability)).toBe(true);
    expect(isEndpointAvailableInRegion("cn", "unknown/endpoint", availability)).toBe(true);
  });

  it("兼容带前导斜杠的上游路径", () => {
    expect(isEndpointAvailableInRegion("cn", "/seedream-v5-flash/text-to-image", availability)).toBe(false);
    expect(isEndpointAvailableInRegion("ai", "/seedream-v5-flash/text-to-image", availability)).toBe(true);
  });

  it("过滤路由；全部不可用时返回 undefined", () => {
    const mixed = {
      id: "mixed",
      routes: [
        { endpoint: "unknown/endpoint" },
        { endpoint: "seedream-v5-flash/text-to-image" }
      ]
    };
    expect(filterModelRoutesForRegion(mixed, "cn", availability)?.routes).toEqual([
      { endpoint: "unknown/endpoint" }
    ]);
    expect(filterModelRoutesForRegion(mixed, "ai", availability)?.routes).toEqual([
      { endpoint: "unknown/endpoint" },
      { endpoint: "seedream-v5-flash/text-to-image" }
    ]);

    const cnMissing = { id: "cn-missing", routes: [{ endpoint: "seedream-v5-flash/text-to-image" }] };
    expect(filterModelRoutesForRegion(cnMissing, "cn", availability)).toBeUndefined();
    expect(filterModelRoutesForRegion(cnMissing, "ai", availability)).toEqual(cnMissing);
  });
});
