/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {editorDisplayLayout,useEditorDisplay,type EditorDisplayControls} from "./editor-display.js";
import {DEFAULT_PANEL_LAYOUT,PANEL_LAYOUT_KEY} from "./editor-panel-layout.js";
import {EDITOR_PREFERENCES_KEY,WORKSPACE_VISIBILITY_KEY,readNarrowOptionsBar,publishNarrowOptionsBar,readLargeDocumentTabs,publishLargeDocumentTabs,publishRememberWorkspaceChanges} from "./workspace-layout-memory.js";
let root:Root|undefined;
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{act(()=>root?.unmount());root=undefined;localStorage.clear();});
it("关闭时不恢复/保存，当前布局不跳变；开启后保存本次布局和面板显隐",()=>{
 const node=document.createElement("div");let display:EditorDisplayControls;
 function Probe(){display=useEditorDisplay();return null;}
 const mount=()=>{root=createRoot(node);act(()=>root!.render(<Probe/>));};
 mount();act(()=>{display!.updatePanels!({width:410,floating:true,x:64,layersCollapsed:true});display!.toggle("navigator");display!.toggle("tools");});
 const saved=localStorage.getItem(PANEL_LAYOUT_KEY),visibility=localStorage.getItem(WORKSPACE_VISIBILITY_KEY);
 expect(JSON.parse(saved!)).toMatchObject({width:410,floating:true,x:64,layersCollapsed:true});
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({rememberWorkspaceChanges:false}));act(()=>publishRememberWorkspaceChanges(false));
 expect(display!.state.panelLayout!.width).toBe(410);act(()=>{display!.updatePanels!({width:460});display!.toggle("histogram");});
 expect(localStorage.getItem(PANEL_LAYOUT_KEY)).toBe(saved);expect(localStorage.getItem(WORKSPACE_VISIBILITY_KEY)).toBe(visibility);
 act(()=>root!.unmount());mount();expect(display!.state.panelLayout).toEqual(DEFAULT_PANEL_LAYOUT);expect(display!.state.navigatorVisible).toBe(false);expect(display!.state.toolsVisible).toBe(true);
 act(()=>display!.updatePanels!({width:350}));expect(localStorage.getItem(PANEL_LAYOUT_KEY)).toBe(saved);
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({rememberWorkspaceChanges:true}));act(()=>publishRememberWorkspaceChanges(true));expect(display!.state.panelLayout!.width).toBe(350);expect(JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY)!)).toMatchObject({width:350});
 act(()=>{display!.toggle("info");display!.toggle("tools");display!.toggle("panels");});act(()=>root!.unmount());mount();expect(display!.state.infoVisible).toBe(true);expect(display!.state.toolsVisible).toBe(false);expect(display!.state.optionsVisible).toBe(true);expect(display!.state.sidebarVisible).toBe(true);
});
it("跨窗口偏好变更停止保存，损坏布尔回默认，锁存/全屏状态不写入布局",()=>{
 const node=document.createElement("div");let display:EditorDisplayControls;
 function Probe(){display=useEditorDisplay();return null;}
 root=createRoot(node);act(()=>root!.render(<Probe/>));act(()=>{display!.toggleStickyModifier!("shift");display!.updatePanels!({width:380});});
 const saved=localStorage.getItem(PANEL_LAYOUT_KEY);expect(localStorage.getItem(WORKSPACE_VISIBILITY_KEY)).not.toContain("stickyModifiers");
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({rememberWorkspaceChanges:false}));act(()=>window.dispatchEvent(new StorageEvent("storage",{key:EDITOR_PREFERENCES_KEY})));act(()=>display!.updatePanels!({width:420}));expect(localStorage.getItem(PANEL_LAYOUT_KEY)).toBe(saved);
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({rememberWorkspaceChanges:"false"}));act(()=>window.dispatchEvent(new StorageEvent("storage",{key:EDITOR_PREFERENCES_KEY})));expect(JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY)!)).toMatchObject({width:420});
});

it("宿主控制显示时，未使用的本地display不覆盖布局或重新启用时的设置",()=>{
 const node=document.createElement("div");let display:EditorDisplayControls;
 function Probe(){display=useEditorDisplay();useEditorDisplay(undefined,undefined,false);return null;}
 root=createRoot(node);act(()=>root!.render(<Probe/>));act(()=>{display!.updatePanels!({width:440});display!.toggle("navigator");});
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({rememberWorkspaceChanges:false}));act(()=>publishRememberWorkspaceChanges(false));act(()=>display!.updatePanels!({width:460}));
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({rememberWorkspaceChanges:true}));act(()=>publishRememberWorkspaceChanges(true));
 expect(JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY)!)).toMatchObject({width:460});expect(JSON.parse(localStorage.getItem(WORKSPACE_VISIBILITY_KEY)!)).toMatchObject({navigatorVisible:true});
});

