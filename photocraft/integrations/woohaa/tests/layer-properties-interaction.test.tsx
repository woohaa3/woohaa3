import { PHOTOCRAFT_ENGINE_VERSION } from "@woohaa3/contracts";
/** @vitest-environment jsdom */
// 真实 React、Controller 和绑定到接口替身；不合成图片或变换有效像素。
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {CONTOUR_LIBRARY_KEY,readContourLibrary} from "@woohaa3/photocraft-editor";
import * as patternStorage from "../../../packages/editor/src/pattern-preset-store.js";
import {PhotoEditorApp} from "@woohaa3/photocraft-editor";
import {EditorHandle,type EditorInstance,type UserPatternPreset} from "@woohaa3/photocraft-editor";
import {EditorWorkspaceController} from "../src/editor-workspace.js";
import {ProjectSession} from "../src/project-session.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,controller:EditorWorkspaceController;
afterEach(()=>{act(()=>root?.unmount());controller?.dispose();document.body.innerHTML="";vi.restoreAllMocks();vi.unstubAllGlobals();localStorage.clear();});
async function setup(property:"opacity"|"fill"|"style"="opacity",styleGradientFrame:unknown=[-13,7,200,80]) {
  const frames=new Map<number,FrameRequestCallback>();let frameId=0;
  vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{frames.set(++frameId,callback);return frameId;});
  vi.stubGlobal("cancelAnimationFrame",(id:number)=>frames.delete(id));
  let revision=1,opacity=1,fill=1,draft:number|null=null;
  let style={enabled:true,items:[] as Record<string,unknown>[]},draftStyle:typeof style|null=null;
  const contourPresets=[{name:"Linear",contour:"Linear"},{name:"Cone",contour:{Custom:{name:"锥形",points:[{input:0,output:0},{input:.5,output:1},{input:1,output:0}],corners:[false,true,false]}}},{name:"Invert",contour:{Custom:{name:"反相",points:[{input:0,output:1},{input:1,output:0}],corners:[false,false]}}}];
  const globalLight={angle:120,altitude:30};
  const defaults:Record<string,unknown>[]=[{DropShadow:{common:{enabled:true,blend:"Multiply",opacity:.75},color:{mode:"Rgb",c:[0,0,0,0],alpha:1},size:5,distance:5,angle:120,use_global_light:true,contour:"Linear",anti_alias:false}},
    {ColorOverlay:{common:{enabled:true,blend:"Normal",opacity:1},color:{mode:"Rgb",c:[1,0,0,0],alpha:1}}},
    {BevelEmboss:{enabled:true,style:"InnerBevel",technique:"Smooth",depth:1,up:true,size:5,soften:0,angle:120,altitude:30,use_global_light:true,gloss_contour:"Linear",contour:null,texture:null}},
    {Stroke:{common:{enabled:true,blend:"Normal",opacity:1},size:5,position:"Outside",paint:{Color:{mode:"Rgb",c:[0,0,0,0],alpha:1}}}},
    {GradientOverlay:{common:{enabled:true,blend:"Normal",opacity:1},gradient:{stops:[[0,{mode:"Rgb",c:[0,0,0,0],alpha:1}],[1,{mode:"Rgb",c:[1,1,1,0],alpha:1}]],opacity_stops:[],style:"Linear",angle:90,scale:1,reverse:false,align:true,offset:[0,0]},dither:false}}];
  defaults.push({InnerShadow:structuredClone((defaults[0] as {DropShadow:unknown}).DropShadow)});
  const patternPresets=[{id:"p-1",name:"图案一",width:16,height:16},{id:"p-2",name:"图案二",width:32,height:16}];
  defaults.push({PatternOverlay:{common:{enabled:true,blend:"Normal",opacity:1},id:"p-1",name:"图案一",scale:1,angle:0,link:true,phase:[0,0]}});
  for(const kind of ["OuterGlow","InnerGlow"]) defaults.push({[kind]:{common:{enabled:true,blend:"Screen",opacity:.75},paint:{Color:{mode:"Rgb",c:[1,1,1,0],alpha:1}},size:5,spread:0,contour:"Linear",anti_alias:false,range:.5,jitter:0,noise:0,technique:"Softer",source:"Edge"}});
  const stateJson=()=>JSON.stringify({document:{width:800,height:600,revision,activeLayer:1,canUndo:revision>1,history:revision>1?["修改图层属性"]:[],
    layers:[{id:1,name:"原图",kind:"raster",visible:true,opacity,fill,blend:"Normal"}]}});
  const begin=vi.fn(()=>{draft=property==="fill"?fill:opacity;draftStyle=structuredClone(style);return JSON.stringify({layer:1,opacity,fill,style,globalLight,styleDefaults:defaults,contourPresets,patternPresets,styleGradientFrame});});
  const preview=vi.fn((params:string)=>{
    const parsed=JSON.parse(params);
    if(property==="style") {
      if(!parsed.style || parsed.style.items.some((fx:Record<string,unknown>)=>{
        const body=Object.values(fx)[0] as {common?:{opacity:number};gradient?:{offset?:unknown[]};paint?:{Gradient?:{offset?:unknown[]}}};
        return body.common?.opacity===null || (body.gradient??body.paint?.Gradient)?.offset?.some(value=>value===null);
      })) throw JSON.stringify({code:"command-failed",message:"样式参数无效"});
      draftStyle=parsed.style;return JSON.stringify({layer:1,style:draftStyle,globalLight:parsed.globalLight});
    }
    const next=parsed[property];
    if (typeof next!=="number" || next<0 || next>1) throw JSON.stringify({code:"command-failed",message:"不透明度无效"});
    draft=next;return JSON.stringify({layer:1,opacity:draft});
  });
  const positionFrame=vi.fn((_index:number)=>"[-16,4,240,100]");
  const commit=vi.fn(()=>{if(property==="style") {if(JSON.stringify(style)!==JSON.stringify(draftStyle)) revision++;style=draftStyle!;draftStyle=null;draft=null;return "null";} if (draft!==(property==="fill"?fill:opacity)) revision++;if(property==="fill") fill=draft!;else opacity=draft!;draft=null;return "null";});
  const cancel=vi.fn(()=>{draft=null;});
  const execute=vi.fn(()=>"null");
  const importContours=vi.fn(()=>JSON.stringify([{name:"导入曲线",contour:{Custom:{name:"导入曲线",points:[{input:0,output:1},{input:1,output:0}],corners:[false,false]}}}]));
  const exportContour=vi.fn(()=>new Uint8Array([56,66,70,83,0,1]));
  let userPatterns:UserPatternPreset[]=[];
  const patternState=()=>JSON.stringify({presets:userPatterns,patternPresets});
  const importPatterns=vi.fn(()=>{
    userPatterns=[{key:"pat-source",id:"pat-1",name:"用户图案",width:8,height:8}];
    patternPresets.push(userPatterns[0]!);return patternState();
  });
  const renamePattern=vi.fn((key:string,name:string)=>{
    userPatterns=userPatterns.map(p=>p.key===key?{...p,id:"pat-2",name}:p);patternPresets.push(userPatterns[0]!);return patternState();
  });
  const deletePattern=vi.fn((key:string)=>{userPatterns=userPatterns.filter(p=>p.key!==key);return patternState();});
  const patternSnapshot=vi.fn(()=>new Uint8Array([1,2,3]));
  const restorePatterns=vi.fn(()=>{
    userPatterns=[{key:"stored-key",id:"stored-resource",name:"已保存图案",width:8,height:8}];
    patternPresets.push(userPatterns[0]!);return patternState();
  });
  const instance={openImage:stateJson,stateJson,commandsJson:()=>"[]",contentHash:()=>revision.toString(16).padStart(16,"0"),execute,
    patternLibrary:patternState,importPatternPresets:importPatterns,renamePatternPreset:renamePattern,deletePatternPreset:deletePattern,patternLibrarySnapshot:patternSnapshot,restorePatternLibrary:restorePatterns,
    stylePositionFrame:positionFrame,importContourPresets:importContours,exportContourPreset:exportContour,beginLayerProperties:begin,previewLayerProperties:preview,commitLayerProperties:commit,cancelLayerProperties:cancel,
    renderPreview:()=>({width:1,height:1,pixels:new Uint8Array([draft===null?revision:99,0,0,255])}),closeDocument:()=>"null"} as unknown as EditorInstance;
  const handle=new EditorHandle(instance,{upstreamCommit: "pinned", upstreamVersion: "0.9.0", engineVersion: PHOTOCRAFT_ENGINE_VERSION, formatVersion: 1});
  const session=new ProjectSession({nodeId:"image-1",baseAssetId:"asset-1",baseStorageKey:"image.png",sourceWidth:800,sourceHeight:600,edit:null});
  controller=new EditorWorkspaceController({session,sessionId:"session-1",baselineDocument:null,load:async()=>({ok:true,value:handle}),
    saveDeps:{uploadProject:async()=>null,uploadOutput:async()=>null,complete:async()=>({ok:false,code:"unused",error:"unused"}),assetIdFor:()=>"unused"}});
  await controller.openImage({name:"image",assetId:"asset-1",bytes:new Uint8Array()});session.establishBaseline();
  const container=document.createElement("div");document.body.append(container);root=createRoot(container);const onPreview=vi.fn();
  const render=(readonly=false)=>act(()=>root.render(<PhotoEditorApp controller={controller} readonly={readonly} canvasView={{viewport:{x:0,y:0,zoom:0.5},fitZoom:0.5,transitioning:false,onChange:vi.fn()}} onPreview={onPreview}/>));
  render();const input=container.querySelector<HTMLInputElement>(`[data-layer-${property}] input`)!;
  const type=(value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
  const key=(key:string,ctrlKey=false)=>act(()=>input.dispatchEvent(new KeyboardEvent("keydown",{key,ctrlKey,bubbles:true,cancelable:true})));
  const tick=()=>act(()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(callback=>callback(0));});
  return {container,input,type,key,tick,render,begin,preview,commit,cancel,execute,onPreview,importContours,exportContour,importPatterns,renamePattern,deletePattern,patternSnapshot,restorePatterns,positionFrame};
}
it("多次不透明度输入按帧预览，Enter 后只提交一步，草稿不误报净变化",async()=>{
  const {input,type,key,tick,preview,commit,onPreview,execute}=await setup();
  const before=controller.snapshot();act(()=>input.focus());type("80");type("45");tick();
  expect(JSON.parse(preview.mock.calls.at(-1)![0])).toEqual({opacity:0.45});
  expect(controller.snapshot()).toBe(before);expect(controller.isDirty()).toBe(false);
  expect(onPreview.mock.calls.at(-1)![0].pixels[0]).toBe(99);expect(input.disabled).toBe(false);
  type("35");key("Enter");expect(commit).toHaveBeenCalledOnce();expect(execute).not.toHaveBeenCalled();
  expect(controller.snapshot().view.document?.revision).toBe(2);expect(controller.isDirty()).toBe(true);
  expect(input.value).toBe("35");expect(controller.hasLayerProperties()).toBe(false);
});
it("空值及越界不能误交旧预览，修正可继续，Esc 与取消按钮不触发失焦提交",async()=>{
  const {container,input,type,key,tick,commit,cancel}=await setup();act(()=>input.focus());
  type("50");tick();type("");key("Enter");expect(input.value).toBe("");expect(commit).not.toHaveBeenCalled();
  expect(controller.hasLayerProperties()).toBe(true);type("150");key("Enter");expect(commit).not.toHaveBeenCalled();
  type("30");key("Escape");expect(input.value).toBe("100");expect(cancel).toHaveBeenCalledOnce();
  type("40");tick();
  const button=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消属性")!;
  act(()=>button.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,cancelable:true})));
  act(()=>input.blur());expect(commit).not.toHaveBeenCalled();expect(input.value).toBe("100");
  expect(cancel).toHaveBeenCalledTimes(2);
});
it("失败保留可重试输入，保存键受门禁，失焦与只读切换取消当前属性草稿",async()=>{
  const {container,input,type,key,tick,commit,cancel,render}=await setup();
  commit.mockImplementationOnce(()=>{throw JSON.stringify({code:"command-failed",message:"暂时无法提交"});});
  type("40");key("Enter");expect(controller.hasLayerProperties()).toBe(true);expect(input.value).toBe("40");
  act(()=>container.querySelector(".photo-editor")!.dispatchEvent(new KeyboardEvent("keydown",{key:"s",ctrlKey:true,bubbles:true,cancelable:true})));expect(container.textContent).toContain("请先确认或取消图层属性编辑");
  key("Enter");expect(controller.hasLayerProperties()).toBe(false);expect(controller.snapshot().view.document?.revision).toBe(2);
  type("20");tick();act(()=>window.dispatchEvent(new Event("blur")));expect(controller.hasLayerProperties()).toBe(false);expect(input.value).toBe("40");
  type("10");tick();render(true);expect(controller.hasLayerProperties()).toBe(false);expect(cancel).toHaveBeenCalledTimes(2);
});

