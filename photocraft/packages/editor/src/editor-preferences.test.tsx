import {subscribeNarrowOptionsBar,subscribeLargeDocumentTabs,subscribeRememberWorkspaceChanges} from "./workspace-layout-memory.js";
/** @vitest-environment jsdom */
import {act,useSyncExternalStore} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {DEFAULT_EDITOR_PREFERENCES,normalizeEditorPreferences,readEditorPreferences,useEditorPreferences,PreferencesDialog} from "./editor-preferences.js";
import type {EditorWorkspaceController} from "./editor-workspace.js";
import type {EditorDialogPort,EditorDialogRegistration,EditorDialogInstance} from "./ports.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";localStorage.clear();vi.restoreAllMocks();});
it("损坏或旧版偏好按字段恢复默认，不接受truthy字符串",()=>{
  expect(normalizeEditorPreferences({useEscapeToCommit:"false",showTransformationValues:false,unknown:true})).toEqual({...DEFAULT_EDITOR_PREFERENCES,showTransformationValues:false});
  localStorage.setItem("photocraft.editor-preferences.v1","{");expect(readEditorPreferences()).toEqual(DEFAULT_EDITOR_PREFERENCES);
});
it("偏好取消不写，确认持久化，重置需要确认；阻塞/卸载关闭宿主弹窗",()=>{
  const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null;
  const port:EditorDialogPort={registerDialog:(id,value)=>{registrations.set(id,value);return ()=>{registrations.delete(id);};},subscribe:fn=>{listeners.add(fn);return ()=>{listeners.delete(fn);};},top:()=>top,isModalActive:()=>!!top,
    open:({dialogId})=>{if(top || !registrations.get(dialogId)?.definition.editingOwner?.()) return {ok:false,error:"blocked"};top={dialogId,instanceId:"1"};listeners.forEach(fn=>fn());return {ok:true,instance:top};},close:()=>{top=null;listeners.forEach(fn=>fn());}};
  const controller={dialogOwner:()=>({canvasId:"c",documentId:"d",sessionId:"s"})} as unknown as EditorWorkspaceController;
  let prefs:ReturnType<typeof useEditorPreferences>;let blocked=false;const error=vi.fn();
  function Probe(){prefs=useEditorPreferences(port,controller,blocked,error);const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);const render=()=>act(()=>root.render(<Probe/>));render();
  const click=(label:string)=>act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent===label)!.click());
  const toggle=()=>act(()=>[...node.querySelectorAll("label")].find(label=>label.textContent==="文字编辑时按 Escape 提交")!.querySelector<HTMLInputElement>("input")!.click());
  const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  act(()=>prefs!.open());toggle();click("取消");expect(prefs!.value.useEscapeToCommit).toBe(true);expect(localStorage.length).toBe(0);
  act(()=>prefs!.open());toggle();submit();expect(prefs!.value.useEscapeToCommit).toBe(false);expect(readEditorPreferences().useEscapeToCommit).toBe(false);
  act(()=>prefs!.open());click("恢复默认值");click("取消");expect(prefs!.value.useEscapeToCommit).toBe(false);
  const changed=vi.fn(),unsubscribe=subscribeRememberWorkspaceChanges(changed);
  const toggleMemory=()=>act(()=>[...node.querySelectorAll("label")].find(label=>label.textContent==="记忆工作区布局变化")!.querySelector<HTMLInputElement>("input")!.click());
  act(()=>prefs!.open());toggleMemory();click("取消");expect(prefs!.value.rememberWorkspaceChanges).toBe(true);expect(changed).not.toHaveBeenCalled();
  act(()=>prefs!.open());toggleMemory();submit();expect(readEditorPreferences().rememberWorkspaceChanges).toBe(false);expect(changed).toHaveBeenLastCalledWith(false);unsubscribe();
  const largeChanged=vi.fn(),stopLarge=subscribeLargeDocumentTabs(largeChanged);
  const toggleLarge=()=>act(()=>[...node.querySelectorAll("label")].find(label=>label.textContent==="大文档标签")!.querySelector<HTMLInputElement>("input")!.click());
  act(()=>prefs!.open());toggleLarge();click("取消");expect(readEditorPreferences().largeDocumentTabs).toBe(false);expect(largeChanged).not.toHaveBeenCalled();
  act(()=>prefs!.open());toggleLarge();submit();expect(readEditorPreferences().largeDocumentTabs).toBe(true);expect(largeChanged).toHaveBeenLastCalledWith(true);stopLarge();
  const narrowChanged=vi.fn(),stopNarrow=subscribeNarrowOptionsBar(narrowChanged);
  const toggleNarrow=()=>act(()=>[...node.querySelectorAll("label")].find(label=>label.textContent==="紧凑工具选项栏")!.querySelector<HTMLInputElement>("input")!.click());
  act(()=>prefs!.open());toggleNarrow();click("取消");expect(readEditorPreferences().narrowOptionsBar).toBe(false);expect(narrowChanged).not.toHaveBeenCalled();
  act(()=>prefs!.open());toggleNarrow();submit();expect(readEditorPreferences().narrowOptionsBar).toBe(true);expect(narrowChanged).toHaveBeenLastCalledWith(true);stopNarrow();
  const notificationChanged=vi.fn();window.addEventListener("photocraft:notification-preferences",notificationChanged);
  const toggleNotifications=()=>act(()=>node.querySelector<HTMLInputElement>('[data-notification-preferences] input[type="checkbox"]')!.click());
  act(()=>prefs!.open());toggleNotifications();click("取消");expect(readEditorPreferences().notifications.autoHide).toBe(true);expect(notificationChanged).not.toHaveBeenCalled();
  act(()=>prefs!.open());toggleNotifications();submit();expect(readEditorPreferences().notifications.autoHide).toBe(false);expect(notificationChanged).toHaveBeenCalledOnce();expect((notificationChanged.mock.lastCall?.[0] as CustomEvent).detail).toEqual({autoHide:false,seconds:6});window.removeEventListener("photocraft:notification-preferences",notificationChanged);
  const animationChanged=vi.fn();window.addEventListener("photocraft:interface-animations",animationChanged);
  const toggleAnimations=()=>act(()=>[...node.querySelectorAll("label")].find(label=>label.textContent==="启用界面动画")!.querySelector<HTMLInputElement>("input")!.click());
  act(()=>prefs!.open());toggleAnimations();click("取消");expect(readEditorPreferences().enableAnimations).toBe(true);expect(animationChanged).not.toHaveBeenCalled();
  act(()=>prefs!.open());toggleAnimations();submit();expect(readEditorPreferences().enableAnimations).toBe(false);expect(animationChanged).toHaveBeenCalledOnce();expect((animationChanged.mock.lastCall?.[0] as CustomEvent).detail).toBe(false);window.removeEventListener("photocraft:interface-animations",animationChanged);
  act(()=>prefs!.open());blocked=true;render();expect(port.top()).toBeNull();act(()=>prefs!.open());expect(port.top()).toBeNull();
  blocked=false;render();act(()=>prefs!.open());act(()=>root.unmount());expect(port.top()).toBeNull();expect(registrations.size).toBe(0);
});

