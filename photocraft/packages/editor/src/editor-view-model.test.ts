/**
 * 编辑内核视图模型回归
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 3.2/3.4）。
 */
import { describe, expect, it } from "vitest";
import {
  commandTooltip,
  decodeEditorState,
  indexRenderableCommands,
  isFirstPhaseBlend,
  isRenderableCommand
} from "./editor-view-model.js";

function stateWithLayers() {
  return {
    session: { active: 0, documents: [{ index: 0, name: "photo.png", width: 800, height: 600 }] },
    document: {
      name: "photo.png",
      width: 800,
      height: 600,
      mode: "Rgb",
      depth: 8,
      activeLayer: 3,
      selectedLayers: [3],
      hasSelection: true,
      selectionOutline: [[8, 12, 40, 12], [40, 12, 40, 50]],
      canUndo: true,
      canRedo: false,
      revision: 7,
      history: ["打开", "新建图层"],
      redoHistory: ["画笔", "重命名"],
      layers: [
        {
          id: 3,
          name: "文字",
          kind: "text",
          visible: true,
          opacity: 0.5,
          blend: "Multiply",
          clipped: false,
          hasMask: false,
          text: { text: "标题", font: "NotoSansSC", sizePt: 24 },
          children: [{ id: 4, name: "组内", kind: "raster", visible: false, opacity: 1, blend: "Normal" }]
        },
        { id: 1, name: "背景", kind: "raster", visible: true, opacity: 1, blend: "Normal", hasMask: true }
      ]
    }
  };
}

describe("内核状态解码", () => {
  it("归一上游 inspect 的实际种类名称，保留旧小写状态兼容", () => {
    const kinds = ["Pixel", "Group", "Adjustment", "Fill", "Type", "Shape", "Smart Object", "raster", "group", "text"];
    const document = decodeEditorState({ document: { width: 16, height: 16,
      layers: kinds.map((kind, id) => ({ id, kind })) } })!.document!;
    expect(document.layers.map((layer) => layer.kind)).toEqual([
      "raster", "group", "adjustment", "fill", "text", "shape", "smart", "raster", "group", "text"
    ]);
  });

  it("按显示顺序展开图层并标注层级、活动层与选中项", () => {
    const view = decodeEditorState(stateWithLayers());
    expect(view).not.toBeNull();
    if (!view || !view.document) throw new Error("expected document");
    expect(view.hasDocument).toBe(true);
    expect(view.document.width).toBe(800);
    expect(view.document.selectionOutline).toEqual([[8, 12, 40, 12], [40, 12, 40, 50]]);
    expect(view.document.selectedLayerIds).toEqual([3]);
    expect(view.document.layers.map((layer) => layer.id)).toEqual([3, 4, 1]);
    expect(view.document.layers.map((layer) => layer.depth)).toEqual([0, 1, 0]);
    expect(view.document.layers[0]?.active).toBe(true);
    expect(view.document.layers[0]?.text).toBe("标题");
    expect(view.document.layers[1]?.visible).toBe(false);
    expect(view.document.layers[2]?.hasMask).toBe(true);
    expect(view.document.history).toEqual(["打开", "新建图层"]);
    expect(view.document.redoHistory).toEqual(["画笔", "重命名"]);
  });

  it("没有文档时给出空视图而不是报错", () => {
    const view = decodeEditorState({ session: { active: null, documents: [] }, document: null });
    expect(view).toEqual({ hasDocument: false, document: null, sessionActiveIndex: null });
  });

  it("结构非法时返回 null（不渲染半截界面）", () => {
    expect(decodeEditorState(null)).toBeNull();
    expect(decodeEditorState({ document: { width: 0, height: 600 } })).toBeNull();
    expect(decodeEditorState({ document: { width: 800, height: 600, layers: [{ name: "无 id" }] } })).toMatchObject({
      hasDocument: true,
      document: { layers: [] }
    });
  });
});

