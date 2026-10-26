import { PHOTOCRAFT_ENGINE_COMMIT, PHOTOCRAFT_ENGINE_VERSION, SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS } from "@woohaa3/photocraft-protocol";
// 只验证 JS/WASM 对象边界，不加载内核或执行绘制。
import { expect, it, vi } from "vitest";
import { EditorHandle, loadEditor, type EditorModuleFactory, type EditorExportBundle, type EditorInstance, type EditorPreview } from "./editor-wasm.js";

const buildInfo = { upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1 };

function loaderFixture(read: (() => string) | undefined) {
  const instance = { openProject: vi.fn(() => "opened") };
  const construct = vi.fn(function () { return instance; });
  const init = vi.fn(async () => undefined);
  const font = vi.fn();
  const module = { default: init, WasmEditor: Object.assign(construct, { buildInfoJson: read, registerFixedFont: font }) };
  const factory = vi.fn(async () => module) as unknown as EditorModuleFactory;
  return { construct, instance, init, font, factory };
}

const currentBuild = { ...buildInfo, upstreamCommit: PHOTOCRAFT_ENGINE_COMMIT };

it("匹配当前内核后才创建实例，旧工程字节仍交给当前内核读取", async () => {
  const read = vi.fn(() => JSON.stringify(currentBuild));
  const f = loaderFixture(read);
  const loaded = await loadEditor(f.factory);
  expect(loaded.ok).toBe(true);
  expect(f.init).toHaveBeenCalledOnce();
  expect(f.construct).toHaveBeenCalledOnce();
  expect(f.init.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
  expect(read.mock.invocationCallOrder[0]).toBeLessThan(f.construct.mock.invocationCallOrder[0]);
  if (!loaded.ok) throw new Error(loaded.message);
  expect(loaded.value.buildInfo).toEqual(currentBuild);
  const oldBytes = new Uint8Array([1, 2, 3]);
  expect(loaded.value.openProject(oldBytes, "base")).toEqual({ ok: true, value: "opened" });
  expect(f.instance.openProject).toHaveBeenCalledWith(oldBytes, "base");
});

it("旧或未知能力、来源不符和畸形信息在创建实例前明确拒绝", async () => {
  const invalid = [
    undefined, null, [], {}, { ...currentBuild, engineVersion: undefined },
    ...SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS.filter(v => v !== PHOTOCRAFT_ENGINE_VERSION).map(engineVersion => ({ ...currentBuild, engineVersion })),
    { ...currentBuild, engineVersion: `${PHOTOCRAFT_ENGINE_COMMIT}+future` },
    { ...currentBuild, upstreamCommit: "other" },
    { ...currentBuild, upstreamVersion: " " },
    ...[undefined, 0, 2, 1.5, "1"].map(formatVersion => ({ ...currentBuild, formatVersion }))
  ];
  for (const value of invalid) {
    const f = loaderFixture(() => value === undefined ? "{" : JSON.stringify(value));
    expect(await loadEditor(f.factory)).toEqual({ ok: false, code: "unsupported-engine-version", message: "图像编辑内核版本不匹配，请刷新页面后重试" });
    expect(f.construct).not.toHaveBeenCalled();
    expect(f.font).not.toHaveBeenCalled();
  }
  for (const read of [undefined, () => { throw new Error("old metadata ABI"); }]) {
    const f = loaderFixture(read);
    expect(await loadEditor(f.factory)).toMatchObject({ ok: false, code: "unsupported-engine-version" });
    expect(f.construct).not.toHaveBeenCalled();
  }
});

it("版本拒绝后可重试；模块初始化失败不创建实例", async () => {
  const read = vi.fn().mockReturnValueOnce("{}").mockReturnValueOnce(JSON.stringify(currentBuild));
  const f = loaderFixture(read);
  expect(await loadEditor(f.factory)).toMatchObject({ ok: false, code: "unsupported-engine-version" });
  expect(await loadEditor(f.factory)).toMatchObject({ ok: true });
  expect(f.construct).toHaveBeenCalledOnce();
  const broken = loaderFixture(() => JSON.stringify(currentBuild));
  broken.init.mockRejectedValueOnce(new Error("init failed"));
  expect(await loadEditor(broken.factory)).toMatchObject({ ok: false, code: "editor-load-failed" });
  expect(broken.construct).not.toHaveBeenCalled();
});

it("图案库字节及稳定管理身份直通，严格拒绝坏目录和超限输入",()=>{
  const state={presets:[{key:"source",id:"resource",name:"图案",width:16,height:16}],patternPresets:[{id:"resource",name:"图案",width:16,height:16}]};
  const response=vi.fn(()=>JSON.stringify(state)),read=vi.fn(()=>new Uint8Array([1,2]));
  const instance={patternLibrary:response,importPatternPresets:response,renamePatternPreset:response,deletePatternPreset:response,
    restorePatternLibrary:response,patternLibrarySnapshot:read,exportPatternPresets:read} as unknown as EditorInstance;
  const handle=new EditorHandle(instance,buildInfo),bytes=new Uint8Array([3,4]);
  expect(handle.patternLibrary()).toEqual({ok:true,value:state});
  expect(handle.importPatternPresets(bytes)).toEqual({ok:true,value:state});expect(response).toHaveBeenLastCalledWith(bytes);
  expect(handle.renamePatternPreset("source","新名").ok).toBe(true);expect(response).toHaveBeenLastCalledWith("source","新名");
  expect(handle.deletePatternPreset("source").ok).toBe(true);expect(response).toHaveBeenLastCalledWith("source");
  expect(handle.restorePatternLibrary(bytes).ok).toBe(true);expect(response).toHaveBeenLastCalledWith(bytes);
  expect(handle.patternLibrarySnapshot()).toEqual({ok:true,value:new Uint8Array([1,2])});
  expect(handle.exportPatternPresets("source").ok).toBe(true);expect(read).toHaveBeenLastCalledWith("source");
  for(const bad of [null,{}, {presets:[{...state.presets[0],key:""}]},{presets:[state.presets[0],state.presets[0]]},
    {presets:[{...state.presets[0],width:1025}]},{...state,patternPresets:[{...state.presets[0],height:NaN}]}]) {
    response.mockReturnValueOnce(JSON.stringify(bad));expect(handle.patternLibrary().ok).toBe(false);
  }
  response.mockClear();const oversized=new Uint8Array(32*1024*1024+1);
  expect(handle.importPatternPresets(oversized).ok).toBe(false);expect(handle.restorePatternLibrary(oversized).ok).toBe(false);expect(response).not.toHaveBeenCalled();
});

it("实际笔迹范围严格解码，空范围有效，不把坏数据当成无变化",()=>{
  const read=vi.fn(()=>JSON.stringify([{x:100,y:200,width:10,height:20}]));
  const handle=new EditorHandle({takeStrokeDamage:read} as unknown as EditorInstance,buildInfo);
  expect(handle.takeStrokeDamage()).toEqual({ok:true,value:[{x:100,y:200,width:10,height:20}]});
  read.mockReturnValueOnce("[]");expect(handle.takeStrokeDamage()).toEqual({ok:true,value:[]});
  for(const bad of [null,{},[{x:-1,y:0,width:1,height:1}],[{x:0,y:0,width:0,height:1}],[{x:.1,y:0,width:1,height:1}],[{x:32768,y:0,width:1,height:1}]]) {
    read.mockReturnValueOnce(JSON.stringify(bad));expect(handle.takeStrokeDamage()).toMatchObject({ok:false});
  }
});

it("源像素区域原样传递，读取后释放资源；坏数据不会发布",()=>{
  const data={width:2,height:1,pixels:new Uint8Array(8)},preview=resource(data);
  const read=vi.fn(()=>preview.value);
  const handle=new EditorHandle({renderRegion:read} as unknown as EditorInstance,buildInfo);
  expect(handle.renderRegion({x:7000,y:5000,width:2,height:1})).toEqual({ok:true,value:data});
  expect(read).toHaveBeenCalledWith(JSON.stringify({x:7000,y:5000,width:2,height:1}));
  expect(preview.free).toHaveBeenCalledOnce();
  for (const broken of [{...data,width:1},{...data,pixels:new Uint8Array(7)},{...data,pixels:[]}]) {
    const bad=resource(broken);read.mockReturnValueOnce(bad.value as typeof preview.value);
    expect(handle.renderRegion({x:0,y:0,width:2,height:1})).toMatchObject({ok:false});
    expect(bad.free).toHaveBeenCalledOnce();
  }
});

it("非法区域不调用 WASM，数值不会被截断成有效区域",()=>{
  const read=vi.fn();const handle=new EditorHandle({renderRegion:read} as unknown as EditorInstance,buildInfo);
  for (const patch of [{x:NaN},{y:Infinity},{x:-1},{x:.5},{width:0},{height:1025},{x:2147483647},{height:1.5}]) {
    expect(handle.renderRegion({x:0,y:0,width:1,height:1,...patch})).toMatchObject({ok:false,code:"render-failed"});
  }
  expect(read).not.toHaveBeenCalled();
});

it("曲线数值几何严格解码且不请求图片合成",()=>{
  const query=vi.fn(()=>JSON.stringify(Array.from({length:256},(_,i)=>i)));
  const handle=new EditorHandle({curveGeometry:query} as unknown as EditorInstance,buildInfo);
  const points:[number,number][]=[[0,0],[128,180],[255,255]];
  expect(handle.curveGeometry(points)).toMatchObject({ok:true,value:expect.arrayContaining([0,128,255])});
  expect(query).toHaveBeenCalledWith(JSON.stringify(points));
  for (const invalid of ["[]","null",JSON.stringify(Array(256).fill("1")),JSON.stringify(Array(256).fill(256))]) {
    query.mockReturnValueOnce(invalid);expect(handle.curveGeometry(points)).toMatchObject({ok:false});
  }
});

/** 模拟真实 wasm-bindgen：内容字段只有原型 getter，free 后不得再读。 */
function resource<T extends object>(data: T) {
  let freed = false;
  const getters = Object.fromEntries(Object.keys(data).map((key) => [key, {
    get() {
      if (freed) throw new Error("resource already freed");
      return data[key as keyof T];
    }
  }]));
  const free = vi.fn(() => { freed = true; });
  const value = Object.create(Object.defineProperties({}, getters)) as T & { free: () => void };
  Object.defineProperty(value, "free", { value: free });
  return { value, free };
}

it("预览读取原型 getter 后交付普通数据，展开成纹理时不丢字段，随后释放资源", () => {
  const data: EditorPreview = { width: 2, height: 1, pixels: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) };
  const preview = resource(data);
  // 这正是之前的错误：直接展开绑定实例，宽高与像素都消失。
  expect({ ...preview.value }).toEqual({});
  const instance = { renderPreview: () => preview.value } as unknown as EditorInstance;
  const result = new EditorHandle(instance, buildInfo).renderPreview(2048);
  expect(result).toEqual({ ok: true, value: data });
  if (!result.ok) throw new Error(result.message);
  expect({ nodeId: "image-1", ...result.value }).toEqual({ nodeId: "image-1", ...data });
  expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
  expect(preview.free).toHaveBeenCalledOnce();
  expect(() => preview.value.width).toThrow("resource already freed");
});

