import { expect, it } from "vitest";
import { canonicalizeImageProjectContent, imageProjectContentHash, type ImageProjectContent } from "./content.js";
import { canonicalizeMode } from "../modes/content.js";

/**
 * 内容身份共享折叠的回归（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.2）。
 *
 * 与 Rust `document_content::modes_identity_tests` 对称：断言的是**共享入口**
 * `canonicalizeImageProjectContent`，不是本域的 `canonicalizeMode`。
 */

const layer = {
  id: "layer-1",
  name: "Background",
  kind: "pixel" as const,
  visible: true,
  opacity: 1,
  blend: "normal" as const,
  transform: { translateX: 0, translateY: 0, scale: 1, rotationDegrees: 0, flipHorizontal: false, flipVertical: false },
  mask: null,
  pixel: { sourceAssetId: "asset-base", contentHash: "0123456789abcdef" },
  text: null,
  adjustment: null
};

const content = (patch: Partial<ImageProjectContent> = {}): ImageProjectContent => ({
  canvasWidth: 8,
  canvasHeight: 6,
  layers: [layer],
  ...patch
});

it("keeps the historical identity of a document without mode data", () => {
  const text = canonicalizeImageProjectContent(content());
  expect(text).not.toBeNull();
  expect(text!.split("\n")[0]).toBe("canvas:8x6");
  expect(text).not.toContain("mode:");
});

it("treats an explicit default mode like an omitted one", () => {
  // 显式写 rgb/8 位与省略必须等价，否则序列化差异会改变旧工程指纹。
  expect(canonicalizeImageProjectContent(content({ mode: { mode: "rgb" } }))).toBe(
    canonicalizeImageProjectContent(content())
  );
  expect(canonicalizeImageProjectContent(content({ mode: null }))).toBe(
    canonicalizeImageProjectContent(content())
  );
});

it("appends exactly one mode line for converted documents", () => {
  const text = canonicalizeImageProjectContent(content({ mode: { mode: "grayscale" } }))!;
  const lines = text.split("\n").filter((line) => line.startsWith("mode:"));
  expect(lines).toEqual(["mode:grayscale"]);
  // 模式行在画布之后、图层之前，与 Rust `identity::canonicalize` 的顺序一致。
  expect(text.split("\n")[1]).toBe("mode:grayscale");
});

it("includes the color table and inks so those edits move the hash", () => {
  const indexed = content({ mode: { mode: "indexed", colorTable: { colors: ["#000000", "#ffffff"], transparent: null } } });
  const changed = content({ mode: { mode: "indexed", colorTable: { colors: ["#00ff00", "#ffffff"], transparent: null } } });
  expect(imageProjectContentHash(indexed)).not.toBe(imageProjectContentHash(changed));
  expect(canonicalizeImageProjectContent(indexed)).toContain("|table:2:#000000,#ffffff");

  const inks = content({ mode: { mode: "duotone", duotone: { inks: [
    { name: "Black", color: "#000000", curve: [[0, 0], [1, 1]] },
    { name: "Warm", color: "#9e612e", curve: [] }
  ] } } });
  const renamed = content({ mode: { mode: "duotone", duotone: { inks: [
    { name: "Iron", color: "#000000", curve: [[0, 0], [1, 1]] },
    { name: "Warm", color: "#9e612e", curve: [] }
  ] } } });
  expect(imageProjectContentHash(inks)).not.toBe(imageProjectContentHash(renamed));
});

it("refuses to fold structurally invalid mode data", () => {
  // 非法模式数据不能被当作「无变化」：整份内容不可判定。
  expect(canonicalizeImageProjectContent(content({ mode: { mode: "indexed" } }))).toBeNull();
  expect(canonicalizeImageProjectContent(content({ mode: { mode: "cmyk" } as never }))).toBeNull();
  expect(canonicalizeImageProjectContent(content({ mode: { mode: "duotone" } }))).toBeNull();
});

it("uses the same text as the domain contribution", () => {
  const mode = { mode: "indexed" as const, colorTable: { colors: ["#000000", "#ffffff"], transparent: 1 } };
  const line = canonicalizeMode(mode);
  expect(line).not.toBeNull();
  expect(canonicalizeImageProjectContent(content({ mode }))).toContain(line!);
});
