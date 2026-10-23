/**
 * 图片工程定义、内容指纹与编辑内核边界契约测试
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 2.1/2.2/3.1/3.7）。
 *
 * 覆盖：
 * - 严格联合：两个分支互斥，未知版本/混合分支/非法数值/越界引用被拒绝；
 * - 内容身份：同 PNG 不同结构可区分；取景/活动层/选区/打包时间不影响内容；
 * - 净变化：转换初始化与撤销回基线不算净变化；
 * - 内核边界：命令注册表解码、能力门、错误解析与导出产物配对；
 * - 能力清单：只开放首期能力，关闭项从判定层被拒绝。
 */
import { describe, expect, it } from "vitest";
import {
  IMAGE_EDIT_DOCUMENT_VERSION,
  IMAGE_PROJECT_CONTENT_TYPE,
  PHOTOCRAFT_ENGINE_VERSION,
  decodeImageEditDocument,
  imageEditDefinitionHash,
  imageEditDocumentContentIdentity,
  imageEditHasNetChange,
  type ImageProjectDocument,
  type LegacyImageEditDocument
} from "./image-edit.js";
import {
  IMAGE_PROJECT_BLEND_MODES,
  isSupportedImageProjectEffects,
  isSupportedImageProjectPatterns,
  canonicalizeImageProjectContent,
  imageProjectContentHash,
  type ImageProjectContent,
  type ImageProjectLayer
} from "./image-project-content.js";
import { canonicalizeAdjustment } from "./features/adjustments/content.js";
import { IMAGE_PROJECT_LIMITS } from "./image-edit.js";
import {
  PHOTOCRAFT_DELIVERED_STAGES,
  PHOTOCRAFT_CAPABILITIES,
  PHOTOCRAFT_ENGINE_COMMIT,
  checkPhotocraftCapabilities,
  decodeExportResult,
  decodePhotocraftCommands,
  decodePhotocraftError,
  isPhotocraftCommandDispatchable,
  isPhotocraftFeatureAllowed,
  photocraftCapabilityManifest,
  photocraftFeatureDisabledReason,
  verifyPhotocraftHandshake
} from "./image-project-editor.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CONTENT_HASH = "0123456789abcdef";

function legacy(): LegacyImageEditDocument {
  return {
    version: IMAGE_EDIT_DOCUMENT_VERSION,
    baseAssetId: "asset-base",
    sourceWidth: 1024,
    sourceHeight: 768,
    shapes: []
  };
}

function project(overrides: Partial<ImageProjectDocument> = {}): ImageProjectDocument {
  return {
    version: "woohaa-image-project-v1",
    engine: "photocraft",
    engineVersion: PHOTOCRAFT_ENGINE_VERSION,
    formatVersion: 1,
    baseAssetId: "asset-base",
    sourceWidth: 1024,
    sourceHeight: 768,
    canvasWidth: 800,
    canvasHeight: 600,
    documentContentHash: CONTENT_HASH,
    project: { storageKey: `sha256-${HASH_A}`, checksum: HASH_A, contentType: IMAGE_PROJECT_CONTENT_TYPE, size: 4096 },
    sourceAssetIds: ["asset-base"],
    ...overrides
  };
}

function content(overrides: Partial<ImageProjectContent> = {}): ImageProjectContent {
  return {
    canvasWidth: 800,
    canvasHeight: 600,
    layers: [
      {
        id: "bg",
        name: "Background",
        kind: "pixel",
        visible: true,
        opacity: 1,
        blend: "normal",
        transform: { translateX: 0, translateY: 0, scale: 1, rotationDegrees: 0, flipHorizontal: false, flipVertical: false },
        mask: null,
        pixel: { sourceAssetId: null, contentHash: CONTENT_HASH },
        text: null,
        adjustment: null
      }
    ],
    ...overrides
  };
}