it("填充使用同一草稿链，保持整体不透明度，支持提交与取消",async()=>{
  const {input,type,key,tick,preview,commit,cancel}=await setup("fill");
  type("25");tick();expect(JSON.parse(preview.mock.calls.at(-1)![0])).toEqual({fill:0.25});
  expect(controller.isDirty()).toBe(false);key("Enter");expect(commit).toHaveBeenCalledOnce();
  expect(controller.snapshot().view.document?.layers[0]).toMatchObject({fill:0.25,opacity:1});
  type("70");tick();key("Escape");expect(input.value).toBe("25");expect(cancel).toHaveBeenCalledOnce();
  expect(controller.snapshot().view.document?.layers[0].fill).toBe(0.25);
});

it("样式面板沿统一属性草稿链添加和编辑，确认一步、取消不改内容",async()=>{
  const {container,tick,preview,commit,cancel,onPreview}=await setup("style");
  const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  act(()=>button("图层样式…").click());
  act(()=>button("添加效果").click());tick();
  expect(controller.isDirty()).toBe(false);expect(controller.hasLayerProperties()).toBe(true);
  expect(JSON.parse(preview.mock.calls.at(-1)![0]).style.items[0]).toHaveProperty("DropShadow");
  act(()=>button("复制效果").click());tick();
  expect(JSON.parse(preview.mock.calls.at(-1)![0]).style.items).toHaveLength(2);
  expect(onPreview.mock.calls.at(-1)![0].pixels[0]).toBe(99);
  act(()=>button("确认样式").click());expect(commit).toHaveBeenCalledOnce();
  expect(controller.snapshot().view.document?.revision).toBe(2);expect(controller.isDirty()).toBe(true);
  act(()=>button("图层样式…").click());act(()=>button("删除效果").click());tick();
  act(()=>button("取消样式").click());expect(cancel).toHaveBeenCalledOnce();
  expect(controller.snapshot().view.document?.revision).toBe(2);
});

