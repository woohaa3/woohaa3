import { expect, it } from "vitest";
import { canonicalizeMask, type ImageProjectMaskSummary } from "./content.js";
import { canonicalizeImageProjectContent, type ImageProjectContent } from "../shared/content.js";

/**
 * 像素蒙版的内容身份（U24）。
 *
 * 这个函数的返回值被拼进**层身份字符串**，所以它直接决定"同一份工程是否被判成同一内容"。
 * 它此前没有任何回归：`null` 同时表示"无蒙版"和"非法"，两种含义混在一个返回值里，
 * 一旦写错就会静默改变旧工程的身份（或把非法蒙版当成合法）。
 */

const HASH = "0123456789abcdef";

function mask(patch: Partial<ImageProjectMaskSummary> = {}): ImageProjectMaskSummary {
  return { enabled: true, origin: "selection", contentHash: HASH, ...patch };
}

it("无蒙版与非法蒙版必须可区分（否则非法输入会被当成「没有蒙版」放行）", () => {
  // `null` 表示无蒙版；非法输入返回 `null`（调用方据此拒绝整个工程）。
  expect(canonicalizeMask(null)).toBe("none");
  // 每个必填字段缺失或类型不对都必须是非法，而不是退化成 `none`。
  expect(canonicalizeMask(undefined as unknown as ImageProjectMaskSummary)).toBeNull();
  expect(canonicalizeMask({} as unknown as ImageProjectMaskSummary)).toBeNull();
  expect(canonicalizeMask(mask({ enabled: "yes" as unknown as boolean }))).toBeNull();
  expect(canonicalizeMask(mask({ origin: "nope" as unknown as ImageProjectMaskSummary["origin"] }))).toBeNull();
  expect(canonicalizeMask(mask({ contentHash: "XYZ" }))).toBeNull();
  expect(canonicalizeMask(mask({ contentHash: "0123456789ABCDEF" }))).toBeNull();
  expect(canonicalizeMask(mask({ linked: "no" as unknown as boolean }))).toBeNull();
  // 关键：非法蒙版不能和"无蒙版"同串，否则会被当成合法身份。
  expect(canonicalizeMask({} as unknown as ImageProjectMaskSummary)).not.toBe("none");
});

it("linked 缺省与 linked: true 身份相同（旧工程兼容），仅 false 追加 :unlinked", () => {
  // 旧工程里没有 `linked` 字段；它必须与新建的 `linked: true` 判成同一内容，
  // 否则"打开旧工程再保存"会凭空产生一次身份变化。
  const absent = canonicalizeMask(mask());
  const linkedTrue = canonicalizeMask(mask({ linked: true }));
  expect(absent).toBe(linkedTrue);
  expect(absent).toBe("mask:1:selection:0123456789abcdef");
  // 只有明确 false 才是"已取消链接"，必须与链接态不同。
  const unlinked = canonicalizeMask(mask({ linked: false }));
  expect(unlinked).toBe("mask:1:selection:0123456789abcdef:unlinked");
  expect(unlinked).not.toBe(absent);
});

it("身份随 enabled / origin / contentHash 各自区分，互不串味", () => {
  const base = canonicalizeMask(mask());
  const enabledOff = canonicalizeMask(mask({ enabled: false }));
  const painted = canonicalizeMask(mask({ origin: "paint" }));
  const otherPixels = canonicalizeMask(mask({ contentHash: "fedcba9876543210" }));
  expect(new Set([base, enabledOff, painted, otherPixels]).size).toBe(4);
  // 字段顺序不影响身份：同一语义必须得到同一个串。
  expect(canonicalizeMask({ contentHash: HASH, origin: "paint", enabled: false }))
    .toBe(canonicalizeMask({ enabled: false, origin: "paint", contentHash: HASH }));
  // 无蒙版不受其它字段影响（不存在"半个蒙版"）。
  expect(canonicalizeMask(null)).toBe("none");
});

it("蒙版真的进了层身份：改 enabled/origin/哈希都会改变工程内容指纹", () => {
  // 上面几条测的是孤立函数；这里确认它确实被拼进层身份串，
  // 否则"蒙版参与身份"只是声明，实际改蒙版不会影响工程内容。
  const HASH = "0123456789abcdef";
  const base: ImageProjectContent = {
    canvasWidth: 8,
    canvasHeight: 8,
    layers: [{
      id: "l1",
      name: "层",
      kind: "pixel",
      visible: true,
      opacity: 1,
      blend: "normal",
      transform: { translateX: 0, translateY: 0, scale: 1, rotationDegrees: 0, flipHorizontal: false, flipVertical: false },
      mask: null,
      pixel: { sourceAssetId: null, contentHash: HASH },
      text: null,
      adjustment: null
    }]
  };
  const withMask = (patch: Partial<ImageProjectMaskSummary>) => canonicalizeImageProjectContent({
    ...base,
    layers: [{ ...base.layers[0]!, mask: { enabled: true, origin: "selection", contentHash: HASH, ...patch } }]
  });
  const none = canonicalizeImageProjectContent(base);
  const shown = withMask({});
  expect(none).not.toBeNull();
  expect(shown).not.toBeNull();
  expect(shown).not.toBe(none);
  // 三个属性各自必须能改变身份（否则改蒙版不改指纹 = 会把不同工程判成同一份）。
  expect(new Set([shown, withMask({ enabled: false }), withMask({ origin: "paint" }), withMask({ contentHash: "fedcba9876543210" })]).size).toBe(4);
  // 非法蒙版让整份工程内容非法，而不是被忽略成"无蒙版"。
  expect(canonicalizeImageProjectContent({
    ...base,
    layers: [{ ...base.layers[0]!, mask: { enabled: true, origin: "selection", contentHash: "XYZ" } }]
  })).toBeNull();
});