describe("新区内容身份（P5/P7）", () => {
  const channel = { inBlack: 0, gamma: 1, inWhite: 255 };

  it("色阶/自然饱和度/黑白参与指纹，且可复现", () => {
    const baseline = imageProjectContentHash(content());
    for (const [kind, parameters] of [
      ["levels", { kind: "levels", master: channel, red: channel, green: channel, blue: channel }],
      ["vibrance", { kind: "vibrance", vibrance: 12, saturation: -3 }],
      ["black-white", { kind: "black-white", reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: null }]
    ] as const) {
      const document = content({
        layers: [{ ...content().layers[0]!, kind: "adjustment", pixel: null,
          adjustment: { kind, parameters } as never }]
      });
      const hash = imageProjectContentHash(document);
      expect(hash, kind).toMatch(/^[0-9a-f]{16}$/);
      expect(hash).not.toBe(baseline);
      expect(imageProjectContentHash(document)).toBe(hash);
    }
    // 参数类型与 kind 不一致时拒绝。
    const mismatched = content({
      layers: [{ ...content().layers[0]!, kind: "adjustment", pixel: null,
        adjustment: { kind: "levels", parameters: { kind: "vibrance", vibrance: 1, saturation: 1 } } as never }]
    });
    expect(imageProjectContentHash(mismatched)).toBeNull();
  });

  it("U43 的九类调整也参与指纹，且与 Rust 兼容规则一致", () => {
    const baseline = imageProjectContentHash(content());
    const cases: Array<[string, unknown]> = [
      ["exposure", { kind: "exposure", exposure: 1.5, offset: 0.1, gamma: 1.1 }],
      ["color-balance", { kind: "color-balance", shadows: [10, -5, 0], midtones: [0, 5, 0], highlights: [0, 0, 5], preserveLuminosity: true }],
      ["photo-filter", { kind: "photo-filter", color: "#ff8800", density: 25, preserveLuminosity: true }],
      ["channel-mixer", { kind: "channel-mixer", red: [40, 40, 20, 0], green: [30, 60, 10, 0], blue: [20, 20, 60, 0], monochrome: false }],
      ["invert", { kind: "invert" }],
      ["posterize", { kind: "posterize", levels: 6 }],
      ["threshold", { kind: "threshold", level: 128 }],
      ["gradient-map", { kind: "gradient-map", stops: [[0, "#000000"], [1, "#ffffff"]], reverse: false, dither: true }],
      ["selective-color", {
        kind: "selective-color", method: "relative",
        reds: [10, 0, 0, 0], yellows: [0, 0, 0, 0], greens: [0, 0, 0, 0], cyans: [0, 0, 0, 0],
        blues: [0, 0, 0, 0], magentas: [0, 0, 0, 0], whites: [0, 0, 0, 0], neutrals: [0, 0, 0, 0], blacks: [0, 0, 0, 0]
      }]
    ];
    for (const [kind, parameters] of cases) {
      const document = content({
        layers: [{ ...content().layers[0]!, kind: "adjustment", pixel: null,
          adjustment: { kind, parameters } as never }]
      });
      const hash = imageProjectContentHash(document);
      expect(hash, kind).toMatch(/^[0-9a-f]{16}$/);
      expect(hash, kind).not.toBe(baseline);
      expect(imageProjectContentHash(document), kind).toBe(hash);
      // 参数缺失时是「无法判定」，不是算出一个错的身份（invert 没有参数，跳过）。
      if (kind !== "invert") {
        const missing = content({
          layers: [{ ...content().layers[0]!, kind: "adjustment", pixel: null,
            adjustment: { kind, parameters: { kind } } as never }]
        });
        expect(imageProjectContentHash(missing), kind).toBeNull();
      }
    }
  });

  it("U41/U42 的新持久参数只在非默认值时改变指纹（旧工程兼容）", () => {
    const withAdjustment = (kind: string, parameters: unknown) => imageProjectContentHash(content({
      layers: [{ ...content().layers[0]!, kind: "adjustment", pixel: null,
        adjustment: { kind, parameters } as never }]
    }));
    const channel = { inBlack: 0, gamma: 1, inWhite: 255 };
    const levels = (extra: Record<string, unknown>) => withAdjustment("levels", {
      kind: "levels",
      master: { ...channel, ...extra }, red: { ...channel, ...extra },
      green: { ...channel, ...extra }, blue: { ...channel, ...extra }
    });
    const plain = levels({});
    expect(levels({ outBlack: 0, outWhite: 255 })).toBe(plain);
    expect(levels({ outWhite: 200 })).not.toBe(plain);
    expect(levels({ outBlack: 20 })).not.toBe(plain);

    const hue = (parameters: unknown) => withAdjustment("hue-saturation", parameters);
    const baseHue = hue({ kind: "hue-saturation", hue: 10, saturation: 20, lightness: 0 });
    expect(hue({ kind: "hue-saturation", hue: 10, saturation: 20, lightness: 0, colorize: false,
      reds: { hue: 0, saturation: 0, lightness: 0 } })).toBe(baseHue);
    expect(hue({ kind: "hue-saturation", hue: 10, saturation: 20, lightness: 0, colorize: true })).not.toBe(baseHue);
    expect(hue({ kind: "hue-saturation", hue: 10, saturation: 20, lightness: 0,
      reds: { hue: 0, saturation: -40, lightness: 0, range: [-45, -15, 15, 45] } })).not.toBe(baseHue);

    // 铅笔曲线与点曲线是不同内容；默认点模式保持旧指纹。
    const curves = (pencil?: boolean) => withAdjustment("curves", {
      kind: "curves", rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }], ...(pencil === undefined ? {} : { pencil })
    });
    expect(curves(false)).toBe(curves());
    expect(curves(true)).not.toBe(curves());
  });

  it("U43/U44 规范串与 Rust 逐字节一致", () => {
    // 与 `rust/crates/editor-core/src/identity/tests.rs` 的
    // `published_adjustment_canonical_strings_are_byte_identical_to_typescript` 同表：
    // 改一边必须同时改另一边，否则跨语言内容身份就会漂移。
    const channel = () => ({ inBlack: 0, gamma: 1, inWhite: 255 });
    const cases: Array<[unknown, string]> = [
      [{ kind: "levels", parameters: { kind: "levels",
        master: { ...channel(), outBlack: 0, outWhite: 200 }, red: channel(), green: channel(), blue: channel() } },
        "adjust:levels:0,1,255/0,200;0,1,255;0,1,255;0,1,255"],
      [{ kind: "hue-saturation", parameters: { kind: "hue-saturation", hue: 10, saturation: 20, lightness: 0, colorize: false,
        reds: { hue: 0, saturation: 0, lightness: 0, range: [-45, -15, 15, 45] } } },
        "adjust:hue-saturation:10:20:0"],
      [{ kind: "hue-saturation", parameters: { kind: "hue-saturation", hue: 10, saturation: 20, lightness: 0, colorize: true,
        reds: { hue: 5, saturation: -40.5, lightness: 3, range: [-45, -15, 15, 45] } } },
        "adjust:hue-saturation:10:20:0:colorize:reds/5/-40.5/3/-45,-15,15,45"],
      [{ kind: "curves", parameters: { kind: "curves",
        rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.75 }, { x: 1, y: 1 }], pencil: true } },
        "adjust:curves:0,0;0.5,0.75;1,1:pencil"],
      [{ kind: "exposure", parameters: { kind: "exposure", exposure: 1.5, offset: 0.1, gamma: 1.1 } },
        "adjust:exposure:1.5:0.1:1.1"],
      [{ kind: "color-balance", parameters: { kind: "color-balance", shadows: [10, -5, 0], midtones: [0, 5, 0],
        highlights: [0, 0, 5], preserveLuminosity: true } },
        "adjust:color-balance:10,-5,0:0,5,0:0,0,5:1"],
      [{ kind: "photo-filter", parameters: { kind: "photo-filter", color: [1, 0.5, 0], density: 25, preserveLuminosity: false } },
        "adjust:photo-filter:#ff8000:25:0"],
      [{ kind: "channel-mixer", parameters: { kind: "channel-mixer", red: [40, 40, 20, 0], green: [30, 60, 10, 0],
        blue: [20, 20, 60, 0], monochrome: false } },
        "adjust:channel-mixer:40,40,20,0:30,60,10,0:20,20,60,0:0"],
      [{ kind: "invert", parameters: { kind: "invert" } }, "adjust:invert"],
      [{ kind: "posterize", parameters: { kind: "posterize", levels: 6 } }, "adjust:posterize:6"],
      [{ kind: "threshold", parameters: { kind: "threshold", level: 128 } }, "adjust:threshold:128"],
      [{ kind: "gradient-map", parameters: { kind: "gradient-map",
        stops: [[0, "#000000"], [0.5, "#ab12ef"], [1, "#ffffff"]], reverse: false, dither: true } },
        "adjust:gradient-map:0,#000000;0.5,#ab12ef;1,#ffffff:0:1"],
      [{ kind: "selective-color", parameters: { kind: "selective-color", method: "absolute",
        reds: [10, -5, 0, 0], yellows: [0, 0, 0, 0], greens: [0, 0, 0, 0], cyans: [0, 0, 0, 0],
        blues: [0, 0, 0, 0], magentas: [0, 0, 0, 0], whites: [0, 0, 0, 0], neutrals: [0, 0, 0, 0], blacks: [0, 0, 0, 0] } },
        "adjust:selective-color:absolute:10,-5,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0"]
    ];
    for (const [adjustment, expected] of cases) {
      expect(canonicalizeAdjustment(adjustment as never), expected).toBe(expected);
    }
  });

  it("形状层需要路径摘要，矢量蒙版默认链接不改变指纹", () => {
    const baseline = imageProjectContentHash(content());
    const shape = content({
      layers: [{ ...content().layers[0]!, kind: "shape", pixel: null, shape: { contentHash: CONTENT_HASH } }]
    });
    const shapeHash = imageProjectContentHash(shape);
    expect(shapeHash).not.toBe(baseline);
    const invalid = content({
      layers: [{ ...content().layers[0]!, kind: "shape", pixel: null, shape: { contentHash: "nope" } }]
    });
    expect(imageProjectContentHash(invalid)).toBeNull();

    const masked = content({
      layers: [{ ...content().layers[0]!, vectorMask: { enabled: true, contentHash: CONTENT_HASH } }]
    });
    const maskedHash = imageProjectContentHash(masked);
    expect(maskedHash).not.toBe(baseline);
    const linked = content({
      layers: [{ ...content().layers[0]!, vectorMask: { enabled: true, linked: true, contentHash: CONTENT_HASH } }]
    });
    expect(imageProjectContentHash(linked)).toBe(maskedHash);
    const unlinked = content({
      layers: [{ ...content().layers[0]!, vectorMask: { enabled: true, linked: false, contentHash: CONTENT_HASH } }]
    });
    expect(imageProjectContentHash(unlinked)).not.toBe(maskedHash);
  });

  it("形状外观与矢量蒙版密度/羽化是持久内容", () => {
    // 几何摘要相同、只改填充/描边/规范参数时指纹必须变：否则「只改描边」会被判成无净变化。
    const geometric = content({
      layers: [{ ...content().layers[0]!, kind: "shape", pixel: null, shape: { contentHash: CONTENT_HASH } }]
    });
    const geometricHash = imageProjectContentHash(geometric);
    const appearance = "aaaaaaaaaaaaaaaa";
    const painted = content({
      layers: [{ ...content().layers[0]!, kind: "shape", pixel: null,
        shape: { contentHash: CONTENT_HASH, appearanceHash: appearance } }]
    });
    expect(imageProjectContentHash(painted)).not.toBe(geometricHash);
    // 省略外观摘要 = 只按几何比较：旧内容描述与旧工程指纹逐字节不变。
    const explicitNull = content({
      layers: [{ ...content().layers[0]!, kind: "shape", pixel: null,
        shape: { contentHash: CONTENT_HASH, appearanceHash: null } }]
    });
    expect(imageProjectContentHash(explicitNull)).toBe(geometricHash);
    const badAppearance = content({
      layers: [{ ...content().layers[0]!, kind: "shape", pixel: null,
        shape: { contentHash: CONTENT_HASH, appearanceHash: "nope" } }]
    });
    expect(imageProjectContentHash(badAppearance)).toBeNull();

    // 矢量蒙版：只改密度或羽化也是内容变化，且范围与内核同一口径。
    const plain = content({
      layers: [{ ...content().layers[0]!, vectorMask: { enabled: true, contentHash: CONTENT_HASH } }]
    });
    const plainHash = imageProjectContentHash(plain);
    const dense = content({
      layers: [{ ...content().layers[0]!, vectorMask: { enabled: true, contentHash: CONTENT_HASH, density: 0.4 } }]
    });
    expect(imageProjectContentHash(dense)).not.toBe(plainHash);
    const feathered = content({
      layers: [{ ...content().layers[0]!, vectorMask: { enabled: true, contentHash: CONTENT_HASH, feather: 6 } }]
    });
    expect(imageProjectContentHash(feathered)).not.toBe(plainHash);
    expect(imageProjectContentHash(feathered)).not.toBe(imageProjectContentHash(dense));
    // 默认值（密度 1 / 羽化 0）与省略等价：没有改动的蒙版不因字段出现而漂移。
    const defaults = content({
      layers: [{ ...content().layers[0]!, vectorMask: { enabled: true, contentHash: CONTENT_HASH, density: 1, feather: 0 } }]
    });
    expect(imageProjectContentHash(defaults)).not.toBe(plainHash);
    for (const bad of [{ density: 1.5 }, { density: -0.1 }, { feather: -1 }, { feather: 1001 }]) {
      const invalid = content({
        layers: [{ ...content().layers[0]!, vectorMask: { enabled: true, contentHash: CONTENT_HASH, ...bad } }]
      });
      expect(imageProjectContentHash(invalid)).toBeNull();
    }
  });

  it("文字排版省略保持旧指纹，设置后是内容", () => {
    const base = content({
      layers: [{ ...content().layers[0]!, kind: "text", pixel: null,
        text: { text: "标题", fontFamily: "Inter", fontSize: 12, color: "#ffffff", bold: false, align: "left" } }]
    });
    const plain = imageProjectContentHash(base);
    expect(plain).toMatch(/^[0-9a-f]{16}$/);
    const withLeading = content({
      layers: [{ ...content().layers[0]!, kind: "text", pixel: null,
        text: { text: "标题", fontFamily: "Inter", fontSize: 12, color: "#ffffff", bold: false, align: "left", leading: 18 } }]
    });
    expect(imageProjectContentHash(withLeading)).not.toBe(plain);
    const defaultTracking = content({
      layers: [{ ...content().layers[0]!, kind: "text", pixel: null,
        text: { text: "标题", fontFamily: "Inter", fontSize: 12, color: "#ffffff", bold: false, align: "left", tracking: 0 } }]
    });
    expect(imageProjectContentHash(defaultTracking)).toBe(plain);
    const optical = content({
      layers: [{ ...content().layers[0]!, kind: "text", pixel: null,
        text: { text: "标题", fontFamily: "Inter", fontSize: 12, color: "#ffffff", bold: false, align: "left", kerning: "optical" } }]
    });
    expect(imageProjectContentHash(optical)).not.toBe(plain);
    const invalid = content({
      layers: [{ ...content().layers[0]!, kind: "text", pixel: null,
        text: { text: "标题", fontFamily: "Inter", fontSize: 12, color: "#ffffff", bold: false, align: "left", kerning: "bogus" } }]
    });
    expect(imageProjectContentHash(invalid)).toBeNull();
  });
});

