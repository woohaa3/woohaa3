/**
 * 文字排版字段在**内容身份**里的一致性回归
 * （change: 2026-10-22-add-photocraft-typography-workflows，tasks 3.2 的域内可自动化部分）。
 *
 * 守住两件容易悄悄漂移的事：
 * 1. TS 身份摘要（本域 `packages/protocol/src/features/type/content.ts`）确实把行距/字距/
 *    基线/字偶距算进指纹——不是只写进工程却在判「有没有改动」时看不见；
 * 2. TS 侧摘要覆盖的字段集合与 Rust 侧（`document_content.rs` 的 text 分支）**一致**。
 *    两侧不同步会让同一份工程在宿主与内核得出不同的「是否改动」结论。
 *
 * 只读源码与纯函数，不启动 WASM、不读写工程。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// 直接指向协议**源码**，而不是已构建的 `dist`：本测试要守住的是「源码里的摘要实现」，
// 用包名导入会读到过期产物，改坏源码也照样通过。
import { imageProjectContentHash } from "../../../../protocol/src/features/shared/content.js";
import { canonicalizeText, type ImageProjectTextContent } from "../../../../protocol/src/features/type/content.js";

// 排版摘要的权威来源是本域 `features/type/content.rs`（共享 `document_content.rs` 只调用它）；
// 身份规范化在 `identity.rs`。两者一起构成内核侧的字段集合。
const RUST_CONTENT = new URL("../../../../../rust/crates/editor-core/src/features/type/content.rs", import.meta.url);
const RUST_IDENTITY = new URL("../../../../../rust/crates/editor-core/src/identity.rs", import.meta.url);
const TS_CONTENT = new URL("../../../../protocol/src/features/type/content.ts", import.meta.url);

/** 一份最小的文字层工程内容；只填身份需要的字段。 */
function project(text: Record<string, unknown>) {
  return {
    canvasWidth: 200,
    canvasHeight: 120,
    layers: [
      {
        id: "1",
        name: "文字",
        kind: "text",
        visible: true,
        opacity: 1,
        blend: "normal",
        transform: { translateX: 0, translateY: 0, scale: 1, rotationDegrees: 0, flipHorizontal: false, flipVertical: false },
        mask: null,
        pixel: null,
        adjustment: null,
        smart: null,
        shape: null,
        text: {
          text: "Type example",
          fontFamily: "Inter",
          fontSize: 32,
          color: "#000000",
          bold: false,
          align: "left",
          ...text
        }
      }
    ]
  } as never;
}

describe("文字排版字段进入内容身份", () => {
  it("默认排版是旧指纹的基线", () => {
    const base = imageProjectContentHash(project({}));
    expect(typeof base).toBe("string");
    expect(base!.length).toBe(16);
    // 显式写默认值不应改变身份，否则旧工程会被误判成已改动。
    expect(imageProjectContentHash(project({ tracking: 0, baselineShift: 0, kerning: "metrics" }))).toBe(base);
  });

  it("行距/字距/基线/字偶距各自改变内容身份", () => {
    const base = imageProjectContentHash(project({}));
    for (const patch of [{ leading: 36 }, { tracking: 50 }, { baselineShift: 3 }, { kerning: "optical" }, { kerning: "off" }]) {
      expect(imageProjectContentHash(project(patch)), JSON.stringify(patch)).not.toBe(base);
    }
  });

  it("正文以外的排版变化不会被忽略：改字距必然换指纹", () => {
    const a = imageProjectContentHash(project({ tracking: 10 }));
    const b = imageProjectContentHash(project({ tracking: 20 }));
    expect(a).not.toBe(b);
  });

  it("越界排版值被拒绝而不是折叠成同一个指纹", () => {
    // 超范围必须返回 null（工程不合法），不能静默截断后与合法工程撞指纹。
    expect(imageProjectContentHash(project({ tracking: 100_000 }))).toBeNull();
    expect(imageProjectContentHash(project({ leading: -1 }))).toBeNull();
    expect(imageProjectContentHash(project({ baselineShift: 99_999 }))).toBeNull();
    expect(imageProjectContentHash(project({ kerning: "bogus" }))).toBeNull();
  });

  /**
   * 直接钉住摘要实现本身：四个排版字段都必须出现在输出文本里。
   * 这一条不经过指纹聚合，所以「字段被从摘要里删掉」会立刻失败（而不是靠哈希碰撞才发现）。
   */
  it("摘要文本逐字包含四个排版字段", () => {
    const base = canonicalizeText({
      text: "Type example",
      fontFamily: "Inter",
      fontSize: 32,
      color: "#000000",
      bold: false,
      align: "left"
    } as ImageProjectTextContent);
    expect(base).not.toBeNull();
    expect(base).not.toContain("leading");
    const styled = canonicalizeText({
      text: "Type example",
      fontFamily: "Inter",
      fontSize: 32,
      color: "#000000",
      bold: false,
      align: "left",
      leading: 36,
      tracking: 50,
      baselineShift: 3,
      kerning: "optical"
    } as ImageProjectTextContent);
    expect(styled).toContain("leading:36");
    expect(styled).toContain("tracking:50");
    expect(styled).toContain("baseline:3");
    expect(styled).toContain("kerning:optical");
  });
});

