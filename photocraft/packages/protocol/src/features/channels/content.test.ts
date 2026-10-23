// 通道内容身份：与 Rust `features/channels/content.rs` 同形同值（任务 3.2）。
import { describe, expect, it } from "vitest";
import { canonicalizeChannelContent, channelContentHash } from "./content.js";

const ALPHA = {
  name: "Alpha 一",
  kind: "alpha" as const,
  opacity: 0.5,
  indicates: "masked" as const,
  color: "#ff0000",
  contentHash: "0123456789abcdef"
};

const SPOT = {
  name: "专色绿",
  kind: "spot" as const,
  opacity: 0.5,
  indicates: "masked" as const,
  color: "#00ff00",
  solidity: 0.6,
  contentHash: "fedcba9876543210"
};

describe("通道内容身份", () => {
  it("没有通道时不产生字段，旧工程身份保持不变", () => {
    expect(canonicalizeChannelContent([])).toBeNull();
    expect(channelContentHash([])).toBeNull();
  });

  it("规范文本逐行对应通道行，专色带密度、Alpha 用占位", () => {
    expect(canonicalizeChannelContent([ALPHA, SPOT])).toBe(
      [
        "channels:2",
        "channel:7:Alpha 一:alpha:0.5:masked:#ff0000:-:0123456789abcdef",
        "channel:3:专色绿:spot:0.5:masked:#00ff00:0.6:fedcba9876543210"
      ].join("\n")
    );
  });

  it("名称/种类/不透明度/表示/颜色/密度/平面任一变化都改变指纹", () => {
    const base = channelContentHash([ALPHA, SPOT]);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    const variants = [
      [{ ...ALPHA, name: "Alpha 二" }, SPOT],
      [{ ...ALPHA, kind: "spot" as const, solidity: 0.2 }, SPOT],
      [{ ...ALPHA, opacity: 0.8 }, SPOT],
      [{ ...ALPHA, indicates: "selected" as const }, SPOT],
      [{ ...ALPHA, color: "#00ff00" }, SPOT],
      [{ ...ALPHA, contentHash: "0123456789abcdee" }, SPOT],
      [ALPHA, { ...SPOT, solidity: 0.9 }],
      // 顺序也是内容。
      [SPOT, ALPHA]
    ];
    for (const variant of variants) {
      expect(channelContentHash(variant)).not.toBe(base);
    }
  });

  it("非法形状返回 null（不猜），提示调用方当作无法判定", () => {
    expect(canonicalizeChannelContent([{ ...ALPHA, color: "red" }])).toBeNull();
    expect(canonicalizeChannelContent([{ ...ALPHA, contentHash: "xyz" }])).toBeNull();
    expect(canonicalizeChannelContent([{ ...ALPHA, opacity: Number.NaN }])).toBeNull();
    expect(canonicalizeChannelContent([{ ...SPOT, solidity: undefined }])).toBeNull();
    expect(canonicalizeChannelContent([{ ...ALPHA, kind: "print" as unknown as "alpha" }])).toBeNull();
  });

  it("固定 fixture：与 Rust `content.rs` 的同一行得到同一指纹", () => {
    // 期望值由 Rust 侧 `the_canonical_text_is_stable_for_the_shared_fixture` 对同一行独立算出，
    // 平面摘要取自内核 `document_content::surface_hash`。
    const rows = [
      { name: "Alpha 一", kind: "alpha" as const, opacity: 0.5, indicates: "masked" as const, color: "#ff0000", contentHash: "bcefb8c62038e88c" },
      { name: "专色绿", kind: "spot" as const, opacity: 0.5, indicates: "masked" as const, color: "#00ff00", solidity: 0.6, contentHash: "dba381ff3c2f495b" }
    ];
    expect(channelContentHash(rows)).toBe("984d1d9a4311a91d");
  });

  it("数值按 1e-4 归一，-0 与 0 同值", () => {
    expect(canonicalizeChannelContent([{ ...ALPHA, opacity: 0.50000001 }])).toBe(
      canonicalizeChannelContent([{ ...ALPHA, opacity: 0.5 }])
    );
    expect(canonicalizeChannelContent([{ ...ALPHA, opacity: -0 }])).toContain(":0:");
  });
});