it("历史数量确认前校验，取消不应用，内核失败保留窗口与输入",()=>{
 const apply=vi.fn((_value:typeof DEFAULT_EDITOR_PREFERENCES)=>false),close=vi.fn();const node=document.createElement("div");document.body.append(node);root=createRoot(node);
 act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"p"}} requestClose={close} setBusy={()=>{}} replace={()=>{}} initial={DEFAULT_EDITOR_PREFERENCES} apply={apply}/>));
 const field=node.querySelector<HTMLInputElement>('input[data-numeric-input]')!;
 const input=(value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});
 const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 for(const value of ["","0","1001","1.5"]){input(value);submit();expect(apply).not.toHaveBeenCalled();}
 input("120");submit();expect(apply.mock.lastCall?.[0]).toEqual({...DEFAULT_EDITOR_PREFERENCES,historyStates:120});expect(close).not.toHaveBeenCalled();expect(field.value).toBe("120");
 apply.mockReturnValue(true);submit();expect(close).toHaveBeenCalledOnce();
 expect(normalizeEditorPreferences({historyStates:120}).historyStates).toBe(120);for(const historyStates of [0,1001,1.5,"120",null])expect(normalizeEditorPreferences({historyStates}).historyStates).toBe(50);
});

it("透明网格严格恢复旧/坏偏好，弹窗自定义颜色仅确认后提交",()=>{
 const preferences=normalizeEditorPreferences({transparency:{size:"large",colors:"custom",light:"#AbCdEf",dark:"invalid"}});
 expect(preferences.transparency).toEqual({size:"large",colors:"custom",light:"#abcdef",dark:"#cccccc"});expect(normalizeEditorPreferences({transparency:{size:"huge",colors:"system",light:"red"}}).transparency).toEqual(DEFAULT_EDITOR_PREFERENCES.transparency);
 const apply=vi.fn((_value:typeof DEFAULT_EDITOR_PREFERENCES)=>true),close=vi.fn(),node=document.createElement("div");document.body.append(node);root=createRoot(node);
 act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"p"}} requestClose={close} setBusy={()=>{}} replace={()=>{}} initial={DEFAULT_EDITOR_PREFERENCES} apply={apply}/>));
 const select=node.querySelectorAll<HTMLSelectElement>("fieldset select");act(()=>{select[0].value="large";select[0].dispatchEvent(new Event("change",{bubbles:true}));select[1].value="custom";select[1].dispatchEvent(new Event("change",{bubbles:true}));});
 const color=node.querySelector<HTMLInputElement>('fieldset input[type="color"]')!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(color,"#123456");color.dispatchEvent(new Event("input",{bubbles:true}));});expect(apply).not.toHaveBeenCalled();expect(DEFAULT_EDITOR_PREFERENCES.transparency.light).toBe("#ffffff");
 expect(node.querySelector<HTMLElement>(".photo-editor__transparency-sample")!.style.backgroundSize).toBe("32px 32px");
 act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(apply.mock.lastCall?.[0]).toMatchObject({transparency:{size:"large",colors:"custom",light:"#123456",dark:"#cccccc"}});expect(close).toHaveBeenCalledOnce();
});