it("样式空值阻止确认，修正后可提交，Esc 和只读切换取消会话",async()=>{
  const {container,tick,commit,cancel,render}=await setup("style");
  const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>button("添加效果").click());tick();
  const input=container.querySelector<HTMLInputElement>("[data-layer-style] fieldset input[data-numeric-input]")!;
  const type=(value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
  type("");tick();act(()=>button("确认样式").click());expect(commit).not.toHaveBeenCalled();expect(controller.hasLayerProperties()).toBe(true);
  type("50");tick();act(()=>button("确认样式").click());expect(commit).toHaveBeenCalledOnce();
  act(()=>button("图层样式…").click());
  act(()=>container.querySelector("[data-layer-style]")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(cancel).toHaveBeenCalledOnce();expect(controller.hasLayerProperties()).toBe(false);
  act(()=>button("图层样式…").click());render(true);
  expect(cancel).toHaveBeenCalledTimes(2);expect(controller.hasLayerProperties()).toBe(false);
});

it("渐变色标增删、跨越排序和透明度编辑沿同一草稿确认与取消",async()=>{
  const {container,tick,preview,commit,cancel}=await setup("style");
  const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  const type=(input:HTMLInputElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
  const input=(label:string)=>[...container.querySelectorAll("label")].find(el=>el.textContent===label+"%")!.querySelector<HTMLInputElement>("input")!;
  const gradient=()=>JSON.parse(preview.mock.calls.at(-1)![0]).style.items[0].GradientOverlay.gradient;
  act(()=>button("图层样式…").click());
  const add=container.querySelector<HTMLSelectElement>('select[title="添加效果"]')!;
  act(()=>{add.value="GradientOverlay";add.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("添加效果").click());act(()=>button("添加颜色色标").click());tick();
  expect(gradient().stops.map((stop:unknown[])=>stop[0])).toEqual([0,.5,1]);
  expect(gradient().stops[1][1].c).toEqual([.5,.5,.5,0]);
  const moving=input("颜色色标 2 位置");act(()=>moving.focus());type(moving,"100");tick();
  expect(document.activeElement).toBe(moving);
  type(moving,"25");tick();expect(gradient().stops.map((stop:unknown[])=>stop[0])).toEqual([0,.25,1]);
  // 同一个输入跨越相邻色标后仍指向原色标。
  const first=input("颜色色标 1 位置");act(()=>first.focus());type(first,"75");tick();
  expect(document.activeElement).toBe(first);expect(gradient().stops.map((stop:unknown[])=>stop[0])).toEqual([.25,.75,1]);
  type(first,"50");tick();expect(gradient().stops.map((stop:unknown[])=>stop[0])).toEqual([.25,.5,1]);
  act(()=>button("删除颜色色标").click());tick();expect(gradient().stops).toHaveLength(2);
  expect(button("删除颜色色标").disabled).toBe(true);
  act(()=>button("添加透明度色标").click());tick();expect(gradient().opacity_stops).toEqual([[.5,1]]);
  type(input("色标 1 不透明度"),"30");tick();expect(gradient().opacity_stops).toEqual([[.5,.3]]);
  expect(controller.isDirty()).toBe(false);act(()=>button("确认样式").click());expect(commit).toHaveBeenCalledOnce();
  expect(controller.snapshot().view.document?.revision).toBe(2);
  act(()=>button("图层样式…").click());act(()=>button("删除透明度色标").click());tick();
  expect(gradient().opacity_stops).toEqual([]);expect(container.textContent).toContain("渐变完全不透明");
  act(()=>button("取消样式").click());expect(cancel).toHaveBeenCalledOnce();
  act(()=>button("图层样式…").click());expect(input("色标 1 不透明度").value).toBe("30");
});

it("描边颜色和渐变分别记忆，偏移与多实例重排仍使用正确效果",async()=>{
  const {container,tick,preview,commit}=await setup("style");
  const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  const select=(element:HTMLSelectElement,value:string)=>act(()=>{element.value=value;element.dispatchEvent(new Event("change",{bubbles:true}));});
  const input=(label:string)=>[...container.querySelectorAll("label")].find(el=>el.textContent===label+"%")!.querySelector<HTMLInputElement>("input")!;
  const type=(element:HTMLInputElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(element,value);element.dispatchEvent(new Event("input",{bubbles:true}));});
  const fill=()=>[...container.querySelectorAll("label")].find(el=>el.textContent?.startsWith("填充类型"))!.querySelector<HTMLSelectElement>("select")!;
  const paint=(index=0)=>JSON.parse(preview.mock.calls.at(-1)![0]).style.items[index].Stroke.paint;
  act(()=>button("图层样式…").click());
  select(container.querySelector('select[title="添加效果"]')!,"Stroke");act(()=>button("添加效果").click());
  const color=container.querySelector<HTMLInputElement>('[data-layer-style] input[type="color"]')!;type(color,"#ff0000");tick();
  expect(paint().Color).toMatchObject({mode:"Rgb",c:[1,0,0,0],alpha:1});
  select(fill(),"Gradient");type(input("水平偏移"),"");tick();
  act(()=>button("确认样式").click());expect(commit).not.toHaveBeenCalled();expect(controller.hasLayerProperties()).toBe(true);
  type(input("水平偏移"),"25");type(input("垂直偏移"),"-30");
  act(()=>button("添加透明度色标").click());type(input("色标 1 不透明度"),"40");tick();
  expect(paint().Gradient).toMatchObject({offset:[.25,-.3],opacity_stops:[[.5,.4]]});
  select(fill(),"Color");tick();expect(paint().Color.c).toEqual([1,0,0,0]);
  select(fill(),"Gradient");tick();expect(paint().Gradient.offset).toEqual([.25,-.3]);
  act(()=>button("添加效果").click());select(fill(),"Gradient");tick();expect(paint(1).Gradient.offset).toEqual([0,0]);
  select(container.querySelector('select[title="当前效果"]')!,"0");act(()=>button("下移").click());
  select(fill(),"Color");tick();expect(paint(1).Color.c).toEqual([1,0,0,0]);
  select(fill(),"Gradient");tick();expect(paint(1).Gradient.offset).toEqual([.25,-.3]);
  expect(controller.isDirty()).toBe(false);act(()=>button("确认样式").click());expect(commit).toHaveBeenCalledOnce();
  act(()=>button("图层样式…").click());select(container.querySelector('select[title="当前效果"]')!,"1");
  expect(input("水平偏移").value).toBe("25");expect(input("垂直偏移").value).toBe("-30");
});

it("投影等高线沿原样式会话确认和取消，控制点保留在生效样式",async()=>{
  const {container,tick,preview,commit,cancel}=await setup("style");
  const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>button("添加效果").click());
  const preset=container.querySelector<HTMLSelectElement>("[data-style-contour] select")!;
  act(()=>{preset.value="preset:1";preset.dispatchEvent(new Event("change",{bubbles:true}));});tick();
  const contour=JSON.parse(preview.mock.calls.at(-1)![0]).style.items[0].DropShadow.contour;
  expect(contour.Custom.points).toHaveLength(3);expect(contour.Custom.corners).toEqual([false,true,false]);
  expect(controller.isDirty()).toBe(false);act(()=>button("确认样式").click());expect(commit).toHaveBeenCalledOnce();
  act(()=>button("图层样式…").click());act(()=>button("添加控制点").click());tick();
  act(()=>button("取消样式").click());expect(cancel).toHaveBeenCalledOnce();
  act(()=>button("图层样式…").click());expect(container.querySelectorAll("[data-style-contour] circle")).toHaveLength(3);
});

it("斜面等高线启停保留会话内曲线，光泽等高线独立编辑",async()=>{
  const {container,tick,preview,commit}=await setup("style");
  const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  const select=(select:HTMLSelectElement,value:string)=>act(()=>{select.value=value;select.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("图层样式…").click());select(container.querySelector('select[title="添加效果"]')!,"BevelEmboss");act(()=>button("添加效果").click());
  const enabled=()=>[...container.querySelectorAll("label")].find(label=>label.textContent==="启用斜面等高线")!.querySelector<HTMLInputElement>("input")!;
  select(container.querySelector("[data-style-contour] select")!,"preset:2");
  act(()=>enabled().click());
  const contour=()=>[...container.querySelectorAll<HTMLElement>("[data-style-contour]")].find(el=>el.querySelector("legend")?.textContent==="等高线")!;
  select(contour().querySelector("select")!,"preset:1");tick();
  const bevel=()=>JSON.parse(preview.mock.calls.at(-1)![0]).style.items[0].BevelEmboss;
  expect(bevel().contour.contour.Custom.points).toHaveLength(3);expect(bevel().gloss_contour.Custom.name).toBe("反相");
  act(()=>enabled().click());tick();expect(bevel().contour).toBeNull();
  act(()=>enabled().click());tick();expect(bevel().contour.contour.Custom.name).toBe("锥形");
  act(()=>button("确认样式").click());expect(commit).toHaveBeenCalledOnce();
});

it("SHC 载入不修改草稿，原生文件对话框不取消样式，选择后才预览",async()=>{
  const {container,tick,preview,commit,cancel,importContours,exportContour}=await setup("style");
  const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>button("添加效果").click());tick();
  const before=preview.mock.calls.length;
  act(()=>button("载入等高线…").click());act(()=>window.dispatchEvent(new Event("blur")));
  expect(controller.hasLayerProperties()).toBe(true);expect(cancel).not.toHaveBeenCalled();
  const fileInput=container.querySelector<HTMLInputElement>("[data-contour-file]")!;
  const oversizedRead=vi.fn();Object.defineProperty(fileInput,"files",{configurable:true,value:[{size:1_048_577,arrayBuffer:oversizedRead}]});
  await act(async()=>{fileInput.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(oversizedRead).not.toHaveBeenCalled();expect(importContours).not.toHaveBeenCalled();expect(container.textContent).toContain("不能超过 1 MiB");
  act(()=>button("载入等高线…").click());
  Object.defineProperty(fileInput,"files",{configurable:true,value:[{size:8,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer}]});
  await act(async()=>{fileInput.dispatchEvent(new Event("change",{bubbles:true}));await Promise.resolve();});
  expect(importContours).toHaveBeenCalledOnce();expect(preview.mock.calls.length).toBe(before);expect(controller.isDirty()).toBe(false);
  const select=container.querySelector<HTMLSelectElement>("[data-style-contour] select")!;
  const option=[...select.options].find(option=>option.textContent==="导入曲线")!;
  act(()=>{select.value=option.value;select.dispatchEvent(new Event("change",{bubbles:true}));});tick();
  expect(JSON.parse(preview.mock.calls.at(-1)![0]).style.items[0].DropShadow.contour.Custom.name).toBe("导入曲线");
  const create=vi.fn(()=>"blob:contour"),revoke=vi.fn();vi.stubGlobal("URL",{createObjectURL:create,revokeObjectURL:revoke});
  const click=vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>{});
  act(()=>button("保存等高线…").click());expect(exportContour).toHaveBeenCalledOnce();expect(create).toHaveBeenCalledOnce();expect(click).toHaveBeenCalledOnce();
  act(()=>window.dispatchEvent(new Event("focus")));
  act(()=>button("确认样式").click());expect(commit).toHaveBeenCalledOnce();
});
it("取消文件选择恢复失焦取消，读取晚到不能写回已退出样式",async()=>{
  const {container,tick,cancel,importContours,render}=await setup("style");
  const button=(text:string)=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>button("添加效果").click());tick();
  act(()=>button("载入等高线…").click());act(()=>container.querySelector("[data-contour-file]")!.dispatchEvent(new Event("cancel")));
  act(()=>window.dispatchEvent(new Event("blur")));expect(cancel).toHaveBeenCalledOnce();
  act(()=>button("图层样式…").click());
  let resolve!:(bytes:ArrayBuffer)=>void;const pending=new Promise<ArrayBuffer>(done=>{resolve=done;});
  const input=container.querySelector<HTMLInputElement>("[data-contour-file]")!;Object.defineProperty(input,"files",{value:[{size:8,arrayBuffer:()=>pending}]});
  act(()=>input.dispatchEvent(new Event("change",{bubbles:true})));render(true);
  await act(async()=>{resolve(new ArrayBuffer(8));await pending;});expect(importContours).not.toHaveBeenCalled();
  render(false);act(()=>button("图层样式…").click());expect(button("载入等高线…").disabled).toBe(false);
});


it("预设库新建、改名、删除不预览图层，取消及重新挂载仍保留，选择才应用",async()=>{
  let ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  const typeName=(next:string)=>act(()=>{
    const input=ui.container.querySelector<HTMLInputElement>("[data-contour-library] input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,next);input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  const select=(selector:string,value:string)=>act(()=>{
    const el=ui.container.querySelector<HTMLSelectElement>(selector)!;el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));
  });
  act(()=>button("图层样式…").click());act(()=>button("添加效果").click());ui.tick();
  const before=ui.preview.mock.calls.length;
  typeName("我的线性");act(()=>button("将当前曲线新建为预设").click());ui.tick();
  expect(ui.preview.mock.calls.length).toBe(before);expect(controller.isDirty()).toBe(false);
  let entry=readContourLibrary()[0]!;expect(entry.name).toBe("我的线性");
  select("[data-contour-library] select",entry.id);typeName("改名曲线");act(()=>button("重命名预设").click());
  expect(readContourLibrary()[0]!.id).toBe(entry.id);expect(readContourLibrary()[0]!.name).toBe("改名曲线");
  expect(ui.preview.mock.calls.length).toBe(before);expect(ui.commit).not.toHaveBeenCalled();
  act(()=>button("取消样式").click());
  act(()=>root.unmount());controller.dispose();ui.container.remove();
  ui=await setup("style");act(()=>button("图层样式…").click());act(()=>button("添加效果").click());ui.tick();
  expect(ui.container.textContent).toContain("改名曲线");
  const preset=ui.container.querySelector<HTMLSelectElement>("[data-style-contour] select")!;
  // 线性快照匹配默认项；删除用户库不删除默认项或当前效果。
  select("[data-contour-library] select",entry.id);const previews=ui.preview.mock.calls.length;
  act(()=>button("删除预设").click());ui.tick();
  expect(readContourLibrary()).toEqual([]);expect(ui.preview.mock.calls.length).toBe(previews);
  expect([...preset.options].some(option=>option.textContent==="线性")).toBe(true);
  select("[data-style-contour] select","preset:1");ui.tick();
  typeName("我的锥形");act(()=>button("将当前曲线新建为预设").click());
  entry=readContourLibrary()[0]!;
  select("[data-contour-library] select",entry.id);typeName("重命名锥形");act(()=>button("重命名预设").click());
  expect(JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[0].DropShadow.contour.Custom.name).toBe("锥形");
  const option=[...preset.options].find(option=>option.textContent==="重命名锥形")!;
  select("[data-style-contour] select",option.value);ui.tick();
  expect(JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[0].DropShadow.contour.Custom.name).toBe("重命名锥形");
  expect(ui.commit).not.toHaveBeenCalled();expect(controller.isDirty()).toBe(false);
  const applied=ui.preview.mock.calls.length;
  act(()=>button("删除预设").click());ui.tick();
  expect(ui.preview.mock.calls.length).toBe(applied);
  expect(JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[0].DropShadow.contour.Custom.name).toBe("重命名锥形");
  act(()=>button("确认样式").click());expect(ui.commit).toHaveBeenCalledOnce();
});
it("存储失败仍保留会话预设并提示，SHC 追加且超容量原子拒绝",async()=>{
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>button("添加效果").click());ui.tick();
  vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota");});
  const name=ui.container.querySelector<HTMLInputElement>("[data-contour-library] input")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(name,"临时库曲线");name.dispatchEvent(new Event("input",{bubbles:true}));});
  const previews=ui.preview.mock.calls.length;act(()=>button("将当前曲线新建为预设").click());
  expect(ui.container.textContent).toContain("浏览器未能保存预设库");expect(ui.container.textContent).toContain("临时库曲线");
  const file=ui.container.querySelector<HTMLInputElement>("[data-contour-file]")!;
  Object.defineProperty(file,"files",{value:[{size:1,arrayBuffer:async()=>new Uint8Array([1]).buffer}]});
  await act(async()=>{file.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(ui.container.textContent).toContain("导入曲线");expect(ui.container.textContent).toContain("临时库曲线");
  ui.importContours.mockReturnValueOnce(JSON.stringify(Array.from({length:64},()=>({name:"超量",contour:"Linear"}))));
  await act(async()=>{file.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(ui.container.textContent).toContain("预设库最多 64 条");
  expect(ui.container.querySelectorAll("[data-contour-library] option")).toHaveLength(3);
  expect(ui.preview.mock.calls.length).toBe(previews);expect(ui.commit).not.toHaveBeenCalled();
  expect(localStorage.getItem(CONTOUR_LIBRARY_KEY)).toBeNull();
});


it("图案叠加和三类填充沿原属性草稿，切换填充分别记忆图案参数",async()=>{
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  const select=(el:HTMLSelectElement,value:string)=>act(()=>{el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));});
  const pattern=()=>ui.container.querySelector<HTMLElement>("[data-style-pattern]")!;
  const type=(scope:HTMLElement,label:string,next:string)=>act(()=>{
    const input=[...scope.querySelectorAll("label")].find(el=>el.textContent===label || el.textContent===label+"%")!.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,next);input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  const items=()=>JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items;
  act(()=>button("图层样式…").click());
  select(ui.container.querySelector('select[title="添加效果"]')!,"PatternOverlay");act(()=>button("添加效果").click());
  select(pattern().querySelector("select")!,"p-2");type(pattern(),"缩放","250");type(pattern(),"角度","45");type(pattern(),"水平偏移","12");ui.tick();
  expect(items()[0].PatternOverlay).toMatchObject({id:"p-2",name:"图案二",scale:2.5,angle:45,phase:[12,0]});
  for(const kind of ["Stroke","OuterGlow","InnerGlow"]) {
    select(ui.container.querySelector('select[title="添加效果"]')!,kind);act(()=>button("添加效果").click());
    const fill=()=>[...ui.container.querySelectorAll("label")].find(el=>el.textContent?.startsWith("填充类型"))!.querySelector("select")!;
    select(fill(),"Pattern");select(pattern().querySelector("select")!,"p-2");type(pattern(),"缩放","175");
    select(fill(),"Color");select(fill(),"Pattern");ui.tick();
    expect(items().at(-1)[kind].paint.Pattern).toEqual({id:"p-2",name:"图案二",scale:1.75});
  }
  expect(controller.isDirty()).toBe(false);expect(ui.commit).not.toHaveBeenCalled();
  act(()=>button("确认样式").click());expect(ui.commit).toHaveBeenCalledOnce();expect(controller.isDirty()).toBe(true);
});
it("斜面纹理深度、反相及链接可编辑，启停保留且实例不串用，取消恢复正式样式",async()=>{
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===text)!;
  const checkbox=(name:string)=>[...ui.container.querySelectorAll("label")].find(el=>el.textContent===name)!.querySelector<HTMLInputElement>("input")!;
  const select=(el:HTMLSelectElement,value:string)=>act(()=>{el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("图层样式…").click());select(ui.container.querySelector('select[title="添加效果"]')!,"BevelEmboss");act(()=>button("添加效果").click());
  act(()=>checkbox("启用斜面纹理").click());
  const pattern=()=>ui.container.querySelector<HTMLElement>("[data-style-pattern]")!;
  select(pattern().querySelector("select")!,"p-2");
  const depth=[...pattern().querySelectorAll("label")].find(el=>el.textContent==="纹理深度%")!.querySelector("input")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(depth,"-250");depth.dispatchEvent(new Event("input",{bubbles:true}));});
  act(()=>checkbox("反相纹理").click());act(()=>checkbox("与图层链接").click());ui.tick();
  const texture=()=>JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[0].BevelEmboss.texture;
  const expected={id:"p-2",name:"图案二",scale:1,depth:-2.5,invert:true,link:false,phase:[0,0]};expect(texture()).toEqual(expected);
  act(()=>checkbox("启用斜面纹理").click());ui.tick();expect(texture()).toBeNull();
  act(()=>checkbox("启用斜面纹理").click());ui.tick();expect(texture()).toEqual(expected);
  act(()=>button("添加效果").click());act(()=>checkbox("启用斜面纹理").click());ui.tick();
  expect(JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[1].BevelEmboss.texture).toMatchObject({id:"p-1",depth:1,invert:false});
  act(()=>button("取消样式").click());expect(ui.cancel).toHaveBeenCalledOnce();expect(ui.commit).not.toHaveBeenCalled();expect(controller.isDirty()).toBe(false);
});