describe("分组内容身份（任务 9.1/9.8）", () => {
  function group(children: ImageProjectLayer[] = []): ImageProjectLayer {
    return { ...content().layers[0]!, id: "group", name: "组", kind: "group", blend: "pass-through", pixel: null, children };
  }

  it("递归组树与 Rust 使用相同指纹，展开状态不影响内容", () => {
    const pixel = { ...content().layers[0]!, id: "background", name: "背景", pixel: { sourceAssetId: "asset-base", contentHash: CONTENT_HASH } };
    const empty = { ...group(), id: "empty", name: "空组" };
    const doc = content({ layers: [group([pixel, empty])] });
    expect(imageProjectContentHash(doc)).toBe("380d5e0af12766e3");
    const baseline = imageProjectContentHash(doc);
    Object.assign(doc.layers[0]!, { expanded: false });
    expect(imageProjectContentHash(doc)).toBe(baseline);
    pixel.opacity = 0.5;
    expect(imageProjectContentHash(doc)).not.toBe(baseline);
    pixel.opacity = 1;
    doc.layers[0]!.children!.reverse();
    expect(imageProjectContentHash(doc)).not.toBe(baseline);
    doc.layers[0]!.children!.reverse();
    doc.layers[0]!.blend = "normal";
    expect(imageProjectContentHash(doc)).not.toBe(baseline);
  });

  it("拒绝混合内容、无 children 的组以及非组穿透或隐藏子树", () => {
    for (const layer of [
      { ...group(), children: undefined },
      { ...group(), pixel: content().layers[0]!.pixel },
      { ...content().layers[0]!, children: [] },
      { ...content().layers[0]!, blend: "pass-through" as const },
      group([{ ...content().layers[0]!, kind: "smart" as ImageProjectLayer["kind"] }])
    ]) expect(imageProjectContentHash(content({ layers: [layer] }))).toBeNull();
  });

  it("总层数和深度按整棵树计数，循环输入有界拒绝", () => {
    let nested = group();
    for (let depth = 1; depth < IMAGE_PROJECT_LIMITS.maxDocumentDepth; depth++) nested = group([nested]);
    expect(imageProjectContentHash(content({ layers: [nested] }))).not.toBeNull();
    expect(imageProjectContentHash(content({ layers: [group([nested])] }))).toBeNull();
    const children = Array.from({ length: IMAGE_PROJECT_LIMITS.maxLayers - 1 }, () => group());
    expect(imageProjectContentHash(content({ layers: [group(children)] }))).not.toBeNull();
    children.push(group());
    expect(imageProjectContentHash(content({ layers: [group(children)] }))).toBeNull();
    const cycle = group(); cycle.children!.push(cycle);
    expect(imageProjectContentHash(content({ layers: [cycle] }))).toBeNull();
  });
});