it("大标签严格恢复并同步本地/跨窗口偏好，重复值和闲置display不触发布局",()=>{
 for(const largeDocumentTabs of [false,"true",1,null]){localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({largeDocumentTabs}));expect(readLargeDocumentTabs()).toBe(false);}
 localStorage.setItem(EDITOR_PREFERENCES_KEY,"{");expect(readLargeDocumentTabs()).toBe(false);
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({largeDocumentTabs:true,rememberWorkspaceChanges:false}));
 const node=document.createElement("div"),before=vi.fn(),unusedBefore=vi.fn();let display!:EditorDisplayControls,unused!:EditorDisplayControls;
 function Probe(){display=useEditorDisplay(before);unused=useEditorDisplay(unusedBefore,undefined,false);return null;}
 root=createRoot(node);act(()=>root!.render(<Probe/>));expect(display.state.largeDocumentTabs).toBe(true);
 const panels=display.state.panelLayout;
 act(()=>publishLargeDocumentTabs(false));expect(display.state.largeDocumentTabs).toBe(false);expect(unused.state.largeDocumentTabs).toBe(true);expect(before).toHaveBeenCalledTimes(1);expect(unusedBefore).not.toHaveBeenCalled();expect(display.state.panelLayout).toBe(panels);
 act(()=>publishLargeDocumentTabs(false));expect(before).toHaveBeenCalledTimes(1);
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({largeDocumentTabs:true}));act(()=>window.dispatchEvent(new StorageEvent("storage",{key:EDITOR_PREFERENCES_KEY})));expect(display.state.largeDocumentTabs).toBe(true);expect(before).toHaveBeenCalledTimes(2);
 localStorage.removeItem(EDITOR_PREFERENCES_KEY);act(()=>window.dispatchEvent(new StorageEvent("storage",{key:null})));expect(display.state.largeDocumentTabs).toBe(false);expect(before).toHaveBeenCalledTimes(3);
});

it("紧凑选项栏只改变可见栏高度，隐藏/全屏不误保存视口，偏好严格且独立同步",()=>{
 for(const narrowOptionsBar of [false,"true",1,null]){localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({narrowOptionsBar}));expect(readNarrowOptionsBar()).toBe(false);}
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({narrowOptionsBar:true}));
 const before=vi.fn(),idleBefore=vi.fn(),node=document.createElement("div");let display!:EditorDisplayControls,idle!:EditorDisplayControls;
 const windowPort={isFullscreen:()=>true,requestFullscreen:async()=>{},exitFullscreen:async()=>{},subscribe:()=>()=>{}};
 function Probe(){display=useEditorDisplay(before,windowPort);idle=useEditorDisplay(idleBefore,undefined,false);return null;}
 root=createRoot(node);act(()=>root!.render(<Probe/>));expect(editorDisplayLayout(display.state).toolbar).toBe(88);
 act(()=>publishNarrowOptionsBar(false));expect(editorDisplayLayout(display.state).toolbar).toBe(96);expect(before).toHaveBeenCalledTimes(1);expect(idle.state.narrowOptionsBar).toBe(true);expect(idleBefore).not.toHaveBeenCalled();
 act(()=>publishNarrowOptionsBar(false));expect(before).toHaveBeenCalledTimes(1);
 act(()=>display.toggle("options"));expect(editorDisplayLayout(display.state).toolbar).toBe(44);before.mockClear();
 act(()=>publishNarrowOptionsBar(true));expect(before).not.toHaveBeenCalled();expect(editorDisplayLayout(display.state).toolbar).toBe(44);
 act(()=>display.toggle("options"));expect(editorDisplayLayout(display.state).toolbar).toBe(88);before.mockClear();
 localStorage.setItem(EDITOR_PREFERENCES_KEY,JSON.stringify({narrowOptionsBar:false}));act(()=>window.dispatchEvent(new StorageEvent("storage",{key:EDITOR_PREFERENCES_KEY})));expect(editorDisplayLayout(display.state).toolbar).toBe(96);expect(before).toHaveBeenCalledTimes(1);
 act(()=>display.setScreenMode!("fullScreen"));before.mockClear();act(()=>publishNarrowOptionsBar(true));expect(before).not.toHaveBeenCalled();expect(editorDisplayLayout(display.state).toolbar).toBe(0);
});