describe("TS 与 Rust 的身份摘要覆盖同一组排版字段", () => {
  /**
   * 本域 `content.rs` 里写进文字层摘要的键（`object.insert("leading".into(), …)`）。
   *
   * 只认 `insert("键".into()` 这一种真实写法：把赋值改成注释或换个对象都能抓到。
   * 允许 `insert(` 与键之间换行（`warp`/`antialias` 为可读性分行写）。
   */
  function contentKeys(): Set<string> {
    const source = readFileSync(RUST_CONTENT, "utf8");
    return new Set(
      [...source.matchAll(/insert\(\s*"([A-Za-z]+)"\.into\(\)/g)].map((match) => match[1]!)
    );
  }

  /**
   * `identity.rs::canonicalize_text` 真正读取的内容键。
   *
   * 只认两种真实读法，避免用「字面量出现过」误判：
   * 1. `text.get("KEY")` —— 单键读取（`baselineShift`、`warp` 等）；
   * 2. 校验表里的元组首项 `("KEY", "label", ...)`（段落键与枚举键）。
   *
   * 若只看整个函数体的字符串字面量，把 `text.get("warp")` 改坏后标签
   * `format!("warp:...")` 仍会命中，断言就抓不到。
   */
  function identityKeys(): Set<string> {
    const source = readFileSync(RUST_IDENTITY, "utf8");
    const start = source.indexOf("fn canonicalize_text(");
    const end = source.indexOf("fn canonicalize_adjustment(", start);
    const body = source.slice(start, end);
    const gets = [...body.matchAll(/text\.get\("([A-Za-z0-9]+)"\)/g)].map((match) => match[1]!);
    const tuples = [...body.matchAll(/\("([A-Za-z0-9]+)", "(?:[A-Za-z0-9]+)"(?:,|\))/g)].map((match) => match[1]!);
    // 逐 run 摘要是 `(key, paragraph)` 形式，第二项是布尔而不是标签。
    const flagTuples = [...body.matchAll(/\("(charRuns|paragraphRuns)", (?:true|false)\)/g)].map((match) => match[1]!);
    return new Set([...gets, ...tuples, ...flagTuples]);
  }

  it("Rust 侧摘要含行距/字距/基线/字偶距", () => {
    const keys = contentKeys();
    for (const key of ["leading", "tracking", "baselineShift", "kerning"]) expect(keys, key).toContain(key);
  });

  /** 本 change 新增、必须两侧同时覆盖的排版字段。 */
  const TYPOGRAPHY_FIELDS = [
    "leading", "tracking", "baselineShift", "kerning", "kern",
    "firstLineIndent", "startIndent", "endIndent", "spaceBefore", "spaceAfter", "autoLeading",
    "paragraphAlign", "direction", "hyphenate", "styleSheet", "charStyleSheet", "antialias",
    "features", "warp", "weight", "horizontalScale", "verticalScale", "underline", "strikethrough",
    "italic", "fauxBold", "fauxItalic", "caps", "ligatures", "discretionaryLigatures", "language",
    "fontVariations"
  ];

  /**
   * 逐 run 摘要必须两侧都在：它是唯一能让 `type.setStyle` 的 `range` 写入进指纹的通道。
   *
   * 单靠 `TYPOGRAPHY_FIELDS` 那一组「首 run 平铺字段」发现不了这个缺口——只改中间几个字符时
   * 首 run 不变，工程却不脏。
   */
  it("逐 run 摘要也在两侧链路上", () => {
    const inContent = contentKeys();
    const inIdentity = identityKeys();
    for (const key of ["charRuns", "paragraphRuns"]) {
      expect(inContent, key).toContain(key);
      expect(inIdentity, key).toContain(key);
    }
    const tsSource = readFileSync(TS_CONTENT, "utf8");
    for (const key of ["charRuns", "paragraphRuns"]) {
      expect(new RegExp(`\\b${key}\\??:`).test(tsSource), key).toBe(true);
    }
  });

  /**
   * 逐 run 摘要的**字段名**也必须两侧同集合。
   *
   * 这是本轮实测发现的缺口类型：`fauxBold`/`fauxItalic` 原先只在平铺键里，整层写入能判脏，
   * 但 `type.setStyle` 带 `range` 只改中间几个字符时，上游真的改变了字形（PNG 字节变化）
   * 而指纹不动。只查「有没有 charRuns 这个容器」发现不了——必须逐个字段对账。
   */
  it("逐 run 摘要的字段名两侧同集合", () => {
    const rustIdentity = readFileSync(RUST_IDENTITY, "utf8");
    const rustChar = [...rustIdentity.matchAll(/let char_keys = \[([\s\S]*?)\];/g)][0]?.[1] ?? "";
    const rustParagraph = [...rustIdentity.matchAll(/let paragraph_keys = \[([\s\S]*?)\];/g)][0]?.[1] ?? "";
    const listed = (source: string) => new Set([...source.matchAll(/"([A-Za-z0-9]+)"/g)].map((match) => match[1]!));

    const tsSource = readFileSync(TS_CONTENT, "utf8");
    const tsChar = [...tsSource.matchAll(/const CHAR_RUN_KEYS = \[([\s\S]*?)\];/g)][0]?.[1] ?? "";
    const tsParagraph = [...tsSource.matchAll(/const PARAGRAPH_RUN_KEYS = \[([\s\S]*?)\];/g)][0]?.[1] ?? "";

    const rustCharKeys = listed(rustChar);
    const tsCharKeys = listed(tsChar);
    expect([...rustCharKeys].sort()).toEqual([...tsCharKeys].sort());
    expect([...listed(rustParagraph)].sort()).toEqual([...listed(tsParagraph)].sort());
    // 逐 run 必须能表达所有会改变字形的字符属性，否则「范围级写入」又会漏判。
    for (const key of ["fauxBold", "fauxItalic", "underline", "strikethrough", "weight", "italic"]) {
      expect(rustCharKeys, key).toContain(key);
    }
  });

  /**
   * 三段必须同时成立，缺一段都会让「宿主认为变了、内核认为没变」（或反过来）：
   *
   * 1. 本域 `content.rs` 真的把值写进摘要（取值与默认值折叠）；
   * 2. `identity.rs` 真的消费并拼进规范文本（校验与序列化）；
   * 3. 宿主 `content.ts` 的字段声明与 `canonicalizeText` 都能表达同一个键。
   *
   * 只查「两处并集」不够：那样删掉 `content.rs` 的一段赋值仍会被 `identity.rs` 掩盖。
   */
  it("三段链路都覆盖这些排版字段，没有漏接的一段", () => {
    const inContent = contentKeys();
    const inIdentity = identityKeys();
    const tsSource = readFileSync(TS_CONTENT, "utf8");
    const missingInContent = TYPOGRAPHY_FIELDS.filter((key) => !inContent.has(key));
    const missingInIdentity = TYPOGRAPHY_FIELDS.filter((key) => !inIdentity.has(key));
    const missingInTs = TYPOGRAPHY_FIELDS.filter((key) => !new RegExp(`\\b${key}\\??:`).test(tsSource));
    expect({ missingInContent, missingInIdentity, missingInTs }).toEqual({
      missingInContent: [],
      missingInIdentity: [],
      missingInTs: []
    });
  });

  /** 摘要文本逐项可辨：每个字段单独改一次都会换指纹，且不会互相冒充。 */
  it("每个排版字段单独改变指纹", () => {
    const base = imageProjectContentHash(project({}));
    const patches: Record<string, unknown>[] = [
      { leading: 36 }, { tracking: 50 }, { baselineShift: 3 }, { kerning: "optical" },
      { kern: 25 }, { firstLineIndent: 8 }, { startIndent: 4 }, { endIndent: 4 },
      { spaceBefore: 6 }, { spaceAfter: 6 }, { autoLeading: 1.5 },
      { paragraphAlign: "JustifyAll" }, { direction: "Rtl" }, { hyphenate: true },
      { styleSheet: 3 }, { charStyleSheet: 2 }, { antialias: "None" }, { features: ["frac=1"] },
      { weight: 700 }, { horizontalScale: 150 }, { verticalScale: 150 }, { underline: true },
      { strikethrough: true }, { italic: true }, { fauxBold: true }, { fauxItalic: true },
      { caps: "AllCaps" }, { ligatures: false }, { discretionaryLigatures: true },
      { language: "zh-Hans" }, { fontVariations: ["wght=650"] },
      { warp: { style: "warpArc", value: 20, horizontalDistortion: 0, verticalDistortion: 0, horizontal: true } }
    ];
    const seen = new Map<string, string>();
    for (const patch of patches) {
      const hash = imageProjectContentHash(project(patch));
      const name = Object.keys(patch)[0]!;
      expect(hash, name).not.toBeNull();
      expect(hash, name).not.toBe(base);
      // 两个不同字段不能撞同一个指纹。
      expect(seen.get(hash!), `${name} 与 ${seen.get(hash!)} 撞指纹`).toBeUndefined();
      seen.set(hash!, name);
    }
  });

  /** 越界值必须被拒绝，不能折叠成和合法工程相同的指纹。 */
  it("越界的排版值返回 null", () => {
    for (const patch of [
      { firstLineIndent: 9_999 }, { autoLeading: 0 }, { styleSheet: 0 }, { charStyleSheet: 0 }, { antialias: "Bogus" },
      { caps: "Uppercase" }, { language: "zh Hans" }, { fontVariations: ["wght"] },
      { fontVariations: ["wght650=1"] }, { underline: "yes" },
      { direction: "Sideways" }, { features: ["frac"] }, { features: ["ab=1"] },
      { warp: { style: "bogus", value: 0, horizontalDistortion: 0, verticalDistortion: 0, horizontal: true } },
      { warp: { style: "warpArc", value: 5_000, horizontalDistortion: 0, verticalDistortion: 0, horizontal: true } }
    ]) {
      expect(imageProjectContentHash(project(patch)), JSON.stringify(patch)).toBeNull();
    }
  });

  /** 默认值不写后缀：旧工程的身份逐字节保持兼容。 */
  it("显式默认值不改变旧指纹", () => {
    const base = imageProjectContentHash(project({}));
    expect(imageProjectContentHash(project({
      tracking: 0, baselineShift: 0, kerning: "metrics", kern: 0,
      firstLineIndent: 0, startIndent: 0, endIndent: 0, spaceBefore: 0, spaceAfter: 0,
      hyphenate: false
    }))).toBe(base);
    // 自动行距是「写了就生效」的字段：默认 1.2 写出来与不写等价。
    expect(imageProjectContentHash(project({ autoLeading: 1.2 }))).toBe(base);
  });
});
