import { describe, expect, it } from "vitest";
import {
  filterModelRoutesForRegion,
  isEndpointAvailableInRegion,
  type RunningHubEndpointAvailability
} from "../src/model-availability.js";

/** 集合表示各站点 SKU 清单覆盖到的可用端点。 */
const availability: RunningHubEndpointAvailability = {
  ai: new Set(["ai-only/text-to-image", "both/edit"]),
  cn: new Set(["cn-only/text-to-video", "both/edit"])
};

describe("RunningHub 区域可用性", () => {
  it("国内站严格按国内 SKU 白名单", () => {
    expect(isEndpointAvailableInRegion("cn", "cn-only/text-to-video", availability)).toBe(true);
    expect(isEndpointAvailableInRegion("cn", "both/edit", availability)).toBe(true);
    expect(isEndpointAvailableInRegion("cn", "ai-only/text-to-image", availability)).toBe(false);
    // 两边都没有的未知端点在国内站也隐藏：GPT Image／dola 等可能不在任何 SKU 清单里。
    expect(isEndpointAvailableInRegion("cn", "unknown/endpoint", availability)).toBe(false);
  });

  it("国际站只隐藏国内站独有端点，未知保留", () => {
    expect(isEndpointAvailableInRegion("ai", "ai-only/text-to-image", availability)).toBe(true);
    expect(isEndpointAvailableInRegion("ai", "both/edit", availability)).toBe(true);
    expect(isEndpointAvailableInRegion("ai", "cn-only/text-to-video", availability)).toBe(false);
    expect(isEndpointAvailableInRegion("ai", "unknown/endpoint", availability)).toBe(true);
  });

  it("兼容带前导斜杠的上游路径", () => {
    expect(isEndpointAvailableInRegion("cn", "/ai-only/text-to-image", availability)).toBe(false);
    expect(isEndpointAvailableInRegion("cn", "/both/edit", availability)).toBe(true);
  });

  it("两边清单都为空时不隐藏，避免清空目录", () => {
    const empty = { ai: new Set<string>(), cn: new Set<string>() };
    expect(isEndpointAvailableInRegion("ai", "unknown/endpoint", empty)).toBe(true);
    expect(isEndpointAvailableInRegion("cn", "unknown/endpoint", empty)).toBe(true);
  });

  it("过滤路由；全部不可用时返回 undefined", () => {
    const mixed = {
      id: "mixed",
      routes: [
        { endpoint: "both/edit" },
        { endpoint: "cn-only/text-to-video" }
      ]
    };
    expect(filterModelRoutesForRegion(mixed, "cn", availability)?.routes).toEqual([
      { endpoint: "both/edit" },
      { endpoint: "cn-only/text-to-video" }
    ]);
    expect(filterModelRoutesForRegion(mixed, "ai", availability)?.routes).toEqual([
      { endpoint: "both/edit" }
    ]);

    const aiOnly = { id: "ai-only", routes: [{ endpoint: "ai-only/text-to-image" }] };
    expect(filterModelRoutesForRegion(aiOnly, "cn", availability)).toBeUndefined();
    expect(filterModelRoutesForRegion(aiOnly, "ai", availability)).toEqual(aiOnly);

    const unknown = { id: "unknown", routes: [{ endpoint: "unknown/endpoint" }] };
    expect(filterModelRoutesForRegion(unknown, "cn", availability)).toBeUndefined();
    expect(filterModelRoutesForRegion(unknown, "ai", availability)).toEqual(unknown);
  });
});