it("导出同样先读取完整产物再释放绑定对象，异步摘要无需保留 Rust 资源", () => {
  const data: EditorExportBundle = {
    revision: 3, documentContentHash: "0123456789abcdef", canvasWidth: 2, canvasHeight: 1,
    project: new Uint8Array([1, 2]), output: new Uint8Array([3, 4])
  };
  const bundle = resource(data);
  const instance = { exportBundle: () => bundle.value } as unknown as EditorInstance;
  expect(new EditorHandle(instance, buildInfo).exportBundle()).toEqual({ ok: true, value: data });
  expect(bundle.free).toHaveBeenCalledOnce();
});

it("读取预览失败仍释放资源，并返回失败结果", () => {
  const free = vi.fn();
  const preview = { width: 2, height: 1, get pixels(): Uint8Array { throw new Error("read failed"); }, free };
  const instance = { renderPreview: () => preview } as unknown as EditorInstance;
  expect(new EditorHandle(instance, buildInfo).renderPreview(2048)).toMatchObject({ ok: false });
  expect(free).toHaveBeenCalledOnce();
});

it("图层和蒙版缩略图使用有界读取并释放真实绑定形状的资源", () => {
  const data={width:2,height:1,pixels:new Uint8Array(8)},preview=resource(data);
  const read=vi.fn(()=>preview.value);
  const handle=new EditorHandle({layerThumbnail:read} as unknown as EditorInstance,buildInfo);
  expect(handle.layerThumbnail(7,true)).toEqual({ok:true,value:data});
  expect(read).toHaveBeenCalledWith(7,true,64); expect(preview.free).toHaveBeenCalledOnce();
});