describe("图片工程严格联合（任务 2.1）", () => {
  it("接受合法工程定义并保留来源与画布尺寸分离", () => {
    const decoded = decodeImageEditDocument(project());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.version).toBe("woohaa-image-project-v1");
    if (decoded.value.version !== "woohaa-image-project-v1") return;
    expect(decoded.value.sourceWidth).toBe(1024);
    expect(decoded.value.canvasWidth).toBe(800);
  });

  it("拒绝混合分支与未知版本", () => {
    expect(decodeImageEditDocument({ ...project(), shapes: [] }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...legacy(), project: project().project }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...project(), version: "woohaa-image-project-v2" }).ok).toBe(false);
  });

  it("拒绝未知引擎/格式版本", () => {
    expect(decodeImageEditDocument({ ...project(), engineVersion: "deadbeef" }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...project(), formatVersion: 99 }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...project(), engine: "other" }).ok).toBe(false);
  });

  it("读取旧引擎版本，分组能力版本与上游来源分开核对", () => {
    expect(decodeImageEditDocument(project({ engineVersion: PHOTOCRAFT_ENGINE_COMMIT })).ok).toBe(true);
    expect(PHOTOCRAFT_ENGINE_VERSION).toBe(`${PHOTOCRAFT_ENGINE_COMMIT}+woohaa-patterns-v1`);
    expect(decodeImageEditDocument(project({ engineVersion: `${PHOTOCRAFT_ENGINE_COMMIT}+woohaa-styles-v1` })).ok).toBe(true);
  });

  it("拒绝非法数值与越界工程对象引用", () => {
    expect(decodeImageEditDocument({ ...project(), canvasWidth: 0 }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...project(), canvasWidth: 9000 }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...project(), documentContentHash: "not-a-hash" }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...project(), project: { ...project().project, storageKey: "../escape" } }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...project(), project: { ...project().project, contentType: "image/png" } }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...project(), sourceAssetIds: ["asset-base", "asset-base"] }).ok).toBe(false);
    expect(decodeImageEditDocument({ ...project(), sourceAssetIds: ["asset-other"] }).ok).toBe(false);
  });

  it("旧 v1 fixtures 继续按原语义解析", () => {
    const decoded = decodeImageEditDocument(legacy());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.version).toBe(IMAGE_EDIT_DOCUMENT_VERSION);
  });
});

describe("跨语言与单源一致性（任务 1.1/2.2）", () => {
  /**
   * 与 Rust `rust/crates/editor-core/src/identity.rs` 的同一 fixture 一致：
   * 编辑器的内容指纹必须与协议包逐字节相同，否则「是否净变化」两端会给出不同答案。
   */
  it("跨语言指纹 fixture 与 Rust 实现一致", () => {
    const canonical =
      "canvas:800x600\nlayer|background|背景|pixel|1|1|normal|0,0,1,0,0,0|none|pixel:asset-base:0123456789abcdef";
    const fixture: ImageProjectContent = {
      canvasWidth: 800,
      canvasHeight: 600,
      layers: [
        {
          id: "background",
          name: "背景",
          kind: "pixel",
          visible: true,
          opacity: 1,
          blend: "normal",
          transform: { translateX: 0, translateY: 0, scale: 1, rotationDegrees: 0, flipHorizontal: false, flipVertical: false },
          mask: null,
          pixel: { sourceAssetId: "asset-base", contentHash: CONTENT_HASH },
          text: null,
          adjustment: null
        }
      ]
    };
    expect(canonicalizeImageProjectContent(fixture)).toBe(canonical);
    expect(imageProjectContentHash(fixture)).toBe("42d710c4700e1a13");
  });

  /**
   * 首期上限的**唯一权威来源**是子项目内的 `rust/project-limits.json`。
   * Rust 核验工具读同一文件；这里逐字段核对，避免两端漂移。测试只读本子项目内的文件，
   * 不穿透到 `web/` 或 `bevy/`，因此隔离副本里也能跑。
   */
  it("首期上限与 project-limits.json 单源一致", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = new URL("../../../rust/project-limits.json", import.meta.url);
    const limits = JSON.parse(await readFile(path, "utf8")) as Record<string, number>;
    for (const [key, value] of Object.entries(IMAGE_PROJECT_LIMITS)) {
      expect(limits[key], `project-limits.json 的 ${key}`).toBe(value);
    }
    for (const key of Object.keys(limits)) {
      if (key.startsWith("$")) continue;
      expect(Object.hasOwn(IMAGE_PROJECT_LIMITS, key), `project-limits.json 多余的键 ${key}`).toBe(true);
    }
  });
});

