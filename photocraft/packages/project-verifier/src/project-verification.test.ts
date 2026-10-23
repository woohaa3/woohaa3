/**
 * PhotoCraft 工程核验回归（change: 2026-10-16-integrate-photocraft-image-editing，任务 2.3；
 * change: 2026-10-21-extract-photocraft-subproject，任务 3.1 —— 迁入子项目的 Node 核验包）。
 *
 * 覆盖：正常往返、ZIP/manifest/资源缺失、压缩炸弹、路径穿越、外链、未开放对象类型、
 * 层数/画布上限、样式与图案资源边界，以及嵌入 Smart 的外层结构前置检查。
 *
 * 用真实 ZIP 字节驱动核验，不做任何渲染或外部请求。ZIP/manifest 夹具由同包
 * `test-support/project-fixtures.ts` 提供，Media 的接收边界测试复用同一份。
 */
import { describe, expect, it } from "vitest";
import { IMAGE_PROJECT_ADJUSTMENT_KINDS, IMAGE_PROJECT_CONTENT_TYPE, IMAGE_PROJECT_LIMITS } from "@woohaa3/photocraft-protocol";
import {
  ProjectVerificationError,
  createNativeProjectVerifier,
  inspectEmbeddedPhotocraftProject,
  verifyPhotocraftProject,
  verifyPhotocraftProjectForIngest,
  type NativeProjectVerifier
} from "./index.js";
import { HASH_A, HASH_B, buildZip, manifest, projectBytes } from "./test-support/project-fixtures.js";
import { createFakeSpawn } from "./test-support/fake-spawn.js";
describe("工程核验（design D5）", () => {
  function group(children: Record<string, unknown>[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: "group", name: "组", blend: "passThrough", opacity: 1, visible: true,
      content: { kind: "group", expanded: true, children, ...extra } };
  }

  function verifyLayers(layers: Record<string, unknown>[]) {
    return verifyPhotocraftProject(projectBytes({ manifest: manifest({}, layers) }));
  }

  function expectLayerError(layers: Record<string, unknown>[], code: string) {
    expect(() => verifyLayers(layers)).toThrow(expect.objectContaining({ code }));
  }

  it("样式结构通过上传核验，资源缺失的图案和超量效果拒绝",()=>{
    const style=(items:unknown[])=>({enabled:true,items,psd_raw:null,reference:null});
    const layer=(effects:unknown)=>({effects,content:{kind:"raster",sources:[]}});
    expect(verifyLayers([layer(style([{ColorOverlay:{common:{enabled:true,opacity:1,blend:"Normal"},color:{model:"Rgb",c:[1,0,0,1]}}}]))]).layerCount).toBe(1);
    expectLayerError([layer(style([{PatternOverlay:{id:"unknown"}}]))],"unsupported-object");
    expectLayerError([layer(style(Array(65).fill({Stroke:{}})))],"unsupported-object");
    expectLayerError([layer({...style([]),psd_raw:"raw"})],"unsupported-object");
  });

  it("填充不透明度接受零和分数，拒绝非法上传参数", () => {
    for (const fill_opacity of [0, 0.4, 1]) expect(verifyLayers([{fill_opacity,content:{kind:"raster",sources:[]}}]).layerCount).toBe(1);
    for (const fill_opacity of [-1, 2, "0.4", null]) expectLayerError([{fill_opacity,content:{kind:"raster",sources:[]}}],"unsupported-object");
  });

  it("混合模式按工程枚举核验，穿透仅限组，拒绝 Paint.NET 模式", () => {
    for (const blend of ["Overlay", "ColorDodge", "Luminosity", "LinearDodge"]) {
      expect(verifyLayers([{blend, content:{kind:"raster", sources:[]}}]).layerCount).toBe(1);
    }
    for (const blend of ["Reflect", "PaintNetColorBurn", "PassThrough", 5]) {
      expectLayerError([{blend, content:{kind:"raster", sources:[]}}], "unsupported-object");
    }
    expect(verifyLayers([{...group(), blend:"PassThrough"}]).layerCount).toBe(1);
  });

  it("普通分组递归核验并统计全部层，空组不虚增深度", () => {
    const raster = { id: "pixel", content: { kind: "raster", sources: [{ kind: "embedded", blob: HASH_A }] } };
    const summary = verifyLayers([group([raster, group()])]);
    expect(summary.layerCount).toBe(3);
    expect(summary.depth).toBe(2);
    expect(summary.objectKinds).toEqual(["group", "raster"]);
  });

  it("分组不能隐藏未开放对象、外链、缺失资源或画板", () => {
    expectLayerError([group([{ content: { kind: "smart" } }])], "unsupported-object");
    expectLayerError([group([{ content: { kind: "raster", sources: [{ kind: "linked", path: "/tmp/a" }] } }])], "external-reference");
    expectLayerError([group([{ content: { kind: "raster", sources: [{ kind: "embedded", blob: HASH_B }] } }])], "missing-resource");
    expectLayerError([group([], { artboard: {} })], "unsupported-object");
    expectLayerError([group([], { children: null })], "invalid-manifest");
    expectLayerError([group([], { expanded: null })], "invalid-manifest");
  });

  it("分组总层数和深度遵守同一上限", () => {
    const children = Array.from({ length: IMAGE_PROJECT_LIMITS.maxLayers - 1 }, () => group());
    expect(verifyLayers([group(children)]).layerCount).toBe(IMAGE_PROJECT_LIMITS.maxLayers);
    expectLayerError([group([...children, group()])], "too-many-layers");
    let nested = group();
    for (let depth = 1; depth < IMAGE_PROJECT_LIMITS.maxDocumentDepth; depth++) nested = group([nested]);
    expect(verifyLayers([nested]).depth).toBe(IMAGE_PROJECT_LIMITS.maxDocumentDepth);
    expectLayerError([group([nested])], "too-deep");
  });

  it("接受合法工程并给出安全摘要", () => {
    const summary = verifyPhotocraftProject(projectBytes());
    expect(summary.formatVersion).toBe(1);
    expect(summary.canvasWidth).toBe(1024);
    expect(summary.canvasHeight).toBe(768);
    expect(summary.layerCount).toBe(1);
    expect(summary.objectKinds).toEqual(["raster"]);
  });

  it("接受受支持的文字层与已发布的调整层", () => {
    const summary = verifyPhotocraftProject(
      projectBytes({
        manifest: manifest({}, [
          { id: "bg", name: "BG", blend: "normal", opacity: 1, visible: true, content: { kind: "raster", sources: [{ kind: "embedded", blob: HASH_A }] } },
          { id: "t", name: "Title", blend: "normal", opacity: 1, visible: true, content: { kind: "text", text: "标题" } },
          // 真实性判据：形状必须是上游 serde 的输出（外部标记的变体，无参数类型是裸字符串），
          // 不是 `{kind: "…"}`——后者是 `image-project` 的内容投影，不是工程 manifest。
          { id: "a1", name: "B/C", blend: "multiply", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { BrightnessContrast: { brightness: 0.1, contrast: 0.0, legacy: false } } } },
          { id: "a2", name: "H/S", blend: "screen", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { HueSaturation: { hue: 10.0, saturation: 0.0, lightness: 0.0, colorize: false, ranges: [] } } } },
          { id: "a3", name: "Curves", blend: "normal", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { Curves: { master: [], per_channel: [[], [], []] } } } }
        ])
      })
    );
    expect(summary.layerCount).toBe(5);
    expect(summary.objectKinds).toEqual(["adjustment", "raster", "text"]);
  });

  it("接受全部 15 类已发布调整，拒绝范围外变体与非法结构", () => {
    const published: Array<[string, unknown]> = [
      ["BrightnessContrast", { brightness: 0.1, contrast: 0.0, legacy: false }],
      ["HueSaturation", { hue: 0.0, saturation: 0.0, lightness: 0.0, colorize: false, ranges: [] }],
      ["Curves", { master: [], per_channel: [[], [], []] }],
      ["Levels", { master: {} }],
      ["Vibrance", { vibrance: 0.1, saturation: 0.0 }],
      ["BlackWhite", { weights: [40, 60, 40, 60, 20, 80], tint: null }],
      ["Exposure", { exposure: 0.5, offset: 0.0, gamma: 1.0 }],
      ["ColorBalance", { shadows: [0, 0, 0], midtones: [0, 10, 0], highlights: [0, 0, 0], preserve_luminosity: true }],
      ["PhotoFilter", { color: [1, 0.5, 0], density: 0.25, preserve_luminosity: true }],
      ["ChannelMixer", { matrix: [[0.4, 0.4, 0.2, 0], [0, 1, 0, 0], [0, 0, 1, 0]], monochrome: false }],
      ["Posterize", { levels: 4 }],
      ["Threshold", { level: 0.5 }],
      ["GradientMap", { stops: [[0, [0, 0, 0]], [1, [1, 1, 1]]], reverse: false, dither: false }],
      ["SelectiveColor", { relative: true, adjustments: [] }]
    ];
    for (const [variant, payload] of published) {
      const summary = verifyLayers([
        { id: "a", name: variant, blend: "normal", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { [variant]: payload } } }
      ]);
      expect(summary.objectKinds).toEqual(["adjustment"]);
    }
    // 无参数类型序列化成裸字符串。
    expect(verifyLayers([
      { id: "a", name: "反相", blend: "normal", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: "Invert" } }
    ]).layerCount).toBe(1);
    // 范围外：LUT 变体必须拒绝（`adjust.lut` 是永久非目标）。
    expectLayerError([
      { id: "a", name: "LUT", blend: "normal", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { ColorLookup: { name: "x", lut: null, size: 2 } } } }
    ], "unsupported-object");
    // 上游无法求值的 PSD 块同样拒绝。
    expectLayerError([
      { id: "a", name: "块", blend: "normal", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { Unsupported: { psd_key: "grdm", raw: [1, 2, 3] } } } }
    ], "unsupported-object");
    // 结构非法：空对象、多键对象、非对象。
    expectLayerError([{ id: "a", content: { kind: "adjustment", adjustment: {} } }], "unsupported-object");
    expectLayerError([
      { id: "a", content: { kind: "adjustment", adjustment: { Exposure: {}, ColorLookup: {} } } }
    ], "invalid-manifest");
    expectLayerError([{ id: "a", content: { kind: "adjustment", adjustment: [1] } }], "unsupported-object");
  });

  it("核验器的接受集合与协议内容投影的 15 类逐项一致", () => {
    // 协议侧 `IMAGE_PROJECT_ADJUSTMENT_KINDS` 是内容投影的类型名（kebab-case）；工程 manifest
    // 用的是上游 serde 的变体名（PascalCase）。两边必须一一对应：协议新增类型而核验器漏放，
    // 会让「编辑器能存、Media 拒收」同时成立。
    expect(IMAGE_PROJECT_ADJUSTMENT_KINDS).toHaveLength(15);
    for (const kind of IMAGE_PROJECT_ADJUSTMENT_KINDS) {
      const variant = kind.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
      const summary = verifyLayers([
        { id: "a", name: kind, blend: "normal", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { [variant]: {} } } }
      ]);
      expect(summary.objectKinds, kind).toEqual(["adjustment"]);
    }
    // 范围外的 LUT 不在协议类型表里，也必须不在核验器白名单里。
    expect(() => verifyLayers([{ id: "a", content: { kind: "adjustment", adjustment: { ColorLookup: {} } } }]))
      .toThrow(expect.objectContaining({ code: "unsupported-object" }));
  });

  it("拒绝普通 ZIP 伪装工程", () => {
    const bytes = buildZip([{ name: "readme.txt", data: new TextEncoder().encode("hi") }]);
    expect(() => verifyPhotocraftProject(bytes)).toThrow(ProjectVerificationError);
    try {
      verifyPhotocraftProject(bytes);
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("missing-manifest");
    }
  });

  it("拒绝非 ZIP 字节", () => {
    try {
      verifyPhotocraftProject(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("not-a-zip");
    }
  });

  it("拒绝缺失必需资源", () => {
    const missing = manifest({}, [
      { id: "layer-1", name: "L", blend: "normal", opacity: 1, visible: true, content: { kind: "raster", sources: [{ kind: "embedded", blob: HASH_B }] } }
    ]);
    try {
      verifyPhotocraftProject(projectBytes({ manifest: missing }));
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("missing-resource");
    }
  });

  it("拒绝路径穿越条目", () => {
    try {
      verifyPhotocraftProject(projectBytes({ extra: [{ name: "../outside", data: Uint8Array.from([1]) }] }));
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("path-traversal");
    }
  });

  it("拒绝外部文件链接与矢量路径", () => {
    try {
      verifyPhotocraftProject(
        projectBytes({
          manifest: manifest({}, [
            { id: "l", name: "Smart", blend: "normal", opacity: 1, visible: true, content: { kind: "raster", sources: [{ kind: "linked", path: "/tmp/x.png" }] } }
          ])
        })
      );
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("external-reference");
    }
    try {
      verifyPhotocraftProject(
        projectBytes({ manifest: manifest({}, [{ id: "l", name: "V", blend: "normal", opacity: 1, visible: true, vector_mask: [{ x: 0 }], content: { kind: "raster" } }]) })
      );
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("unsupported-object");
    }
  });

  it("拒绝未开放对象类型与智能滤镜", () => {
    try {
      verifyPhotocraftProject(
        projectBytes({ manifest: manifest({}, [{ id: "l", name: "Smart", blend: "normal", opacity: 1, visible: true, content: { kind: "smart", smart_filters: [{ command: "x" }] } }]) })
      );
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("unsupported-object");
    }
    try {
      // `levels` 在本 change 已发布并接受；范围外的 LUT 变体必须仍被拒绝。
      verifyPhotocraftProject(
        projectBytes({ manifest: manifest({}, [{ id: "l", name: "A", blend: "normal", opacity: 1, visible: true,
          content: { kind: "adjustment", adjustment: { ColorLookup: { name: "Look.cube", lut: null, size: 2 } } } }]) })
      );
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("unsupported-object");
    }
  });

  it("拒绝过新格式版本与超限画布/层数", () => {
    try {
      verifyPhotocraftProject(projectBytes({ manifest: manifest({ format_version: 999 }) }));
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("unsupported-format-version");
    }
    try {
      verifyPhotocraftProject(projectBytes({ manifest: manifest({ document: { size: { width: 9000, height: 9000 } } }) }));
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("canvas-too-large");
    }
    const layers = Array.from({ length: IMAGE_PROJECT_LIMITS.maxLayers + 1 }, (_, index) => ({
      id: `l${index}`,
      name: `L${index}`,
      blend: "normal",
      opacity: 1,
      visible: true,
      content: { kind: "raster" }
    }));
    try {
      verifyPhotocraftProject(projectBytes({ manifest: manifest({}, layers) }));
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("too-many-layers");
    }
  });

  it("拒绝压缩炸弹：声明长度超限与解压后超限", () => {
    // 解压后 > 单条目上限：使用高度可压缩内容并声明巨大长度。
    const bomb = new Uint8Array(1024 * 1024);
    try {
      verifyPhotocraftProject(
        buildZip([
          { name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest())), deflate: true },
          { name: `blobs/${HASH_A}.zst`, data: bomb, deflate: true, declaredSize: IMAGE_PROJECT_LIMITS.maxEntryDecompressedBytes + 1 }
        ])
      );
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("entry-too-large");
    }
  });

  it("拒绝非法 manifest JSON 与缺失画布/图层", () => {
    try {
      verifyPhotocraftProject(projectBytes({ manifestRaw: "{not json" }));
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("invalid-manifest");
    }
    try {
      verifyPhotocraftProject(projectBytes({ manifest: manifest({ document: { size: { width: 0, height: 10 } } }) }));
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("invalid-manifest");
    }
    try {
      const emptyLayers = { ...manifest(), document: { ...(manifest().document as Record<string, unknown>), layers: [] } };
      verifyPhotocraftProject(projectBytes({ manifest: emptyLayers }));
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("invalid-manifest");
    }
  });

  it("拒绝超过部署压缩上限的工程", () => {
    try {
      verifyPhotocraftProject(projectBytes(), { maxBytes: 10 });
      throw new Error("应当拒绝");
    } catch (error) {
      expect((error as ProjectVerificationError).code).toBe("compressed-too-large");
    }
  });

  it("ingest 入口只接受工程 MIME", () => {
    expect(() => verifyPhotocraftProjectForIngest(projectBytes(), "application/zip")).toThrow(ProjectVerificationError);
    expect(verifyPhotocraftProjectForIngest(projectBytes(), IMAGE_PROJECT_CONTENT_TYPE).formatVersion).toBe(1);
  });
});

