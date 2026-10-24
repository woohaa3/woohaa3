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
import { IMAGE_PROJECT_CONTENT_TYPE, IMAGE_PROJECT_LIMITS } from "@woohaa3/photocraft-protocol";
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

  it("分辨率上传校验接受默认和范围端点，拒绝非法持久化值",()=>{
    const fixture=(resolution_dpi:unknown)=>{const value=manifest();(value.document as Record<string,unknown>).resolution_dpi=resolution_dpi;return projectBytes({manifest:value});};
    for(const resolution_dpi of [1,72,300.1,10000]) expect(verifyPhotocraftProject(fixture(resolution_dpi)).layerCount).toBe(1);
    for(const resolution_dpi of [0,-1,10001,"72",null]) expect(()=>verifyPhotocraftProject(fixture(resolution_dpi))).toThrow(expect.objectContaining({code:"unsupported-object"}));
  });

  it("蒙版属性接受默认值和范围端点，拒绝非法上传参数",()=>{
    for(const mask of [{},{density:0,feather:1000},{density:0.37,feather:4.25}]) expect(verifyLayers([{mask,content:{kind:"raster",sources:[]}}]).layerCount).toBe(1);
    for(const mask of [{density:1.1},{density:null},{feather:-1},{feather:1001},{feather:"2"},[]]) expectLayerError([{mask,content:{kind:"raster",sources:[]}}],"unsupported-object");
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

  it("接受受支持的文字层与三类调整层", () => {
    const summary = verifyPhotocraftProject(
      projectBytes({
        manifest: manifest({}, [
          { id: "bg", name: "BG", blend: "normal", opacity: 1, visible: true, content: { kind: "raster", sources: [{ kind: "embedded", blob: HASH_A }] } },
          { id: "t", name: "Title", blend: "normal", opacity: 1, visible: true, content: { kind: "text", text: "标题" } },
          { id: "a1", name: "B/C", blend: "multiply", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { kind: "brightnessContrast", brightness: 0.1 } } },
          { id: "a2", name: "H/S", blend: "screen", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { kind: "hueSaturation", hue: 10 } } },
          { id: "a3", name: "Curves", blend: "normal", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { kind: "curves" } } }
        ])
      })
    );
    expect(summary.layerCount).toBe(5);
    expect(summary.objectKinds).toEqual(["adjustment", "raster", "text"]);
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
      verifyPhotocraftProject(
        projectBytes({ manifest: manifest({}, [{ id: "l", name: "A", blend: "normal", opacity: 1, visible: true, content: { kind: "adjustment", adjustment: { kind: "levels" } } }]) })
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

it("颜色标签和链接元数据允许保存，非法标签、零/不安全链接编号拒绝",()=>{
  const make=(metadata:Record<string,unknown>)=>{const m=manifest();(m.document as Record<string,unknown>).layers=[{...metadata,content:{kind:"raster",sources:[]}}];return projectBytes({manifest:m});};
  expect(verifyPhotocraftProject(make({label:"Seafoam",link_group:17})).layerCount).toBe(1);
  for(const metadata of [{label:"unknown"},{label:null},{link_group:0},{link_group:-1},{link_group:1.5},{link_group:"1"},{link_group:Number.MAX_SAFE_INTEGER+1}]) expect(()=>verifyPhotocraftProject(make(metadata))).toThrow(expect.objectContaining({code:"unsupported-object"}));
});