it("图案库载入、改名、删除沿真实控制器链，库动作不应用样式或进入文档历史",async()=>{
  const save=vi.spyOn(patternStorage,"savePatternLibrarySnapshot").mockResolvedValue();
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
  const select=(element:HTMLSelectElement,value:string)=>act(()=>{element.value=value;element.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("图层样式…").click());
  const file=ui.container.querySelector<HTMLInputElement>("[data-pattern-file]")!;
  Object.defineProperty(file,"files",{value:[{size:2,arrayBuffer:async()=>new Uint8Array([9,8]).buffer}]});
  await act(async()=>file.dispatchEvent(new Event("change",{bubbles:true})));
  expect(ui.importPatterns).toHaveBeenCalledWith(new Uint8Array([9,8]));
  expect(ui.preview).not.toHaveBeenCalled();expect(ui.commit).not.toHaveBeenCalled();expect(controller.isDirty()).toBe(false);
  select(ui.container.querySelector('select[title="添加效果"]')!,"PatternOverlay");act(()=>button("添加效果").click());
  select(ui.container.querySelector("[data-style-pattern] select")!,"pat-1");
  // 不等动画帧：管理操作先刷新最新草稿，旧资源不会在待预览时被删除。
  select(ui.container.querySelector("[data-pattern-library] select")!,"pat-source");
  const name=ui.container.querySelector<HTMLInputElement>('[data-pattern-library] input:not([type="file"])')!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(name,"新名字");name.dispatchEvent(new Event("input",{bubbles:true}));});
  act(()=>button("重命名图案").click());
  expect(ui.renamePattern).toHaveBeenCalledWith("pat-source","新名字");
  expect(JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[0].PatternOverlay).toMatchObject({id:"pat-1",name:"用户图案"});
  const count=ui.preview.mock.calls.length;
  await act(async()=>button("删除图案").click());
  expect(ui.deletePattern).toHaveBeenCalledWith("pat-source");expect(ui.preview.mock.calls.length).toBe(count);
  expect(save).toHaveBeenCalledTimes(3);expect(ui.patternSnapshot).toHaveBeenCalledTimes(3);
  expect(controller.isDirty()).toBe(false);act(()=>button("取消样式").click());expect(ui.commit).not.toHaveBeenCalled();
  act(()=>button("图层样式…").click());expect(ui.container.querySelector("[data-pattern-library] select")).toBeNull();
  // 同一原生控制器中已删除到空的库，不能因旧存储或 React 重挂载而复活。
  vi.stubGlobal("indexedDB",{});
  const read=vi.spyOn(patternStorage,"readPatternLibrarySnapshot").mockResolvedValue(new Uint8Array([7]));
  act(()=>root.unmount());root=createRoot(ui.container);ui.render();
  await act(async()=>{});act(()=>button("图层样式…").click());
  expect(read).not.toHaveBeenCalled();expect(ui.container.querySelector("[data-pattern-library] select")).toBeNull();
});
it("图案库保存失败保留当前库并提示 PAT 保存路径",async()=>{
  vi.spyOn(patternStorage,"savePatternLibrarySnapshot").mockRejectedValue(new Error("quota"));
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
  act(()=>button("图层样式…").click());const file=ui.container.querySelector<HTMLInputElement>("[data-pattern-file]")!;
  Object.defineProperty(file,"files",{value:[{size:1,arrayBuffer:async()=>new ArrayBuffer(1)}]});
  await act(async()=>file.dispatchEvent(new Event("change",{bubbles:true})));
  expect(ui.container.textContent).toContain("浏览器未能保存图案库");expect(ui.container.textContent).toContain("用户图案");
  expect(ui.preview).not.toHaveBeenCalled();expect(ui.commit).not.toHaveBeenCalled();expect(controller.isDirty()).toBe(false);
});
it("本机图案库异步恢复不改文档，读取晚到不能写入卸载后的控制器",async()=>{
  vi.stubGlobal("indexedDB",{});
  let resolve!:(bytes:Uint8Array|null)=>void;
  const read=vi.spyOn(patternStorage,"readPatternLibrarySnapshot").mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
  act(()=>button("图层样式…").click());expect(button("载入图案…").disabled).toBe(true);
  await act(async()=>resolve(new Uint8Array([7])));
  expect(ui.restorePatterns).toHaveBeenCalledWith(new Uint8Array([7]));expect(ui.container.textContent).toContain("已保存图案");
  expect(ui.preview).not.toHaveBeenCalled();expect(controller.isDirty()).toBe(false);
  act(()=>root.unmount());controller.dispose();
  read.mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const late=await setup("style");act(()=>root.unmount());
  await act(async()=>resolve(new Uint8Array([8])));expect(late.restorePatterns).not.toHaveBeenCalled();
});