it("文字几何传递 UTF-16 位置与文档命中坐标，拒绝非法内核结果", () => {
  const data = { caret: [[10, 20], [10, 40]], selection: [[[10, 20], [30, 20], [30, 40], [10, 40]]], hit: 3 };
  const query = vi.fn((_params: string) => JSON.stringify(data));
  const handle = new EditorHandle({ textGeometry: query } as unknown as EditorInstance, buildInfo);
  expect(handle.textGeometry({ start: 1, end: 3, hit: [20, 30] })).toEqual({ ok: true, value: data });
  expect(JSON.parse(query.mock.calls[0][0])).toEqual({ start: 1, end: 3, hit: [20, 30] });
  query.mockReturnValueOnce(JSON.stringify({...data,frame:[[0,0],[10,0],[10,20],[0,20]],next:1}));
  expect(handle.textGeometry({start:0,end:0,move:"lineNext"})).toMatchObject({ok:true,value:{next:1,frame:[[0,0],[10,0],[10,20],[0,20]]}});
  for (const invalid of [null, { ...data, hit: -1 }, { ...data, caret: [[10, 20]] }, { ...data, selection: [[[1, 2]]] }, {...data,next:-1}, {...data,frame:[[0,0]]}]) {
    query.mockReturnValueOnce(JSON.stringify(invalid));
    expect(handle.textGeometry({ start: 0, end: 0 })).toMatchObject({ ok: false });
  }
});

