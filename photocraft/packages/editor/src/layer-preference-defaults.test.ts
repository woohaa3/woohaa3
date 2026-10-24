import {describe,expect,it} from "vitest";
import {DEFAULT_EDITOR_PREFERENCES,normalizeEditorPreferences} from "./editor-preferences.js";
import {decodeEditorState} from "./editor-view-model.js";

describe("本机交互偏好默认值（I177/I218/I294）",()=>{
 it("重排画布预览默认开启，坏存储回退默认而不影响其他偏好",()=>{
  expect(DEFAULT_EDITOR_PREFERENCES.previewLayerReorder).toBe(true);
  expect(normalizeEditorPreferences({}).previewLayerReorder).toBe(true);
  expect(normalizeEditorPreferences({previewLayerReorder:false}).previewLayerReorder).toBe(false);
  // 非布尔值按默认值处理，不把缺失/损坏的字段读成关闭。
  for(const value of ["false",0,null,{},[]])expect(normalizeEditorPreferences({previewLayerReorder:value}).previewLayerReorder).toBe(true);
 });
 it("布局记忆默认开启，关闭后只影响工作区显隐恢复",()=>{
  expect(DEFAULT_EDITOR_PREFERENCES.rememberWorkspaceChanges).toBe(true);
  expect(normalizeEditorPreferences({rememberWorkspaceChanges:false}).rememberWorkspaceChanges).toBe(false);
  expect(normalizeEditorPreferences({rememberWorkspaceChanges:"no"}).rememberWorkspaceChanges).toBe(true);
 });
});

describe("网格步长本机偏好",()=>{
 it("只接受 2–4096 的整数，坏值回退默认且不进入工程",()=>{
  expect(DEFAULT_EDITOR_PREFERENCES.gridSize).toBe(100);
  expect(normalizeEditorPreferences({gridSize:64}).gridSize).toBe(64);
  expect(normalizeEditorPreferences({gridSize:2}).gridSize).toBe(2);
  expect(normalizeEditorPreferences({gridSize:4096}).gridSize).toBe(4096);
  for(const value of [1,0,-5,4097,2.5,"100",null,Number.NaN])expect(normalizeEditorPreferences({gridSize:value}).gridSize).toBe(100);
 });
});

describe("蒙版叠加视图投影（I220）",()=>{
 it("只有活动层确有蒙版且模式为 overlay 时才报告叠加",()=>{
  const base={width:8,height:8,mode:"Rgb",depth:8,activeLayer:1,selectedLayers:[1],layers:[{id:1,name:"层",kind:"raster",hasMask:true,visible:true,opacity:1,blend:"Normal"}]};
  const view=(maskView:unknown)=>decodeEditorState({session:{active:0,documents:[]},document:{...base,layerMaskView:maskView}});
  expect(view({layer:1,mode:"overlay"})?.document?.maskOverlay).toBe(1);
  expect(view({layer:1,mode:"gray"})?.document?.maskOverlay).toBeNull();
  // 没有蒙版的层不报告叠加。
  expect(decodeEditorState({session:{active:0,documents:[]},document:{...base,layers:[{id:1,name:"层",kind:"raster",visible:true,opacity:1,blend:"Normal"}],layerMaskView:{layer:1,mode:"overlay"}}})?.document?.maskOverlay).toBeNull();
  // 投影到别的层也不算活动层叠加。
  expect(view({layer:2,mode:"overlay"})?.document?.maskOverlay).toBeNull();
 });
});