it("光标偏好候选仅确认提交，严格解码并独立保留其它偏好",()=>{
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);const apply=vi.fn(()=>true);
 act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"cursor"}} requestClose={()=>{}} setBusy={()=>{}} replace={()=>{}} initial={DEFAULT_EDITOR_PREFERENCES} apply={apply}/>));
 const fields=node.querySelectorAll<HTMLSelectElement>('[data-cursor-preferences] select'),checks=node.querySelectorAll<HTMLInputElement>('[data-cursor-preferences] input');
 act(()=>{fields[0].value="fullSizeTip";fields[0].dispatchEvent(new Event("change",{bubbles:true}));fields[1].value="precise";fields[1].dispatchEvent(new Event("change",{bubbles:true}));checks[0].click();checks[1].click();});
 expect(apply).not.toHaveBeenCalled();expect(DEFAULT_EDITOR_PREFERENCES.cursors.center).toBe(false);
 act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(apply).toHaveBeenCalledWith({...DEFAULT_EDITOR_PREFERENCES,cursors:{painting:"fullSizeTip",center:true,paintingCrosshairOnly:true,other:"precise"}});
});
it("工作区背景候选不提前生效，确认包含自定义色/边界/点纹，默认值不被修改",()=>{
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);const apply=vi.fn((_next:typeof DEFAULT_EDITOR_PREFERENCES)=>true);
 act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"board"}} requestClose={()=>{}} setBusy={()=>{}} replace={()=>{}} initial={DEFAULT_EDITOR_PREFERENCES} apply={apply}/>));
 const fields=node.querySelectorAll<HTMLSelectElement>('[data-pasteboard-preferences] select');
 act(()=>{fields[0].value="custom";fields[0].dispatchEvent(new Event("change",{bubbles:true}));fields[1].value="none";fields[1].dispatchEvent(new Event("change",{bubbles:true}));});
 const color=node.querySelector<HTMLInputElement>('[data-pasteboard-preferences] input[type="color"]')!;
 act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(color,"#123456");color.dispatchEvent(new Event("input",{bubbles:true}));node.querySelector<HTMLInputElement>('[data-pasteboard-preferences] input[type="checkbox"]')!.click();});
 expect(apply).not.toHaveBeenCalled();expect(DEFAULT_EDITOR_PREFERENCES.pasteboard.color).toBe("default");
 act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(apply.mock.lastCall?.[0]).toMatchObject({pasteboard:{color:"custom",custom:"#123456",border:"none",dots:false}});
});
it("字体样例偏好默认中号，关闭和五档严格保存，表单候选仅确认后生效",()=>{
 for(const fontPreview of ["off","small","medium","large","extraLarge","huge"])expect(normalizeEditorPreferences({fontPreview}).fontPreview).toBe(fontPreview);
 for(const fontPreview of [14,40,"Huge",true,null])expect(normalizeEditorPreferences({fontPreview}).fontPreview).toBe("medium");
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);const apply=vi.fn((_next:typeof DEFAULT_EDITOR_PREFERENCES)=>true);
 act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"font"}} requestClose={()=>{}} setBusy={()=>{}} replace={()=>{}} initial={DEFAULT_EDITOR_PREFERENCES} apply={apply}/>));
 const select=[...node.querySelectorAll<HTMLSelectElement>("select")].find(item=>item.parentElement?.textContent?.startsWith("字体菜单样例大小"))!;
 act(()=>{select.value="huge";select.dispatchEvent(new Event("change",{bubbles:true}));});expect(apply).not.toHaveBeenCalled();
 act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(apply.mock.lastCall?.[0]).toMatchObject({fontPreview:"huge"});expect(DEFAULT_EDITOR_PREFERENCES.fontPreview).toBe("medium");
});

