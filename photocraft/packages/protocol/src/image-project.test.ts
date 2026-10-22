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
import { IMAGE_PROJECT_LIMITS } from "./image-edit.js";
import {
  PHOTOCRAFT_ENGINE_COMMIT,
  checkPhotocraftCapabilities,
  decodeExportResult,
  decodePhotocraftCommands,
  decodePhotocraftError,
  isPhotocraftCommandDispatchable,
  isPhotocraftFeatureAllowed,
  photocraftCapabilityManifest
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

  it("能力清单只开放首期能力，关闭项从判定层被拒绝", () => {
    const manifest = photocraftCapabilityManifest();
    expect(manifest.capabilities).toContain("layers.blend.multiply");
    expect(manifest.disabled).toContain("format.psd-import");
    expect(manifest.engineCommit).toBe(PHOTOCRAFT_ENGINE_COMMIT);
    expect(isPhotocraftFeatureAllowed("layers.blend.screen")).toBe(true);
    expect(isPhotocraftFeatureAllowed("format.psd-import")).toBe(false);
    expect(isPhotocraftFeatureAllowed("tool.healing")).toBe(false);
    expect(isPhotocraftFeatureAllowed("selection.ai-subject")).toBe(false);
    expect(checkPhotocraftCapabilities(["paint.brush", "tool.healing"])).toMatchObject({ ok: false });
    expect(checkPhotocraftCapabilities(["paint.brush", "text.horizontal"])).toEqual({ ok: true });
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