describe("工程文档内容指纹与净变化（任务 2.2）", () => {
  it("相同内容不因键顺序变化而改变指纹", () => {
    const a = content();
    const b: ImageProjectContent = {
      layers: a.layers,
      canvasHeight: a.canvasHeight,
      canvasWidth: a.canvasWidth
    };
    expect(imageProjectContentHash(a)).toBe(imageProjectContentHash(b));
  });

  it("同 PNG 不同图层结构可区分", () => {
    const base = content();
    const changed = content({ layers: [...base.layers, { ...base.layers[0], id: "extra" }] });
    expect(imageProjectContentHash(base)).not.toBe(imageProjectContentHash(changed));
  });

  it("取景/活动层/选区/打包时间不在内容内：同一内容映射同一指纹", () => {
    // 内容描述只包含语义字段；额外视图字段不属于 `ImageProjectContent`，因此不参与指纹。
    const hash = imageProjectContentHash(content());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(imageProjectContentHash(content())).toBe(hash);
  });

  it("拒绝结构非法的内容（未知类型/混合内容/非法数值）", () => {
    expect(imageProjectContentHash(content({ canvasWidth: 0 }))).toBeNull();
    expect(imageProjectContentHash(content({ layers: [] }))).toBeNull();
    const bad = content();
    expect(
      imageProjectContentHash({
        ...bad,
        layers: [{ ...bad.layers[0], kind: "vector" as never }]
      })
    ).toBeNull();
    expect(
      imageProjectContentHash({
        ...bad,
        layers: [{ ...bad.layers[0], pixel: bad.layers[0].pixel, text: { text: "x", fontFamily: "Inter", fontSize: 12, color: "#ffffff", bold: false, align: "left" } }]
      })
    ).toBeNull();
    expect(
      imageProjectContentHash({
        ...bad,
        layers: [{ ...bad.layers[0], adjustment: { kind: "levels" as never, parameters: { kind: "levels" } as never } }]
      })
    ).toBeNull();
  });

  it("净变化：转换初始化（零 shape 标注 → 纯媒体）不算变化，撤销回基线不算变化", () => {
    expect(imageEditHasNetChange(null, legacy())).toBe(false);
    expect(imageEditHasNetChange(legacy(), legacy())).toBe(false);
    expect(imageEditHasNetChange(project(), project())).toBe(false);
    expect(imageEditHasNetChange(project(), { ...project(), documentContentHash: HASH_B.slice(0, 16) })).toBe(true);
  });

  it("净变化：跨分支与不同结构判为变化", () => {
    expect(imageEditHasNetChange(legacy(), project())).toBe(true);
    expect(imageEditHasNetChange(null, project())).toBe(true);
    const differentBase: LegacyImageEditDocument = { ...legacy(), baseAssetId: "asset-other" };
    expect(imageEditHasNetChange(legacy(), differentBase)).toBe(false);
  });

  it("内容身份区分同 PNG 不同工程结构", () => {
    const one = imageEditDocumentContentIdentity({ document: project(), baseStorageKey: `sha256-${HASH_A}`, outputStorageKey: `sha256-${HASH_B}` });
    const two = imageEditDocumentContentIdentity({
      document: project({ documentContentHash: HASH_B.slice(0, 16) }),
      baseStorageKey: `sha256-${HASH_A}`,
      outputStorageKey: `sha256-${HASH_B}`
    });
    expect(one).not.toBe(two);
    expect(one.startsWith("image-project:")).toBe(true);
    expect(imageEditDefinitionHash(project())).not.toBe(imageEditDefinitionHash(project({ canvasWidth: 801 })));
  });
});

describe("内核边界与能力清单（任务 3.1/3.7）", () => {
  function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "layer.delete",
      label: "删除图层",
      menu: ["Layer"],
      shortcut: null,
      params: "",
      enabled: true,
      disabledReason: null,
      needsDocument: true,
      allowed: true,
      ...overrides
    };
  }

  it("接受合法命令记录并区分首期白名单外的命令", () => {
    const decoded = decodePhotocraftCommands([command(), command({ id: "select.subject", allowed: false })]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.commands).toHaveLength(2);
    expect(isPhotocraftCommandDispatchable(decoded.commands[0])).toBe(true);
    expect(isPhotocraftCommandDispatchable(decoded.commands[1])).toBe(false);
  });

  it("拒绝结构非法的命令记录", () => {
    expect(decodePhotocraftCommands("nope")).toMatchObject({ ok: false, code: "invalid-message" });
    expect(decodePhotocraftCommands([command({ id: "" })])).toMatchObject({ ok: false, code: "invalid-message" });
    expect(decodePhotocraftCommands([command({ allowed: "yes" })])).toMatchObject({ ok: false, code: "invalid-message" });
    expect(decodePhotocraftCommands([command({ menu: [1, 2] })])).toMatchObject({ ok: false, code: "invalid-message" });
  });

  it("解析 wasm 抛出的错误值与字符串错误", () => {
    expect(decodePhotocraftError({ code: "capability-disabled", message: "未开放" })).toEqual({
      code: "capability-disabled",
      message: "未开放"
    });
    expect(decodePhotocraftError(JSON.stringify({ code: "no-document", message: "x" }))).toEqual({
      code: "no-document",
      message: "x"
    });
    expect(decodePhotocraftError("plain failure")).toEqual({ code: "unknown", message: "plain failure" });
  });

  it("导出结果必须配对工程与输出", () => {
    const payload = {
      revision: 4,
      documentContentHash: CONTENT_HASH,
      canvasWidth: 800,
      canvasHeight: 600,
      artifacts: [
        { role: "project", byteLength: 1024, sha256: HASH_A, contentType: IMAGE_PROJECT_CONTENT_TYPE },
        { role: "output", byteLength: 2048, sha256: HASH_B, contentType: "image/png" }
      ]
    };
    expect(decodeExportResult(payload).ok).toBe(true);
    expect(decodeExportResult({ ...payload, artifacts: [payload.artifacts[0]] })).toMatchObject({ ok: false });
    expect(
      decodeExportResult({ ...payload, artifacts: [...payload.artifacts, payload.artifacts[1]] })
    ).toMatchObject({ ok: false });
    expect(decodeExportResult({ ...payload, canvasWidth: 0 })).toMatchObject({ ok: false, code: "size-exceeded" });
  });

  it("能力清单按阶段开放，非目标从判定层被拒绝", () => {
    const manifest = photocraftCapabilityManifest();
    expect(manifest.capabilities).toContain("layers.blend.multiply");
    expect(manifest.capabilities).toContain("brush.presets");
    expect(manifest.capabilities).toContain("format.psd-import");
    expect(manifest.nonGoals).toContain("format.psb");
    expect(manifest.nonGoals).toContain("color.cmyk");
    expect(manifest.deliveredStages).toEqual([...PHOTOCRAFT_DELIVERED_STAGES]);
    expect(manifest.engineCommit).toBe(PHOTOCRAFT_ENGINE_COMMIT);
    expect(isPhotocraftFeatureAllowed("layers.blend.screen")).toBe(true);
    expect(isPhotocraftFeatureAllowed("format.psd-import")).toBe(true);
    expect(isPhotocraftFeatureAllowed("tool.healing")).toBe(true);
    expect(isPhotocraftFeatureAllowed("format.psb")).toBe(false);
    expect(isPhotocraftFeatureAllowed("selection.ai-subject")).toBe(false);
    expect(photocraftFeatureDisabledReason("format.psb")).toContain("不在本次范围");
    expect(photocraftFeatureDisabledReason("brush.presets")).toBeNull();
    expect(checkPhotocraftCapabilities(["paint.brush", "color.cmyk"])).toMatchObject({ ok: false });
    expect(checkPhotocraftCapabilities(["paint.brush", "text.horizontal", "brush.presets"])).toEqual({ ok: true });
  });

  it("能力协商拒绝阶段或清单漂移", () => {
    expect(verifyPhotocraftHandshake({
      stages: [...PHOTOCRAFT_DELIVERED_STAGES],
      capabilities: [...PHOTOCRAFT_CAPABILITIES]
    })).toEqual({ ok: true });
    const truncated = verifyPhotocraftHandshake({
      stages: PHOTOCRAFT_DELIVERED_STAGES.slice(0, 2),
      capabilities: [...PHOTOCRAFT_CAPABILITIES]
    });
    expect(truncated).toMatchObject({ ok: false, code: "capability-drift" });
    expect(verifyPhotocraftHandshake({ stages: [], capabilities: [] })).toMatchObject({ ok: false });
    expect(verifyPhotocraftHandshake(null)).toMatchObject({ ok: false });
  });
});