function stylePositionCanvas(container:HTMLElement) {
  const stage=container.querySelector<HTMLElement>(".photo-editor-canvas")!;
  const captures=new Set<number>();
  stage.setPointerCapture=(id:number)=>{captures.add(id);};stage.hasPointerCapture=(id:number)=>captures.has(id);stage.releasePointerCapture=(id:number)=>{captures.delete(id);};
  return (type:string,x=300,y=200)=>{
    const e=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(e,"pointerId",{value:1});act(()=>stage.dispatchEvent(e));
  };
}
it("图内图案定位按帧预览，Esc 只撤回本次拖动，松手不确认整次样式",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  const select=(title:string,value:string)=>act(()=>{const el=ui.container.querySelector<HTMLSelectElement>(`select[title="${title}"]`)!;el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("图层样式…").click());select("添加效果","PatternOverlay");act(()=>button("添加效果").click());ui.tick();
  expect(ui.container.textContent).toContain("在图像内拖动调整图案位置");
  const send=stylePositionCanvas(ui.container);
  const phase=()=>JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[0].PatternOverlay.phase;
  send("pointerdown");send("pointermove",320,230);ui.tick();expect(phase()[0]).toBeCloseTo(40);expect(phase()[1]).toBeCloseTo(60);
  expect(controller.isDirty()).toBe(false);expect(ui.commit).not.toHaveBeenCalled();
  act(()=>ui.container.querySelector(".photo-editor")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));ui.tick();
  expect(phase()).toEqual([0,0]);expect(controller.hasLayerProperties()).toBe(true);expect(ui.cancel).not.toHaveBeenCalled();
  const calls=ui.preview.mock.calls.length;send("pointerup",350,260);ui.tick();expect(ui.preview).toHaveBeenCalledTimes(calls);
  send("pointerdown");send("pointermove",310,210);send("pointerup",330,240);ui.tick();expect(phase()[0]).toBeCloseTo(60);expect(phase()[1]).toBeCloseTo(80);
  expect(ui.commit).not.toHaveBeenCalled();act(()=>button("确认样式").click());expect(ui.commit).toHaveBeenCalledOnce();
  expect(controller.snapshot().view.document?.revision).toBe(2);
});
it("斜面纹理定位取消不回滚其它效果，目标切换及只读不让旧指针提交",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  const select=(title:string,value:string)=>act(()=>{const el=ui.container.querySelector<HTMLSelectElement>(`select[title="${title}"]`)!;el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("图层样式…").click());act(()=>button("添加效果").click());
  select("添加效果","BevelEmboss");act(()=>button("添加效果").click());
  act(()=>[...ui.container.querySelectorAll("label")].find(el=>el.textContent==="启用斜面纹理")!.querySelector<HTMLInputElement>("input")!.click());ui.tick();
  expect(ui.container.textContent).toContain("在图像内拖动调整纹理位置");
  const send=stylePositionCanvas(ui.container),items=()=>JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items;
  send("pointerdown");send("pointermove",320,230);ui.tick();expect(items()[1].BevelEmboss.texture.phase[0]).toBeCloseTo(40);expect(items()[1].BevelEmboss.texture.phase[1]).toBeCloseTo(60);
  select("当前效果","0");ui.tick();expect(items()).toHaveLength(2);expect(items()[1].BevelEmboss.texture.phase).toEqual([0,0]);
  send("pointerup",350,260);ui.tick();expect(items()[1].BevelEmboss.texture.phase).toEqual([0,0]);
  select("当前效果","1");send("pointerdown");send("pointermove",320,230);ui.render(true);ui.tick();
  send("pointerup",350,260);expect(ui.commit).not.toHaveBeenCalled();expect(ui.cancel).toHaveBeenCalledOnce();expect(controller.isDirty()).toBe(false);
});
it("定位未松手时禁止确认，取消样式不被迟到释放重新预览",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  const ui=await setup("style"),button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>{const el=ui.container.querySelector<HTMLSelectElement>('select[title="添加效果"]')!;el.value="PatternOverlay";el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("添加效果").click());ui.tick();const send=stylePositionCanvas(ui.container);
  send("pointerdown");send("pointermove",320,230);act(()=>button("确认样式").click());expect(ui.commit).not.toHaveBeenCalled();
  expect(ui.container.textContent).toContain("请先结束样式拖动");
  act(()=>button("取消样式").click());const calls=ui.preview.mock.calls.length;send("pointerup",350,260);ui.tick();
  expect(ui.preview).toHaveBeenCalledTimes(calls);expect(controller.hasLayerProperties()).toBe(false);expect(controller.isDirty()).toBe(false);
});
it("拖动期间晚到的本机图案目录不随定位预览或撤回丢失",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  vi.stubGlobal("indexedDB",{});let resolve!:(bytes:Uint8Array|null)=>void;
  vi.spyOn(patternStorage,"readPatternLibrarySnapshot").mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const ui=await setup("style"),button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>{const el=ui.container.querySelector<HTMLSelectElement>('select[title="添加效果"]')!;el.value="PatternOverlay";el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("添加效果").click());ui.tick();const send=stylePositionCanvas(ui.container);send("pointerdown");
  await act(async()=>resolve(new Uint8Array([7])));
  const options=()=>[...ui.container.querySelectorAll("[data-style-pattern] option")].map(el=>el.textContent);
  expect(options()).toContain("已保存图案（8 × 8）");
  send("pointermove",320,230);ui.tick();expect(options()).toContain("已保存图案（8 × 8）");
  send("pointercancel");ui.tick();expect(options()).toContain("已保存图案（8 × 8）");
  expect(controller.hasLayerProperties()).toBe(true);expect(ui.commit).not.toHaveBeenCalled();expect(controller.isDirty()).toBe(false);
});