it("图案资源在上传结构阶段核验数量、尺寸、格式及稀疏坐标",()=>{
  const p={id:"pattern-1",name:"图案",width:16,height:16,surface:{format:{mode:"Rgb",sample:"U8",alpha:true},default:"00000000",tiles:[]}};
  const make=(patterns:unknown)=>{const m=manifest();(m.document as Record<string,unknown>).patterns=patterns;return projectBytes({manifest:m});};
  expect(verifyPhotocraftProject(make([p])).canvasWidth).toBe(1024);
  for(const patterns of [[{...p,width:1025}],[p,p],Array.from({length:65},(_,i)=>({...p,id:String(i)})),
    [{...p,surface:{...p.surface,format:{mode:"Cmyk",sample:"U8",alpha:true}}}],
    [{...p,surface:{...p.surface,tiles:[{tx:99,ty:0,hash:"missing-resource"}]}}]]) {
    try {verifyPhotocraftProject(make(patterns));expect.fail("应拒绝非法资源");}
    catch(error){expect(error).toBeInstanceOf(ProjectVerificationError);expect((error as ProjectVerificationError).code).toBe("unsupported-object");}
  }
});


it("图案叠加、填充和纹理只能引用同工程匹配的资源",()=>{
  const pattern={id:"p-1",name:"图案",width:16,height:16,surface:{format:{mode:"Rgb",sample:"U8",alpha:true},default:"00000000",tiles:[]}};
  const ref={id:pattern.id,name:pattern.name,scale:1};
  const items=[{PatternOverlay:{...ref,phase:[0,0]}},{Stroke:{paint:{Pattern:ref}}},{OuterGlow:{paint:{Pattern:ref}}},{InnerGlow:{paint:{Pattern:ref}}},{BevelEmboss:{texture:{...ref,depth:-3,phase:[1,-2]}}}];
  const make=(patterns:unknown[],styleItems:unknown[]=items)=>{const m=manifest();const doc=m.document as Record<string,unknown>;doc.patterns=patterns;doc.layers=[{effects:{enabled:true,items:styleItems},content:{kind:"raster",sources:[]}}];return projectBytes({manifest:m});};
  expect(verifyPhotocraftProject(make([pattern])).layerCount).toBe(1);
  for(const patterns of [[],[{...pattern,name:"不匹配"}],[{...pattern,id:"另一个"}]]) expect(()=>verifyPhotocraftProject(make(patterns))).toThrow(expect.objectContaining({code:"unsupported-object"}));
  expect(()=>verifyPhotocraftProject(make([pattern],[{BevelEmboss:{texture:{...ref,depth:-11}}}]))).toThrow(expect.objectContaining({code:"unsupported-object"}));
});