it("样式定位帧索引和响应严格核验，坏数据不交给拖动层",()=>{
  const read=vi.fn(()=>"[-16,4,240,100]"),handle=new EditorHandle({stylePositionFrame:read} as unknown as EditorInstance,buildInfo);
  expect(handle.stylePositionFrame(3)).toEqual({ok:true,value:[-16,4,240,100]});expect(read).toHaveBeenLastCalledWith(3);
  for(const bad of [null,{},[0,0,0,10],[0,0,10,0],[0,0,10,-1],[0,0,10,.5],[0,0,2**32,1],[0,0,10,1,2]]) {
    read.mockReturnValueOnce(JSON.stringify(bad));expect(handle.stylePositionFrame(0)).toMatchObject({ok:false});
  }
  read.mockClear();for(const index of [-1,.5,64,NaN,Infinity,2**32]) expect(handle.stylePositionFrame(index)).toMatchObject({ok:false});expect(read).not.toHaveBeenCalled();
});

it("非默认取色尺寸和来源只交给新接口，旧内核不能静默取错来源",()=>{
 const sample=vi.fn(()=>"#123456"),options=vi.fn((_params:string)=>"#abcdef");
 const handle=new EditorHandle({sampleColor:sample,sampleColorOptions:options} as unknown as EditorInstance,buildInfo);
 expect(handle.sampleColor(2,3,{size:11,sampleLayer:"current"})).toEqual({ok:true,value:"#abcdef"});expect(JSON.parse(options.mock.calls[0]![0]!)).toEqual({x:2,y:3,size:11,sampleLayer:"current"});expect(sample).not.toHaveBeenCalled();
 const legacy=new EditorHandle({sampleColor:sample} as unknown as EditorInstance,buildInfo);expect(legacy.sampleColor(2,3,{size:11,sampleLayer:"current"}).ok).toBe(false);expect(sample).not.toHaveBeenCalled();expect(legacy.sampleColor(2,3,{size:1,sampleLayer:"all"})).toEqual({ok:true,value:"#123456"});
});
it("字体样例读取在成功和畸形数据时均释放WASM资源，旧内核缺失方法不冒用浏览器字体",()=>{
 const free=vi.fn(),pixels=new Uint8Array(8),fontPreview=vi.fn(()=>({width:2,height:1,pixels,free}));
 const handle=new EditorHandle({fontPreview} as unknown as EditorInstance,buildInfo);
 expect(handle.fontPreview("Inter",18,1)).toEqual({ok:true,value:{width:2,height:1,pixels}});expect(free).toHaveBeenCalledOnce();
 fontPreview.mockReturnValue({width:1000,height:1,pixels,free});expect(handle.fontPreview("Inter",18,1).ok).toBe(false);expect(free).toHaveBeenCalledTimes(2);
 const old=new EditorHandle({} as EditorInstance,buildInfo);expect(old.fontPreview("Inter",18,1).ok).toBe(false);
});

it("性能偏好整数边界原子传递，旧WASM仅能保留默认内存；不先应用历史再失败",()=>{
  const set=vi.fn((historyStates:number,memoryUsageMb:number)=>JSON.stringify({historyStates,memoryUsageMb}));
  const handle=new EditorHandle({setPerformancePreferences:set} as unknown as EditorInstance,buildInfo);
  for(const [history,memory] of [[0,256],[1001,256],[1.5,256],[5,255],[5,256.5],[5,1048577],[5,NaN],[5,Infinity]])expect(handle.setPerformancePreferences(history,memory)).toMatchObject({ok:false});
  expect(set).not.toHaveBeenCalled();expect(handle.setPerformancePreferences(25,512)).toEqual({ok:true,value:{historyStates:25,memoryUsageMb:512}});expect(set).toHaveBeenCalledOnce();
  const history=vi.fn(()=>'{"historyStates":25}'),legacy=new EditorHandle({setHistoryLimit:history} as unknown as EditorInstance,buildInfo);
  expect(legacy.setPerformancePreferences(25,512)).toMatchObject({ok:false});expect(history).not.toHaveBeenCalled();
  expect(legacy.setPerformancePreferences(25,8192)).toEqual({ok:true,value:{historyStates:25}});expect(history).toHaveBeenCalledWith(25);
});