describe("命令表过滤", () => {
  function command(overrides: Record<string, unknown>) {
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

  it("只保留首期白名单内、且出现在菜单里的命令", () => {
    const index = indexRenderableCommands([
      command({}),
      command({ id: "select.subject", allowed: false }),
      command({ id: "edit.undo", menu: [] }),
      command({ id: "layer.select", menu: ["Layer"] })
    ]);
    expect([...index.keys()].sort()).toEqual(["layer.delete", "layer.select"]);
  });

  it("命令表结构非法时返回空表", () => {
    expect(indexRenderableCommands({ nope: true }).size).toBe(0);
    expect(indexRenderableCommands([command({ allowed: 1 })]).size).toBe(0);
  });

  it("判定与提示使用真实字段", () => {
    expect(isRenderableCommand({ ...command({}), allowed: false } as never)).toBe(false);
    expect(commandTooltip(command({ params: '{"layer":id}' }) as never)).toContain("删除图层");
  });
});

describe("首期混合模式", () => {
  it("只接受 Normal/Multiply/Screen（大小写不敏感）", () => {
    expect(isFirstPhaseBlend("Normal")).toBe(true);
    expect(isFirstPhaseBlend("multiply")).toBe(true);
    expect(isFirstPhaseBlend("Screen")).toBe(true);
    expect(isFirstPhaseBlend("Color Dodge")).toBe(false);
  });
});

it("取消选区不残留边界，空或非法轮廓不会显示成选区", () => {
  const state = stateWithLayers();
  state.document.hasSelection = false;
  expect(decodeEditorState(state)?.document?.selectionOutline).toEqual([]);
  state.document.hasSelection = true;
  state.document.selectionOutline = [[0, 0, Number.NaN, 1], [0, 1], [0, 1, 2, 1]];
  expect(decodeEditorState(state)?.document?.selectionOutline).toEqual([[0, 1, 2, 1]]);
});

it("选区变换框独立于内容框，拒绝退化或非有限边界，旧绑定可缺省", () => {
  const decode=(selectionFrame?:unknown) => decodeEditorState({document:{width:100,height:80,hasSelection:true,transformFrame:null,selectionFrame}})!.document!;
  expect(decode([10,15,70,60]).selectionFrame).toEqual([10,15,70,60]);
  expect(decode([10,15,70,60]).transformFrame).toBeNull();
  for (const invalid of [undefined,null,[0,0,0,10],[10,0,0,10],[0,0,Infinity,10],[0,0,10]]) expect(decode(invalid).selectionFrame).toBeNull();
});

it("蒙版目标与单独查看需要当前活动层的实际蒙版；旧状态使用安全默认", () => {
  const decode=(hasMask:boolean,extra:Record<string,unknown>={})=>decodeEditorState({document:{
    channelTarget: { kind: "composite" },
width:80,height:60,activeLayer:1,editTarget:"mask",layerMaskView:{layer:1,mode:"gray"},layers:[{id:1,hasMask,maskEnabled:false,maskLinked:false}],...extra}})!.document!;
  expect(decode(true).editTarget).toBe("mask"); expect(decode(true).maskView).toBe(1);
  expect(decode(true).layers[0]).toMatchObject({maskEnabled:false,maskLinked:false});
  expect(decode(false).editTarget).toBe("pixels"); expect(decode(false).maskView).toBeNull();
  expect(decode(true,{layerMaskView:{layer:2,mode:"gray"}}).maskView).toBeNull();
});

it("图层锁定和继承锁分开读取，旧状态缺省无锁",()=>{
  const doc=decodeEditorState({document:{width:16,height:16,layers:[
    {id:1,locks:{position:true},effectiveLocks:{position:true,all:true}},{id:2}
  ]}})!.document!;
  expect(doc.layers[0].locks).toMatchObject({position:true,all:false});
  expect(doc.layers[0].effectiveLocks).toMatchObject({position:true,all:true});
  expect(Object.values(doc.layers[1].locks).every(value=>!value)).toBe(true);
});

it("分组投影保留折叠后代和父 id，展开命令不因无菜单而丢失",()=>{
  const doc=decodeEditorState({document:{width:16,height:16,activeLayer:3,selectedLayers:[3],layers:[
    {id:1,kind:"group",expanded:false,children:[{id:2,kind:"group",children:[{id:3,kind:"raster"}]}]}
  ]}})!.document!;
  expect(doc.layers.map(row=>[row.id,row.parentId,row.expanded])).toEqual([[1,null,false],[2,1,true],[3,2,true]]);
  expect(doc.layers[2]).toMatchObject({selected:true,active:true,depth:2});
  expect(isRenderableCommand({id:"layer.setExpanded",allowed:true,menu:[]} as never)).toBe(true);
  expect(isRenderableCommand({id:"layer.setExpanded",allowed:false,menu:[]} as never)).toBe(false);
});

it("图层行的链接/标签/高级混合/Blend If 按内核字段解码，缺字段用安全默认",()=>{
  const doc=decodeEditorState({document:{width:16,height:16,layers:[
    {id:1,linkGroup:2,labelColor:"blue",advancedBlending:{knockout:"shallow",blendInterior:true,layerMaskHidesEffects:true,vectorMaskHidesEffects:true},channels:[true,true,false,true],blendIf:[{channel:1,thisLayer:[30,60,200,235],underlying:[0,255]}]},
    {id:2}
  ]}})!.document!;
  expect(doc.layers[0]).toMatchObject({linkGroup:2,labelColor:"blue",channels:[true,true,false,true]});
  expect(doc.layers[0].advancedBlending).toEqual({knockout:"shallow",blendInterior:true,blendClipped:true,transparencyShapes:true,layerMaskHidesEffects:true,vectorMaskHidesEffects:true});
  expect(doc.layers[0].blendIf).toEqual([{channel:1,thisLayer:[30,60,200,235],underlying:[0,255]}]);
  // 旧状态没有这些字段：不能凭空造出链接组或端点。
  expect(doc.layers[1]).toMatchObject({linkGroup:null,labelColor:"none",channels:null,blendIf:[]});
  expect(doc.layers[1].advancedBlending).toEqual({knockout:"none",blendInterior:false,blendClipped:true,transparencyShapes:true,layerMaskHidesEffects:false,vectorMaskHidesEffects:false});
});

it("非法 Blend If 端点被丢弃，不拿半截数组去提交",()=>{
  const doc=decodeEditorState({document:{width:16,height:16,layers:[{id:1,blendIf:[
    {channel:0,thisLayer:[30],underlying:[0,255]},
    {channel:1,thisLayer:[0,255],underlying:[0]},
    {channel:2,thisLayer:[1,2,3],underlying:[0,255]},
    {channel:3,thisLayer:[0,255],underlying:[0,255]}
  ]}]}})!.document!;
  expect(doc.layers[0].blendIf).toEqual([{channel:3,thisLayer:[0,255],underlying:[0,255]}]);
});