it("渐变定位沿原生效果帧比例，释放补齐并统一确认，Esc 保留样式",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  // 实际文档 800×600，原生样式帧 200×80，不能使用文档或预览尺寸归一化。
  const ui=await setup("style",[-13,7,200,80]);
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>{const el=ui.container.querySelector<HTMLSelectElement>('select[title="添加效果"]')!;el.value="GradientOverlay";el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("添加效果").click());ui.tick();expect(ui.container.textContent).toContain("在图像内拖动调整渐变位置");
  expect([...ui.container.querySelectorAll("label")].some(el=>el.textContent==="与图层对齐")).toBe(false);
  const send=stylePositionCanvas(ui.container),offset=()=>JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[0].GradientOverlay.gradient.offset;
  send("pointerdown");send("pointermove",320,220);ui.tick();expect(offset()[0]).toBeCloseTo(.2);expect(offset()[1]).toBeCloseTo(.5);
  expect(controller.isDirty()).toBe(false);
  act(()=>ui.container.querySelector(".photo-editor")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));ui.tick();
  expect(offset()).toEqual([0,0]);expect(controller.hasLayerProperties()).toBe(true);
  send("pointerdown");send("pointerup",325,220);ui.tick();expect(offset()[0]).toBeCloseTo(.25);expect(offset()[1]).toBeCloseTo(.5);
  expect(JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[0].GradientOverlay.gradient.align).toBe(true);
  const input=(name:string)=>[...ui.container.querySelectorAll("label")].find(el=>el.textContent===name+"%")!.querySelector<HTMLInputElement>("input")!;
  expect(input("水平偏移").value).toBe("25");expect(Number(input("垂直偏移").value)).toBeCloseTo(50);
  expect(ui.commit).not.toHaveBeenCalled();act(()=>button("确认样式").click());expect(ui.commit).toHaveBeenCalledOnce();expect(controller.isDirty()).toBe(true);
});
it("缺少或损坏原生帧时不提供渐变图内定位，数值编辑仍可用",async()=>{
  const ui=await setup("style",[0,0,0,80]),button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>{const el=ui.container.querySelector<HTMLSelectElement>('select[title="添加效果"]')!;el.value="GradientOverlay";el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("添加效果").click());ui.tick();expect(ui.container.textContent).not.toContain("在图像内拖动调整渐变位置");
  const send=stylePositionCanvas(ui.container),calls=ui.preview.mock.calls.length;
  send("pointerdown");send("pointerup",325,220);ui.tick();expect(ui.preview).toHaveBeenCalledTimes(calls);
  expect([...ui.container.querySelectorAll("label")].some(el=>el.textContent==="水平偏移%")).toBe(true);expect(ui.commit).not.toHaveBeenCalled();
});
it("内外发光的渐变只提供生效的色标控件，不显示空间偏移或定位",async()=>{
  const ui=await setup("style"),button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  act(()=>button("图层样式…").click());
  const select=(el:HTMLSelectElement,value:string)=>act(()=>{el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));});
  for(const kind of ["InnerGlow","OuterGlow"]) {
    select(ui.container.querySelector('select[title="添加效果"]')!,kind);act(()=>button("添加效果").click());
    select([...ui.container.querySelectorAll("label")].find(el=>el.textContent?.startsWith("填充类型"))!.querySelector("select")!,"Gradient");ui.tick();
    const labels=[...ui.container.querySelectorAll("[data-layer-style] label")].map(el=>el.textContent);
    expect(labels).not.toContain("水平偏移%");expect(labels).not.toContain("垂直偏移%");expect(labels).not.toContain("缩放%");
    expect(ui.container.querySelector('[data-layer-style] select option[value="Linear"]')).toBeNull();
    expect(ui.container.textContent).toContain("渐变沿发光强度分布");expect(ui.container.textContent).not.toContain("在图像内拖动调整渐变位置");
    act(()=>button("添加透明度色标").click());ui.tick();
    const current=JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items.at(-1)[kind].paint.Gradient;
    expect(current.opacity_stops).toEqual([[.5,1]]);expect(current.offset).toEqual([0,0]);expect(current.angle).toBe(90);
  }
});

