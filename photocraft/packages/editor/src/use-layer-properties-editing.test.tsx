/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import {decodeEditorState} from "./editor-view-model.js";
import {useLayerPropertiesEditing} from "./use-layer-properties-editing.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.replaceChildren();vi.unstubAllGlobals();});
it("混合和百分比共用草稿且 owner 分流：关闭未持有事务的混合菜单不取消数值编辑",()=>{
  vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const begin=vi.fn(()=>({ok:true,value:{}})),preview=vi.fn(()=>({ok:true,value:{}})),commit=vi.fn(()=>({ok:true,value:null})),cancel=vi.fn();
  const controller={beginLayerProperties:begin,previewLayerProperties:preview,commitLayerProperties:commit,cancelLayerProperties:cancel,patternLibrary:()=>({ok:true,value:{presets:[]}})} as unknown as EditorWorkspaceController;
  const layer=decodeEditorState({document:{width:16,height:16,layers:[{id:1,name:"A",kind:"pixel"}],activeLayer:1}})!.document!.layers[0];
  let editing:ReturnType<typeof useLayerPropertiesEditing>;function Probe() {editing=useLayerPropertiesEditing(controller,layer,vi.fn(),vi.fn(),false);return null;}
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);act(()=>root.render(<Probe/>));
  act(()=>editing!.update("50"));expect(begin).toHaveBeenCalledTimes(1);act(()=>editing!.blendEditing.finish(false));expect(cancel).not.toHaveBeenCalled();expect(editing!.active).toBe(true);
  act(()=>editing!.blendEditing.preview("Multiply"));expect(preview.mock.calls[0]).toEqual([{opacity:0.5}]);expect(commit).toHaveBeenCalledTimes(1);expect(begin).toHaveBeenCalledTimes(2);
  act(()=>editing!.blendEditing.finish(true));expect(preview.mock.lastCall).toEqual([{blend:"Multiply"}]);expect(commit).toHaveBeenCalledTimes(2);expect(editing!.active).toBe(false);
});

it("蒙版草稿取消恢复参数，非法数字阻止提交，混合菜单不能结束蒙版事务",()=>{
  vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const begin=vi.fn(()=>({ok:true,value:{}})),preview=vi.fn(()=>({ok:true,value:{}})),commit=vi.fn(()=>({ok:true,value:null})),cancel=vi.fn();
  const controller={beginLayerProperties:begin,previewLayerProperties:preview,commitLayerProperties:commit,cancelLayerProperties:cancel,patternLibrary:()=>({ok:true,value:{presets:[]}})} as unknown as EditorWorkspaceController;
  const layer=decodeEditorState({document:{width:16,height:16,layers:[{id:1,name:"A",kind:"pixel",hasMask:true,maskDensity:0.8,maskFeather:3}],activeLayer:1}})!.document!.layers[0];
  let editing:ReturnType<typeof useLayerPropertiesEditing>;function Probe() {editing=useLayerPropertiesEditing(controller,layer,vi.fn(),vi.fn(),false);return null;}
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);act(()=>root.render(<Probe/>));
  act(()=>editing!.maskEditing.update("density","40"));
  act(()=>editing!.blendEditing.finish(false));expect(cancel).not.toHaveBeenCalled();expect(editing!.maskEditing.active).toBe(true);
  act(()=>editing!.maskEditing.update("feather",""));act(()=>expect(editing!.maskEditing.finish(true)).toBe(false));expect(commit).not.toHaveBeenCalled();
  act(()=>editing!.maskEditing.finish(false));expect(editing!.maskEditing.values).toEqual({density:"80",feather:"3"});expect(cancel).toHaveBeenCalledOnce();
  act(()=>editing!.maskEditing.update("density","25"));act(()=>editing!.maskEditing.update("feather","4"));act(()=>expect(editing!.maskEditing.finish(true)).toBe(true));
  expect(preview.mock.lastCall).toEqual([{mask:{density:0.25,feather:4}}]);expect(commit).toHaveBeenCalledOnce();
});