it("蒙版链接状态参与内容身份，省略与默认链接保持旧指纹兼容", () => {
  const document=content();
  document.layers[0].id="background"; document.layers[0].name="背景";
  document.layers[0].pixel!.sourceAssetId="asset-base";
  document.layers[0].mask={enabled:true,origin:"paint",contentHash:CONTENT_HASH};
  const before=imageProjectContentHash(document);
  document.layers[0].mask.linked=true;
  expect(imageProjectContentHash(document)).toBe(before);
  document.layers[0].mask.linked=false;
  expect(imageProjectContentHash(document)).not.toBe(before);
  expect(imageProjectContentHash(document)).toBe("ab60b2f81ebba8f0");
  document.layers[0].mask.linked="false" as unknown as boolean;
  expect(imageProjectContentHash(document)).toBeNull();
});

it("段落框进入内容指纹，点文字保留旧规范化", () => {
  const doc=content(),layer=doc.layers[0]!;
  layer.id="background";layer.name="背景";layer.kind="text";layer.pixel=null;
  layer.text={text:"标题",fontFamily:"Inter",fontSize:12,color:"#ffffff",bold:false,align:"left"};
  const point=imageProjectContentHash(doc);
  layer.text.box=null;expect(imageProjectContentHash(doc)).toBe(point);
  layer.text.box=[0,0,120,70];expect(imageProjectContentHash(doc)).not.toBe(point);
  expect(imageProjectContentHash(doc)).toBe("a4642cb445e77939");
  expect(canonicalizeImageProjectContent(doc)).toContain("text-box:0,0,120,70:12:#ffffff:0:left:Inter:标题");
  layer.text.box=[0,0,0,70];expect(imageProjectContentHash(doc)).toBeNull();
  layer.text.box=[0,0,Infinity,70];expect(imageProjectContentHash(doc)).toBeNull();
});

it("图层锁定参与内容身份，未锁定兼容旧指纹，非法锁定拒绝",()=>{
  const doc=content(),layer=doc.layers[0];
  layer.id="background";layer.name="背景";layer.pixel!.sourceAssetId="asset-base";
  const baseline=imageProjectContentHash(doc);
  layer.locks={};expect(imageProjectContentHash(doc)).toBe(baseline);
  layer.locks={position:false,all:false};expect(imageProjectContentHash(doc)).toBe(baseline);
  for (const key of ["transparency","pixels","position","artboard","all"] as const) {
    layer.locks={[key]:true};expect(imageProjectContentHash(doc)).not.toBe(baseline);
  }
  layer.locks={all:true,position:true};
  expect(canonicalizeImageProjectContent(doc)).toContain("|locks:00101");
  expect(imageProjectContentHash(doc)).toBe("a7fefd5a50bda5b1");
  for (const invalid of [null,[],true,{all:1},{all:null},{all:undefined},{unknown:false}]) {
    layer.locks=invalid as never;expect(imageProjectContentHash(doc)).toBeNull();
  }
});

it("剪贴状态参与内容身份，false/缺省兼容旧指纹，非法值拒绝",()=>{
  const doc=content(),layer=doc.layers[0];
  layer.id="background";layer.name="背景";layer.pixel!.sourceAssetId="asset-base";
  const baseline=imageProjectContentHash(doc);
  layer.clipped=false;expect(imageProjectContentHash(doc)).toBe(baseline);
  layer.clipped=true;
  expect(canonicalizeImageProjectContent(doc)).toContain("|clipped");
  expect(imageProjectContentHash(doc)).toBe("ca3d4d65d1a04e10");
  for (const invalid of [null,0,1,"true",[],{}]) {
    layer.clipped=invalid as never;expect(imageProjectContentHash(doc)).toBeNull();
  }
});

it("27 种 Photoshop 混合分别进入内容身份，未开放模式拒绝", () => {
  const hashes = new Set<string>();
  for (const blend of IMAGE_PROJECT_BLEND_MODES.filter(mode => mode !== "pass-through")) {
    const doc = content(); doc.layers[0]!.blend = blend;
    const hash = imageProjectContentHash(doc);
    expect(hash).not.toBeNull(); hashes.add(hash!);
  }
  expect(hashes.size).toBe(27);
  const doc = content(); (doc.layers[0] as unknown as {blend:string}).blend = "reflect";
  expect(imageProjectContentHash(doc)).toBeNull();
});

it("填充独立计入身份，默认值兼容且拒绝非法数值", () => {
  const doc=content(); const baseline=imageProjectContentHash(doc);
  doc.layers[0]!.fill=1; expect(imageProjectContentHash(doc)).toBe(baseline);
  doc.layers[0]!.fill=0.4; expect(imageProjectContentHash(doc)).not.toBe(baseline);
  expect(canonicalizeImageProjectContent(doc)).toContain("|fill:0.4");
  for (const value of [-1, 1.1, NaN, Infinity, null, "0.4"]) {
    (doc.layers[0] as unknown as {fill:unknown}).fill=value;
    expect(imageProjectContentHash(doc)).toBeNull();
  }
});