it("描边定位先刷新待预览尺寸，再查询独立原生帧，每次拖动重新读取",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  const ui=await setup("style"),button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  const select=(el:HTMLSelectElement,value:string)=>act(()=>{el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("图层样式…").click());select(ui.container.querySelector('select[title="添加效果"]')!,"Stroke");act(()=>button("添加效果").click());
  expect(ui.container.textContent).not.toContain("在图像内拖动调整渐变位置");
  select([...ui.container.querySelectorAll("label")].find(el=>el.textContent?.startsWith("填充类型"))!.querySelector("select")!,"Gradient");
  const stroke=()=>JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items[0].Stroke;
  ui.positionFrame.mockImplementation(index=>{expect(index).toBe(0);return JSON.stringify(stroke().size===20?[-24,-4,300,120]:[-16,4,240,100]);});
  const send=stylePositionCanvas(ui.container);expect(ui.positionFrame).not.toHaveBeenCalled();
  send("pointerdown");expect(stroke().paint.Gradient).toBeDefined();expect(ui.positionFrame).toHaveBeenCalledOnce();
  send("pointerup",330,225);ui.tick();expect(stroke().paint.Gradient.offset[0]).toBeCloseTo(.25);expect(stroke().paint.Gradient.offset[1]).toBeCloseTo(.5);
  const size=[...ui.container.querySelectorAll("label")].find(el=>el.textContent==="大小")!.querySelector<HTMLInputElement>("input")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(size,"20");size.dispatchEvent(new Event("input",{bubbles:true}));});
  send("pointerdown");expect(stroke().size).toBe(20);expect(ui.positionFrame).toHaveBeenCalledTimes(2);
  send("pointermove",330,225);ui.tick();expect(stroke().paint.Gradient.offset[0]).toBeCloseTo(.45);expect(stroke().paint.Gradient.offset[1]).toBeCloseTo(.5+50/120);
  act(()=>ui.container.querySelector(".photo-editor")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));ui.tick();
  expect(stroke().paint.Gradient.offset[0]).toBeCloseTo(.25);expect(stroke().size).toBe(20);expect(controller.hasLayerProperties()).toBe(true);
  send("pointerup",350,260);send("pointerdown");send("pointerup",330,225);ui.tick();
  expect(ui.positionFrame).toHaveBeenCalledTimes(3);expect(stroke().paint.Gradient.offset[0]).toBeCloseTo(.45);
  expect(controller.isDirty()).toBe(false);expect(ui.commit).not.toHaveBeenCalled();act(()=>button("确认样式").click());expect(ui.commit).toHaveBeenCalledOnce();
});
it("原生描边帧查询失败或返回坏帧不回退图层边界，保留样式并允许重试",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  const ui=await setup("style"),button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  const select=(el:HTMLSelectElement,value:string)=>act(()=>{el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("图层样式…").click());select(ui.container.querySelector('select[title="添加效果"]')!,"Stroke");act(()=>button("添加效果").click());
  select([...ui.container.querySelectorAll("label")].find(el=>el.textContent?.startsWith("填充类型"))!.querySelector("select")!,"Gradient");ui.tick();
  const send=stylePositionCanvas(ui.container),stage=ui.container.querySelector<HTMLElement>(".photo-editor-canvas")!;
  ui.positionFrame.mockImplementationOnce(()=>{throw JSON.stringify({code:"command-failed",message:"描边帧暂不可用"});});
  send("pointerdown");expect(stage.hasPointerCapture(1)).toBe(false);expect(ui.container.textContent).toContain("描边帧暂不可用");
  const calls=ui.preview.mock.calls.length;send("pointermove",330,225);send("pointerup",330,225);ui.tick();expect(ui.preview).toHaveBeenCalledTimes(calls);
  ui.positionFrame.mockReturnValueOnce("[0,0,0,100]");send("pointerdown");expect(stage.hasPointerCapture(1)).toBe(false);expect(ui.container.textContent).toContain("原生样式定位帧无效");
  send("pointerdown");expect(stage.hasPointerCapture(1)).toBe(true);send("pointercancel");ui.tick();
  expect(ui.commit).not.toHaveBeenCalled();expect(controller.hasLayerProperties()).toBe(true);expect(controller.isDirty()).toBe(false);
});
it("描边多实例定位按当前重排索引查询，不移动另一效果",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  const ui=await setup("style"),button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(el=>el.textContent===text)!;
  const select=(el:HTMLSelectElement,value:string)=>act(()=>{el.value=value;el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("图层样式…").click());select(ui.container.querySelector('select[title="添加效果"]')!,"Stroke");act(()=>button("添加效果").click());
  select([...ui.container.querySelectorAll("label")].find(el=>el.textContent?.startsWith("填充类型"))!.querySelector("select")!,"Gradient");
  act(()=>button("复制效果").click());ui.tick();const send=stylePositionCanvas(ui.container);
  send("pointerdown");expect(ui.positionFrame).toHaveBeenLastCalledWith(1);send("pointerup",330,225);ui.tick();
  const items=()=>JSON.parse(ui.preview.mock.calls.at(-1)![0]).style.items;
  expect(items()[0].Stroke.paint.Gradient.offset).toEqual([0,0]);expect(items()[1].Stroke.paint.Gradient.offset[0]).toBeCloseTo(.25);
  act(()=>button("上移").click());send("pointerdown");expect(ui.positionFrame).toHaveBeenLastCalledWith(0);send("pointerup",330,225);ui.tick();
  expect(items()[0].Stroke.paint.Gradient.offset[0]).toBeCloseTo(.5);expect(items()[1].Stroke.paint.Gradient.offset).toEqual([0,0]);
});