it("内存预算候选严格校验、取消无写、失败保留输入，历史和预算一起确认；默认恢复8192",()=>{
  const apply=vi.fn((_value:typeof DEFAULT_EDITOR_PREFERENCES)=>false),close=vi.fn(),node=document.createElement("div");document.body.append(node);root=createRoot(node);
  act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"memory"}} requestClose={close} setBusy={()=>{}} replace={()=>{}} initial={DEFAULT_EDITOR_PREFERENCES} apply={apply}/>));
  const memory=[...node.querySelectorAll("label")].find(label=>label.textContent?.startsWith("每份文档内存预算"))!.querySelector("input")!,history=node.querySelector<HTMLInputElement>('input[data-numeric-input]')!;
  const input=(field:HTMLInputElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});
  const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  for(const value of ["","255","1048577","256.5"]){input(memory,value);submit();expect(apply).not.toHaveBeenCalled();}
  input(memory,"512");input(history,"25");submit();expect(apply).toHaveBeenLastCalledWith({...DEFAULT_EDITOR_PREFERENCES,memoryUsageMb:512,historyStates:25});expect(close).not.toHaveBeenCalled();expect(memory.value).toBe("512");
  apply.mockClear();act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="取消")!.click());expect(apply).not.toHaveBeenCalled();
  act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent==="恢复默认值")!.click());expect(memory.value).toBe("8192");expect(apply).not.toHaveBeenCalled();
  for(const memoryUsageMb of [undefined,"512",255,1048577,256.5,NaN])expect(normalizeEditorPreferences({memoryUsageMb}).memoryUsageMb).toBe(8192);
  expect(normalizeEditorPreferences({memoryUsageMb:256}).memoryUsageMb).toBe(256);
});