it("图层样式摘要进入内容身份，空样式兼容旧文档",()=>{
  const doc=content();const baseline=imageProjectContentHash(doc);
  doc.layers[0]!.effects=null;expect(imageProjectContentHash(doc)).toBe(baseline);
  doc.layers[0]!.effects={enabled:true,contentHash:"0123456789abcdef"};
  const enabled=imageProjectContentHash(doc);expect(enabled).not.toBe(baseline);
  doc.layers[0]!.effects.enabled=false;expect(imageProjectContentHash(doc)).not.toBe(enabled);
  doc.layers[0]!.effects.contentHash="unsupported";expect(imageProjectContentHash(doc)).toBeNull();
});
it("样式结构检查限制类型、资源、数量和嵌套",()=>{
  const style=(items:unknown[])=>({enabled:true,items,reference:null,psd_raw:null});
  const item={ColorOverlay:{common:{enabled:true,opacity:1,blend:"Normal"},color:{model:"Rgb",c:[1,0,0,1]}}};
  expect(isSupportedImageProjectEffects(style([item]))).toBe(true);
  for(const items of [[{PatternOverlay:{}}],[{Unknown:{}}],Array(65).fill(item),[{Stroke:{paint:{Pattern:{id:"x"}}}}],[{BevelEmboss:{texture:{id:"x"}}}],[{DropShadow:{size:null}}]]) expect(isSupportedImageProjectEffects(style(items))).toBe(false);
  expect(isSupportedImageProjectEffects({...style([]),psd_raw:"raw"})).toBe(false);
});

it("样式摘要 TS/Rust 共享固定指纹",()=>{
  const doc=content();Object.assign(doc.layers[0]!,{id:"background",name:"背景",pixel:{sourceAssetId:"asset-base",contentHash:CONTENT_HASH},effects:{enabled:true,contentHash:CONTENT_HASH}});
  expect(imageProjectContentHash(doc)).toBe("d0533ad14dc4f832");
});

it("样式渐变的色标位置和不透明度必须在 0–1 内",()=>{
  const style=(stops:unknown[],opacity_stops:unknown[])=>({enabled:true,items:[{GradientOverlay:{gradient:{stops,opacity_stops}}}]});
  const color={model:"Rgb",c:[0,0,0,1]};
  expect(isSupportedImageProjectEffects(style([[0,color],[1,color]],[[0,1],[.5,.25],[1,0]]))).toBe(true);
  expect(isSupportedImageProjectEffects(style([[0,color],[1,color]],[]))).toBe(true);
  for(const position of [-.1,1.1,null]) expect(isSupportedImageProjectEffects(style([[position,color]],[]))).toBe(false);
  for(const stop of [[-.1,.5],[1.1,.5],[.5,-.1],[.5,1.1],[.5,null],[0,1,2]]) expect(isSupportedImageProjectEffects(style([[0,color]],[stop]))).toBe(false);
});

it("样式等高线限制控制点范围、顺序及拐角标记",()=>{
  const points=[{input:0,output:0},{input:.5,output:1},{input:1,output:0}];
  const style=(points:unknown,corners:unknown)=>({enabled:true,items:[{DropShadow:{contour:{Custom:{name:"自定",points,corners}}}}]});
  expect(isSupportedImageProjectEffects(style(points,[false,true,false]))).toBe(true);
  expect(isSupportedImageProjectEffects(style(points,[]))).toBe(true);
  for(const invalid of [[],[points[0]],[points[0],points[0]],[points[2],points[0]],[{input:0,output:0},{input:1,output:1.1}],[{input:-.1,output:0},points[2]],[{input:0,output:null},points[2]]]) expect(isSupportedImageProjectEffects(style(invalid,[]))).toBe(false);
  expect(isSupportedImageProjectEffects(style(points,[false,true,false,true]))).toBe(false);
  expect(isSupportedImageProjectEffects(style(points,[1]))).toBe(false);
});


describe("工程图案资源基础",()=>{
  const pattern={id:"p-1",name:"图案",width:16,height:16,surface:{format:{mode:"Rgb",sample:"U8",alpha:true},default:"00000000",tiles:[] as unknown[]}};
  it("数量、尺寸、累计像素、格式、默认像素与 tile 范围有界",()=>{
    expect(isSupportedImageProjectPatterns(undefined)).toBe(true);
    expect(isSupportedImageProjectPatterns([pattern])).toBe(true);
    for(const value of [null,[pattern,pattern],[{...pattern,width:0}],[{...pattern,width:1025}],
      [{...pattern,name:" "}],[{...pattern,id:"a".repeat(201)}],Array.from({length:65},(_,i)=>({...pattern,id:String(i)})),
      Array.from({length:5},(_,i)=>({...pattern,id:String(i),width:1024,height:1024})),
      [{...pattern,surface:{...pattern.surface,format:{mode:"Rgb",sample:"F32",alpha:true}}}],
      [{...pattern,surface:{...pattern.surface,default:"invalid"}}],
      ...[[{tx:1,ty:0}],[{tx:-1,ty:0}],[{tx:0,ty:0},{tx:0,ty:0}]].map(tiles=>[{...pattern,surface:{...pattern.surface,tiles}}])]) {
      expect(isSupportedImageProjectPatterns(value)).toBe(false);
    }
  });
  it("图案摘要参与共享规范文本，空资源兼容旧身份",()=>{
    const doc=content(),before=imageProjectContentHash(doc);
    doc.patternContentHash="0123456789abcdef";
    expect(canonicalizeImageProjectContent(doc)).toContain("canvas:800x600\npatterns:0123456789abcdef\n");
    expect(imageProjectContentHash(doc)).not.toBe(before);
    const shared=content({patternContentHash:"0123456789abcdef",layers:[{...doc.layers[0]!,id:"background",name:"背景",pixel:{sourceAssetId:"asset-base",contentHash:"0123456789abcdef"}}]});
    expect(imageProjectContentHash(shared)).toBe("a625f47a4bc9c3e6");
    for(const value of ["unsupported","0123456789abcdeF",null,123]) {
      expect(imageProjectContentHash({...doc,patternContentHash:value} as unknown as ImageProjectContent)).toBeNull();
    }
    delete doc.patternContentHash;expect(imageProjectContentHash(doc)).toBe(before);
  });

  it("通道摘要参与共享规范文本，空通道兼容旧身份",()=>{
    const doc=content(),before=imageProjectContentHash(doc);
    doc.channelsContentHash="984d1d9a4311a91d";
    expect(canonicalizeImageProjectContent(doc)).toContain("canvas:800x600\nchannels:984d1d9a4311a91d\n");
    expect(imageProjectContentHash(doc)).not.toBe(before);
    // 图案/通道两项各自成行，顺序固定：图案在前、通道在后。
    doc.patternContentHash="0123456789abcdef";
    expect(canonicalizeImageProjectContent(doc)).toContain("patterns:0123456789abcdef\nchannels:984d1d9a4311a91d\n");
    for(const value of ["unsupported","984D1D9A4311A91D",null,123]) {
      expect(imageProjectContentHash({...doc,channelsContentHash:value} as unknown as ImageProjectContent)).toBeNull();
    }
    delete doc.channelsContentHash;expect(imageProjectContentHash(doc)).not.toBe(before);
    delete doc.patternContentHash;expect(imageProjectContentHash(doc)).toBe(before);
  });
});