it("投影定位更新共享光源，Esc 恢复本次拖动，释放补齐坐标后统一一步确认",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
  act(()=>button("图层样式…").click());act(()=>button("添加效果").click());ui.tick();
  expect(ui.container.textContent).toContain("在图像内拖动调整投影位置");
  const send=stylePositionCanvas(ui.container),data=()=>JSON.parse(ui.preview.mock.calls.at(-1)![0]);
  send("pointerdown");send("pointermove",320,230);ui.tick();
  expect(data().style.items[0].DropShadow.distance).toBeGreaterThan(5);expect(data().globalLight.angle).not.toBe(120);
  expect(data().style.items[0].DropShadow.angle).toBe(120);expect(data().globalLight.altitude).toBe(30);
  expect(controller.isDirty()).toBe(false);expect(ui.positionFrame).not.toHaveBeenCalled();
  act(()=>ui.container.querySelector(".photo-editor")!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));ui.tick();
  expect(data().style.items[0].DropShadow.distance).toBe(5);expect(data().globalLight.angle).toBe(120);
  const calls=ui.preview.mock.calls.length;send("pointerup",350,260);ui.tick();expect(ui.preview).toHaveBeenCalledTimes(calls);
  send("pointerdown");send("pointerup",330,240);ui.tick();
  expect(data().style.items[0].DropShadow.distance).toBeCloseTo(Math.hypot(62.5,80+Math.sin(2*Math.PI/3)*5));
  const completed=data();send("pointerdown");send("pointerup",3000,3000);ui.tick();expect(data()).toEqual(completed);
  expect(ui.commit).not.toHaveBeenCalled();act(()=>button("确认样式").click());expect(ui.commit).toHaveBeenCalledOnce();
  expect(controller.snapshot().view.document?.revision).toBe(2);
});

it("内阴影局部光源拖动不改变全局光，取消样式后旧指针不补交",async()=>{
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(864);
  vi.spyOn(HTMLElement.prototype,"clientHeight","get").mockReturnValue(514);
  const ui=await setup("style");
  const button=(text:string)=>[...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
  act(()=>button("图层样式…").click());
  act(()=>{const el=ui.container.querySelector<HTMLSelectElement>('select[title="添加效果"]')!;el.value="InnerShadow";el.dispatchEvent(new Event("change",{bubbles:true}));});
  act(()=>button("添加效果").click());
  act(()=>[...ui.container.querySelectorAll("label")].find(el=>el.textContent==="使用全局光")!.querySelector<HTMLInputElement>("input")!.click());ui.tick();
  expect(ui.container.textContent).toContain("在图像内拖动调整内阴影位置");
  const send=stylePositionCanvas(ui.container),data=()=>JSON.parse(ui.preview.mock.calls.at(-1)![0]);
  send("pointerdown");send("pointerup",320,230);ui.tick();
  expect(data().style.items[0].InnerShadow.use_global_light).toBe(false);expect(data().style.items[0].InnerShadow.angle).not.toBe(120);
  expect(data().globalLight).toEqual({angle:120,altitude:30});
  const completed=data();send("pointerdown");send("pointermove",315,215);ui.tick();send("pointercancel");ui.tick();expect(data()).toEqual(completed);
  send("pointerdown");send("pointermove",310,210);ui.tick();act(()=>button("取消样式").click());
  const calls=ui.preview.mock.calls.length;send("pointerup",340,240);ui.tick();
  expect(ui.preview).toHaveBeenCalledTimes(calls);expect(ui.cancel).toHaveBeenCalledOnce();expect(ui.commit).not.toHaveBeenCalled();expect(controller.isDirty()).toBe(false);
});