describe("嵌入 Smart 外层结构前置检查",()=>{
  const content={kind:"smart",contents_id:1,source:{kind:"embedded",file_name:"源🙂.pcraft",blob:HASH_A},transform:{m:[1,0,1e-8,1,0,0]},smart_filters:[],cache:null,psd_raw:null};
  const bytes=(change:Record<string,unknown>={})=>projectBytes({manifest:manifest({},[{id:"smart-1",name:"对象",blend:"normal",content:{...content,...change}}])});
  it("允许外层 Smart 描述，普通上传仍拒绝；不把假 blob 当作已核验源",()=>{
    expect(inspectEmbeddedPhotocraftProject(bytes()).objectKinds).toEqual(["smart"]);
    expect(()=>verifyPhotocraftProject(bytes())).toThrow(expect.objectContaining({code:"unsupported-object"}));
    expect(()=>inspectEmbeddedPhotocraftProject(bytes(),{maxBytes:10})).toThrow(expect.objectContaining({code:"compressed-too-large"}));
  });
  it("要求原生核验且校对摘要，进程失败和内容拒绝不退回外层检查",async()=>{
    const input=bytes(), summary=inspectEmbeddedPhotocraftProject(input);
    // 未配置原生工具：embedded-smart 必须失败，不能只靠外层结构检查就接收。
    const processOnly=createNativeProjectVerifier(null);
    try { await expect(processOnly.verifyEmbeddedForIngest(input,IMAGE_PROJECT_CONTENT_TYPE)).rejects.toMatchObject({code:"native-verifier-unavailable"}); }
    finally { processOnly.dispose(); }
    const instances: NativeProjectVerifier[]=[];
    const install=(payload:unknown)=>{
      // 每次安装新 payload 都用新实例 + 新的假 spawn，避免复用上一次的配置（迁移前是全局单例）。
      const fake=createFakeSpawn({output:JSON.stringify(payload)});
      const instance=createNativeProjectVerifier({binaryPath:"verifier",spawnImpl:fake.spawnImpl});
      instances.push(instance);
      return {instance,fake};
    };
    try {
      let installed=install({ok:true,summary});
      await expect(installed.instance.verifyEmbeddedForIngest(input,IMAGE_PROJECT_CONTENT_TYPE)).resolves.toEqual(summary);
      // 外层结构上限先行：maxBytes 更小时在起原生进程前就拒绝。
      await expect(installed.instance.verifyEmbeddedForIngest(input,IMAGE_PROJECT_CONTENT_TYPE,{maxBytes:10})).rejects.toMatchObject({code:"compressed-too-large"});
      // 原生摘要与结构不一致：拒绝，不退回外层结果。
      installed=install({ok:true,summary:{...summary,layerCount:999}});
      await expect(installed.instance.verifyEmbeddedForIngest(input,IMAGE_PROJECT_CONTENT_TYPE)).rejects.toMatchObject({code:"native-verifier-failed"});
      // 原生明确拒绝内容：原样上抛，不回退。
      installed=install({ok:false,code:"unsupported-object",message:"嵌套源不受支持"});
      await expect(installed.instance.verifyEmbeddedForIngest(input,IMAGE_PROJECT_CONTENT_TYPE)).rejects.toMatchObject({code:"unsupported-object"});
      // 原生进程不可用：embedded-smart 保持失败，不退回外层结构检查。
      installed=install({ok:true,summary});
      const missingFake=createFakeSpawn({failToSpawn:"spawn verifier ENOENT"});
      const missing=createNativeProjectVerifier({binaryPath:"missing",timeoutMs:100,spawnImpl:missingFake.spawnImpl});
      instances.push(missing);
      await expect(missing.verifyEmbeddedForIngest(input,IMAGE_PROJECT_CONTENT_TYPE)).rejects.toMatchObject({code:"native-verifier-unavailable"});
    } finally {for(const instance of instances) instance.dispose();}
  });
  it("拒绝外链、坏源名、资源缺失、滤镜和不可逆或溢出仿射",()=>{
    for(const change of [
      {source:{kind:"linked",path:"https://invalid/source.pcraft"}},
      {source:{...content.source,file_name:"../source.pcraft"}},
      {source:{...content.source,blob:"bad"}},
      {source:{...content.source,blob:"f".repeat(64)}},
      {smart_filters:[{command:"filter.anything"}]},{warp:{}},{perspective:[1,0,0,0,1,0,0,0,1]},
      {transform:{m:[1,0,0,0,0,0]}},{transform:{m:[1e308,0,0,1e308,0,0]}},
    ]) expect(()=>inspectEmbeddedPhotocraftProject(bytes(change))).toThrow(ProjectVerificationError);
  });
});