it("Info只读数据严格解码，NaN不被JSON转为无指针，畸形/缺失端口明确失败",()=>{
  const sample={rgb:[255,0,0],cmyk:[0,100,100,0],position:[4,5],selectionSize:null,documentSize:[16,12]},read=vi.fn((_params:string)=>JSON.stringify(sample));
  const handle=new EditorHandle({infoReadout:read} as unknown as EditorInstance,buildInfo);
  for(const params of [{x:NaN,y:NaN,size:1},{x:null,y:3,size:1},{x:1,y:2,size:2}])expect(handle.infoReadout(params)).toMatchObject({ok:false});expect(read).not.toHaveBeenCalled();
  expect(handle.infoReadout({x:4,y:5,size:1})).toEqual({ok:true,value:sample});expect(read).toHaveBeenLastCalledWith('{"x":4,"y":5,"size":1}');
  read.mockReturnValueOnce('{"rgb":[256,0,0]}');expect(handle.infoReadout({x:null,y:null,size:3})).toMatchObject({ok:false});
  expect(new EditorHandle({} as EditorInstance,buildInfo).infoReadout({x:null,y:null,size:1})).toMatchObject({ok:false});
});

it("pixel grid validates budget before raw WASM and strictly checks returned native geometry",()=>{
  const raw=vi.fn(()=>JSON.stringify([[0,0,0,1,255,255,255,64]]));
  const handle=new EditorHandle({pixelGrid:raw} as unknown as EditorInstance,buildInfo);
  expect(handle.pixelGrid({x:NaN,y:0,width:1,height:1})).toMatchObject({ok:false});expect(raw).not.toHaveBeenCalled();
  expect(handle.pixelGrid({x:0,y:0,width:1,height:1})).toEqual({ok:true,value:[[0,0,0,1,255,255,255,64]]});
  raw.mockReturnValueOnce(JSON.stringify([[0,0,2,0,0,0,0,64]]));expect(handle.pixelGrid({x:0,y:0,width:1,height:1})).toMatchObject({ok:false});
  expect(new EditorHandle({} as EditorInstance,buildInfo).pixelGrid({x:0,y:0,width:1,height:1})).toMatchObject({ok:false});
});

it("histogram requires the read-only native port and rejects malformed native responses",()=>{
  const raw=vi.fn(()=>'{"channels":[]}');
  expect(new EditorHandle({histogram:raw} as unknown as EditorInstance,buildInfo).histogram()).toMatchObject({ok:false});expect(raw).toHaveBeenCalledTimes(1);
  expect(new EditorHandle({} as EditorInstance,buildInfo).histogram()).toMatchObject({ok:false});
});

it("internal clipboard bounds are strict read-only geometry and support empty data",()=>{
 const raw=vi.fn(()=>"null"),handle=new EditorHandle({clipboardBounds:raw} as unknown as EditorInstance,buildInfo);
 expect(handle.clipboardBounds()).toEqual({ok:true,value:null});raw.mockReturnValueOnce("[1,2,4,6]");expect(handle.clipboardBounds()).toEqual({ok:true,value:[1,2,4,6]});for(const bad of ["[1,2,1,4]","[1.5,2,4,6]","{}"]) {raw.mockReturnValueOnce(bad);expect(handle.clipboardBounds()).toMatchObject({ok:false});}
});

it("命令 JSON 响应在 WASM 边界解码，面板不收到双重编码的字符串",()=>{
 const execute=vi.fn(()=>'{"presets":[{"name":"Hard Round"}]}');
 const handle=new EditorHandle({execute} as unknown as EditorInstance,buildInfo);
 expect(handle.execute("brush.presets.list",{full:false})).toEqual({ok:true,value:{presets:[{name:"Hard Round"}]}});
 expect(execute).toHaveBeenCalledWith("brush.presets.list",'{"full":false}');
 execute.mockReturnValueOnce('not JSON');expect(handle.execute("brush.presets.list")).toMatchObject({ok:false});
});