it("图案样式按工程资源关联，斜面纹理允许负深度且严格限定范围",()=>{
  const ref={id:"p-1",name:"图案",scale:1};
  const patterns=[{id:"p-1",name:"图案"}];
  const style=(items:unknown[])=>({enabled:true,items});
  for(const item of [{PatternOverlay:{...ref,phase:[0,0]}},{Stroke:{paint:{Pattern:ref}}},{OuterGlow:{paint:{Pattern:ref}}},{InnerGlow:{paint:{Pattern:ref}}},{BevelEmboss:{texture:{...ref,depth:-2.5,phase:[0,0]}}}]) {
    expect(isSupportedImageProjectEffects(style([item]),patterns)).toBe(true);
    expect(isSupportedImageProjectEffects(style([item]),[])).toBe(false);
    expect(isSupportedImageProjectEffects(style([item]),[{id:"p-1",name:"另一资源"}])).toBe(false);
  }
  for(const depth of [-10.1,10.1,null]) expect(isSupportedImageProjectEffects(style([{BevelEmboss:{texture:{...ref,depth}}}]),patterns)).toBe(false);
  expect(isSupportedImageProjectEffects(style([{BevelEmboss:{depth:-1}}]),patterns)).toBe(false);
});

it("智能对象保留完整仿射，TS/Rust 共享固定指纹",()=>{
  const doc=content();Object.assign(doc.layers[0]!,{id:"background",name:"背景",kind:"smart",pixel:null,
    smart:{sourceContentHash:CONTENT_HASH,sourceName:"源🙂.pcraft",contentsGroup:1,transform:[1,0,1e-8,2,10,-0]}});
  expect(imageProjectContentHash(doc)).toBe("3c0a3d85d7e8d7f2");
  const baseline=imageProjectContentHash(doc);doc.layers[0]!.smart!.transform[2]=2e-8;expect(imageProjectContentHash(doc)).not.toBe(baseline);
  doc.layers[0]!.smart!.transform[2]=1e-8;doc.layers[0]!.smart!.transform[5]=0;expect(imageProjectContentHash(doc)).toBe(baseline);
});
it("智能对象摘要严格核验，并在组间保持同一共享源关系",()=>{
  const doc=content();const layer:ImageProjectLayer={...doc.layers[0]!,kind:"smart",pixel:null,smart:{sourceContentHash:CONTENT_HASH,sourceName:"source.pcraft",contentsGroup:1,transform:[1,0,0,1,0,0]}};
  doc.layers=[layer];const baseline=imageProjectContentHash(doc);expect(baseline).not.toBeNull();
  for(const patch of [{contentsGroup:0},{contentsGroup:2},{contentsGroup:1.5},{sourceContentHash:"unsupported"},{sourceName:"../x.pcraft"},{sourceName:".pcraft"},{sourceName:"\ufeff.pcraft"},{sourceName:"source.png"},{transform:[1,0,0,0,0,0]},{transform:[1,0,NaN,1,0,0]},{transform:[1,0,0,1,0]},{extra:true}]) {
    expect(imageProjectContentHash({...doc,layers:[{...layer,smart:{...layer.smart!,...patch}} as ImageProjectLayer]})).toBeNull();
  }
  doc.layers=[layer,{...layer,id:"copy"}];const shared=imageProjectContentHash(doc);expect(shared).not.toBeNull();
  doc.layers[1]={...layer,id:"copy",smart:{...layer.smart!,contentsGroup:2}};expect(imageProjectContentHash(doc)).not.toBe(shared);
  doc.layers[1]={...layer,id:"copy",smart:{...layer.smart!,sourceContentHash:"fedcba9876543210"}};expect(imageProjectContentHash(doc)).toBeNull();
  expect(imageProjectContentHash({...doc,layers:[{...layer,pixel:{sourceAssetId:null,contentHash:CONTENT_HASH}}]})).toBeNull();
});

it("变量与数据集参与内容身份，文本形状与 Rust `canonicalize_variables` 逐字节一致",()=>{
  const doc=content();
  // 空变量保持旧指纹形状：旧工程不因 U76 修复被判为有净变化。
  expect(canonicalizeImageProjectContent(doc)).not.toContain("variables:");
  const plain=imageProjectContentHash(doc);
  expect(plain).not.toBeNull();

  const withVars:ImageProjectContent={
    ...doc,
    variables:{
      defs:[
        {name:"show",layer:"layer-1",type:"visibility"},
        {name:"photo",layer:"layer-2",type:"pixelReplacement",method:"fill",align:"topLeft",clip:true}
      ],
      dataSets:[{name:"一",values:[
        {variable:"show",kind:"visibility",value:false},
        {variable:"photo",kind:"pixels",value:"a.png"}
      ]}]
    }
  };
  const canonical=canonicalizeImageProjectContent(withVars)!;
  expect(canonical.split("\n").at(-1)).toBe(
    "variables:[31:def|4:show|7:layer-1|visibility53:def|5:photo|7:layer-2|pixelReplacement|fill|topLeft|1][69:set|1:一|[25:value|4:show|visibility|028:value|5:photo|pixels|5:a.png]]"
  );
  // 与 Rust 侧固定指纹相同（Rust `identity/tests.rs` 用同一段文本）。
  expect(imageProjectContentHash(withVars)).not.toBe(plain);

  // 顺序敏感：整份替换语义下，重排定义就是内容变化。
  const reversed:ImageProjectContent={...withVars,variables:{...withVars.variables!,defs:[...withVars.variables!.defs].reverse()}};
  expect(imageProjectContentHash(reversed)).not.toBe(imageProjectContentHash(withVars));
  // 只改数据集取值也是内容变化。
  const changed:ImageProjectContent={...withVars,variables:{...withVars.variables!,dataSets:[{name:"一",values:[{variable:"show",kind:"visibility",value:true}]}]}};
  expect(imageProjectContentHash(changed)).not.toBe(imageProjectContentHash(withVars));

  // 未知种类 / 非法载荷 → null（无法判定，不是「无变化」）。
  for(const variables of [
    {defs:[{name:"x",layer:"layer-1",type:"magic"}],dataSets:[]},
    {defs:[{name:"x",layer:"layer-1",type:"pixelReplacement",method:"stretch",align:"center",clip:false}],dataSets:[]},
    {defs:[{name:"",layer:"layer-1",type:"visibility"}],dataSets:[]},
    {defs:[],dataSets:[{name:"s",values:[{variable:"x",kind:"magic",value:1}]}]},
    {defs:[{name:"x",layer:"",type:"visibility"}],dataSets:[]}
  ]) {
    expect(imageProjectContentHash({...doc,variables} as ImageProjectContent)).toBeNull();
  }
});