/**
 * 视频图层与时间轴（change: 2026-10-22-add-photocraft-animation-workflows）。
 *
 * 进程内核验是**未配置原生工具时的默认接收边界**。这里必须与原生
 * `project-verify::features::animation` 同口径：接受内嵌帧栈、拒绝超预算内容、把种类记为
 * `video-layer`。否则默认部署会拒绝自己保存的动画工程，而配置了原生工具的部署却能接收。
 */
describe("视频图层与时间轴的进程内核验",()=>{
  const surface=(tiles:[number,number][]=[[0,0]])=>({
    format:"RGBA8",
    default:"00000000",
    tiles:tiles.map(([tx,ty])=>({tx,ty,hash:HASH_A}))
  });
  const video=(change:Record<string,unknown>={})=>({
    frames:[surface(),surface([[1,0]])],
    original_frames:null,
    source:"Blank",
    fps:24,
    show_altered:true,
    ...change
  });
  const layer=(change:Record<string,unknown>={})=>({
    id:"v",name:"视频",blend:"normal",opacity:1,visible:true,
    content:{kind:"raster",sources:[{kind:"embedded",blob:HASH_A}]},
    video:video(),
    ...change
  });
  const bytes=(layers:Record<string,unknown>[],document:Record<string,unknown>={})=>{
    // `manifest()` 的 `overrides.document` 是**整体替换**，因此这里在生成后合并，保留 size 等字段。
    const built=manifest({},layers);
    built.document={...(built.document as Record<string,unknown>),...document};
    return projectBytes({manifest:built});
  };

  it("接受内嵌帧栈并把种类记为 video-layer，不再是外部引用",()=>{
    const summary=verifyPhotocraftProject(bytes([layer()]));
    expect(summary.objectKinds).toEqual(["video-layer"]);
    expect(summary.layerCount).toBe(1);
    // 混合工程：普通栅格层仍是 raster，视频层单独一类。
    const mixed=verifyPhotocraftProject(bytes([layer(),{id:"r",name:"底",blend:"normal",opacity:1,visible:true,
      content:{kind:"raster",sources:[{kind:"embedded",blob:HASH_A}]}}]));
    expect(mixed.objectKinds).toEqual(["raster","video-layer"]);
  });

  it("文件来源只是溯源信息，不因路径拒绝（像素已内嵌）",()=>{
    const summary=verifyPhotocraftProject(bytes([layer({video:video({source:{File:{path:"/tmp/clip.mp4"}}})})]));
    expect(summary.objectKinds).toEqual(["video-layer"]);
  });

  it("超帧数、超累计像素、非法帧率、原始帧数不一致都被拒绝",()=>{
    expectLayerError([layer({video:video({frames:[]})})],"unsupported-object");
    expectLayerError([layer({video:video({frames:Array.from({length:121},()=>surface())})})],"unsupported-object");
    expectLayerError([layer({video:video({fps:0})})],"unsupported-object");
    expectLayerError([layer({video:video({fps:Number.NaN})})],"unsupported-object");
    expectLayerError([layer({video:video({fps:1001})})],"unsupported-object");
    expectLayerError([layer({video:video({original_frames:[surface()]})})],"unsupported-object");
    // 4096×4096 一帧 = 16,777,216 像素：两帧即超累计预算。
    const big=surface([[0,0],[15,15]]);
    expectLayerError([layer({video:video({frames:[big,big]})})],"unsupported-object");
  });

  it("tile 坐标与结构非法立即拒绝，不做无界算术",()=>{
    expectLayerError([layer({video:video({frames:[{format:"RGBA8",default:"00000000"}]})})],"invalid-manifest");
    expectLayerError([layer({video:video({frames:[surface([[1e9,0]])]})})],"unsupported-object");
    expectLayerError([layer({video:{frames:"nope"}})],"unsupported-object");
    expect(()=>verifyPhotocraftProject(bytes([layer({video:[]})]))).toThrow(expect.objectContaining({code:"invalid-manifest"}));
    // 真实保存的工程给**每个**图层写 `video: null`（上游 `LayerM.video` 无 skip_serializing_if），
    // 因此 null 必须等价于「没有视频层」，否则默认部署会拒绝所有普通工程。
    expect(verifyPhotocraftProject(bytes([layer({video:null})])).objectKinds).toEqual(["raster"]);
  });

  it("文档级时间轴时长/帧率/播放头/工作区越界被拒绝，旧工程无贡献",()=>{
    const timeline=(change:Record<string,unknown>={})=>({fps:24,duration:3,current:0,work_start:0,work_end:3,...change});
    expect(verifyPhotocraftProject(bytes([layer()],{timeline:timeline()})).layerCount).toBe(1);
    for(const change of [
      {duration:0},{duration:121},{fps:0},{fps:Number.NaN},{current:3},{current:-1},
      {work_start:2,work_end:1},{work_end:4}
    ]) expectLayerError([layer()],"unsupported-object",{timeline:timeline(change)});
    // 没有时间轴的旧工程同样通过（本域零贡献）。
    expect(verifyPhotocraftProject(bytes([layer()])).objectKinds).toEqual(["video-layer"]);
  });

  function expectLayerError(layers:Record<string,unknown>[],code:string,document:Record<string,unknown>={}):void{
    try{verifyPhotocraftProject(bytes(layers,document));throw new Error(`应当拒绝：${code}`);}
    catch(error){expect((error as ProjectVerificationError).code).toBe(code);}
  }
});