it("宿主确认只提交一个性能候选，内核失败不保存也不关闭，重试成功才发布",()=>{
  const registrations=new Map<string,EditorDialogRegistration>(),listeners=new Set<()=>void>();let top:EditorDialogInstance|null=null;
  const port:EditorDialogPort={registerDialog:(id,value)=>{registrations.set(id,value);return()=>{registrations.delete(id);};},subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);};},top:()=>top,isModalActive:()=>!!top,open:({dialogId})=>{top={dialogId,instanceId:"perf"};listeners.forEach(fn=>fn());return {ok:true,instance:top};},close:()=>{top=null;listeners.forEach(fn=>fn());}};
  let accepted=true;const performance=vi.fn((_history:number,_memory:number)=>accepted?{ok:true,value:{}}:{ok:false,code:"gesture-active",message:"操作未结束"}),legacy=vi.fn();
  const controller={dialogOwner:()=>({canvasId:"c",documentId:"d",sessionId:"s"}),setPerformancePreferences:performance,setHistoryLimit:legacy} as unknown as EditorWorkspaceController;
  let preferences!:ReturnType<typeof useEditorPreferences>;const error=vi.fn();
  function Probe(){preferences=useEditorPreferences(port,controller,false,error);const instance=useSyncExternalStore(port.subscribe,port.top);return instance?registrations.get(instance.dialogId)?.renderer({instance,requestClose:()=>port.close(),setBusy:()=>{},replace:()=>{}}):null;}
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);act(()=>root.render(<Probe/>));expect(performance).toHaveBeenLastCalledWith(50,8192);performance.mockClear();
  act(()=>preferences.open());const field=[...node.querySelectorAll("label")].find(label=>label.textContent?.startsWith("每份文档内存预算"))!.querySelector("input")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,"512");field.dispatchEvent(new Event("input",{bubbles:true}));});
  const submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  accepted=false;submit();expect(performance).toHaveBeenLastCalledWith(50,512);expect(legacy).not.toHaveBeenCalled();expect(preferences.value.memoryUsageMb).toBe(8192);expect(port.top()).not.toBeNull();expect(localStorage.getItem("photocraft.editor-preferences.v1")).toBeNull();
  accepted=true;submit();expect(preferences.value.memoryUsageMb).toBe(512);expect(port.top()).toBeNull();expect(readEditorPreferences().memoryUsageMb).toBe(512);expect(performance).toHaveBeenCalledTimes(2);expect(legacy).not.toHaveBeenCalled();
});

it("不暴露ui-egui渲染器专用开关，未知GPU偏好不恢复；本产品的历史/预算仍可用",()=>{
  expect(normalizeEditorPreferences({renderingMode:"cpu",gpuMemoryMb:1024,cacheTileSize:512,useGpu:false,gpuBackend:"cpu"})).toEqual(DEFAULT_EDITOR_PREFERENCES);
  const node=document.createElement("div");document.body.append(node);root=createRoot(node);
  act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"renderer"}} requestClose={()=>{}} setBusy={()=>{}} replace={()=>{}} initial={DEFAULT_EDITOR_PREFERENCES} apply={()=>true}/>));
  expect(node.querySelector('[name="renderingMode"],[name="gpuMemoryMb"],[name="cacheTileSize"]')).toBeNull();
  expect(node.textContent).not.toMatch(/Rendering Mode|GPU Memory|GPU Cache Tile|渲染模式|显存预算|GPU瓦片/);
  expect(node.textContent).toContain("每份文档内存预算");expect(node.textContent).toContain("保留历史状态");
});

it("测量单位与点派卡标准严格恢复，候选仅确认后提交",()=>{
 expect(normalizeEditorPreferences({measurementUnit:"centimeters",pointPicaSize:72.27})).toMatchObject({measurementUnit:"centimeters",pointPicaSize:72.27});expect(normalizeEditorPreferences({measurementUnit:"cm",pointPicaSize:70})).toMatchObject({measurementUnit:"pixels",pointPicaSize:72});
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);const apply=vi.fn(()=>true);
 act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"unit"}} requestClose={()=>{}} setBusy={()=>{}} replace={()=>{}} initial={DEFAULT_EDITOR_PREFERENCES} apply={apply}/>));
 const fields=node.querySelectorAll<HTMLSelectElement>('[data-measurement-preferences] select');act(()=>{fields[0].value="inches";fields[0].dispatchEvent(new Event("change",{bubbles:true}));fields[1].value="72.27";fields[1].dispatchEvent(new Event("change",{bubbles:true}));});expect(apply).not.toHaveBeenCalled();
 act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(apply).toHaveBeenCalledWith({...DEFAULT_EDITOR_PREFERENCES,measurementUnit:"inches",pointPicaSize:72.27});expect(DEFAULT_EDITOR_PREFERENCES.measurementUnit).toBe("pixels");
});

it("通知默认6秒，严格恢复1–120整数，表单候选不提前发布、无效不提交和关闭自动隐藏",()=>{
 expect(normalizeEditorPreferences({notifications:{autoHide:false,seconds:120}}).notifications).toEqual({autoHide:false,seconds:120});
 for(const seconds of [0,121,1.5,"10",null])expect(normalizeEditorPreferences({notifications:{autoHide:"false",seconds}}).notifications).toEqual({autoHide:true,seconds:6});
 const node=document.createElement("div"),apply=vi.fn((_next:typeof DEFAULT_EDITOR_PREFERENCES)=>true),close=vi.fn();root=createRoot(node);act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"notifications"}} requestClose={close} setBusy={()=>{}} replace={()=>{}} initial={DEFAULT_EDITOR_PREFERENCES} apply={apply}/>));
 const field=node.querySelector<HTMLInputElement>('[data-notification-preferences] input[type="number"]')!,checkbox=node.querySelector<HTMLInputElement>('[data-notification-preferences] input[type="checkbox"]')!;
 const input=(value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));}),submit=()=>act(()=>node.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 for(const value of ["","0","121","1.5"]){input(value);submit();expect(apply).not.toHaveBeenCalled();}input("120");expect(apply).not.toHaveBeenCalled();submit();expect(apply.mock.lastCall?.[0]).toMatchObject({notifications:{autoHide:true,seconds:120}});
 apply.mockClear();input("");act(()=>checkbox.click());expect(field.disabled).toBe(true);submit();expect(apply.mock.lastCall?.[0]).toMatchObject({notifications:{autoHide:false,seconds:6}});
});
it("偏好搜索跨分区，应用保持窗口且只重置当前分区；无效隐藏字段也拒绝应用",()=>{
 const node=document.createElement("div");document.body.append(node);root=createRoot(node);const close=vi.fn(),apply=vi.fn(()=>true);
 const initial={...DEFAULT_EDITOR_PREFERENCES,historyStates:120,memoryUsageMb:512,useSmartQuotes:false,enableAnimations:false};
 act(()=>root.render(<PreferencesDialog instance={{dialogId:"prefs",instanceId:"sections"}} requestClose={close} setBusy={()=>{}} replace={()=>{}} initial={initial} apply={apply}/>));
 const click=(label:string)=>act(()=>[...node.querySelectorAll("button")].find(button=>button.textContent===label)!.click());
 const section=(value:string)=>act(()=>{const field=node.querySelector<HTMLSelectElement>('[data-preference-section]')!;field.value=value;field.dispatchEvent(new Event("change",{bubbles:true}));});
 const search=(value:string)=>act(()=>{const field=node.querySelector<HTMLInputElement>('input[type="search"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});
 const groups=()=>[...node.querySelectorAll<HTMLElement>('[data-preference-group]')].filter(group=>!group.hidden).map(group=>group.dataset.preferenceGroup);
 section("performance");expect(groups()).toEqual(["performance"]);search("字体");expect(groups()).toEqual(["type","type"]);expect([...node.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="重置当前分区")!.disabled).toBe(true);
 search("");expect(groups()).toEqual(["performance"]);click("重置当前分区");expect(apply).not.toHaveBeenCalled();click("应用");expect(close).not.toHaveBeenCalled();expect(node.textContent).toContain("偏好设置已应用");expect(apply).toHaveBeenLastCalledWith({...initial,historyStates:50,memoryUsageMb:8192});
 section("type");click("重置当前分区");click("应用");expect(apply).toHaveBeenLastCalledWith({...initial,historyStates:50,memoryUsageMb:8192,useSmartQuotes:true});
 const memory=[...node.querySelectorAll("label")].find(label=>label.textContent?.startsWith("每份文档内存预算"))!.querySelector("input")!;
 act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(memory,"0");memory.dispatchEvent(new Event("input",{bubbles:true}));});const calls=apply.mock.calls.length;click("应用");expect(apply).toHaveBeenCalledTimes(calls);expect(node.textContent).toContain("请检查历史数量");click("取消");expect(close).toHaveBeenCalledOnce();
});
