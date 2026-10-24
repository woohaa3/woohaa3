/** @vitest-environment jsdom */
import {act} from "react";import {createRoot,type Root} from "react-dom/client";import {afterEach,expect,it,vi} from "vitest";
import {EditorThemeRoot,useEditorTheme,themedEditorDialogs,decodeThemePreference,stepThemeBrightness,themeStyle,EDITOR_THEMES} from "./editor-theme.js";
import type {EditorDialogPort,EditorDialogRegistration,EditorDialogRendererProps} from "./ports.js";
import {DropdownMenu} from "./ui/Menu.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const roots:Root[]=[];afterEach(()=>{act(()=>roots.splice(0).forEach(root=>root.unmount()));document.body.innerHTML="";localStorage.clear();vi.unstubAllGlobals();vi.restoreAllMocks();});
function mount(element:React.ReactNode){const host=document.createElement("div");document.body.append(host);const root=createRoot(host);roots.push(root);act(()=>root.render(element));return {host,root};}
it("损坏偏好逐字段回退；Pro四档夹紧，其他主题按实际深浅进入对应档位",()=>{
 expect(decodeThemePreference({theme:"bad",darkTheme:"proLight",lightTheme:"studio"})).toEqual({theme:"system",darkTheme:"proMedium",lightTheme:"proLight"});
 expect(stepThemeBrightness("studio",false)).toBe("pro");expect(stepThemeBrightness("classic",true)).toBe("proLight");expect(stepThemeBrightness("pro",false)).toBe("pro");expect(stepThemeBrightness("proLight",true)).toBe("proLight");
 expect(EDITOR_THEMES).toHaveLength(14);expect(themeStyle("proMedium")).toHaveProperty("--app-web-panel","#535353");expect(themeStyle("proLight")).toHaveProperty("--app-web-panel","#f0f0f0");expect(themeStyle("solarizedDark")).toHaveProperty("--app-interaction-accent","#268bd2");
});
it("跟随系统保留最近深浅配色；切换实时同步多个局部根，卸载清理监听且不改宿主变量",()=>{
 const media=new EventTarget() as EventTarget&{matches:boolean};media.matches=true;vi.stubGlobal("matchMedia",()=>media);
 let control!:ReturnType<typeof useEditorTheme>;function Controls(){control=useEditorTheme();return <span/>;}
 document.documentElement.style.setProperty("--app-web-panel","host-panel");
 const a=mount(<EditorThemeRoot><Controls/></EditorThemeRoot>),b=mount(<EditorThemeRoot dialog><span>对话框</span></EditorThemeRoot>);
 const theme=(host:Element)=>host.querySelector<HTMLElement>("[data-editor-theme]")!;
 expect(theme(a.host).dataset.editorTheme).toBe("proMedium");
 act(()=>control.select("studio"));expect(theme(b.host).dataset.editorTheme).toBe("studio");expect(localStorage.getItem("photocraft.interface-theme.v1")).toContain('"darkTheme":"studio"');
 act(()=>control.select("system"));act(()=>{media.matches=false;media.dispatchEvent(new Event("change"));});expect(theme(a.host).dataset.editorTheme).toBe("proLight");
 act(()=>{media.matches=true;media.dispatchEvent(new Event("change"));});expect(theme(b.host).dataset.editorTheme).toBe("studio");
 expect(document.documentElement.style.getPropertyValue("--app-web-panel")).toBe("host-panel");
 act(()=>window.dispatchEvent(new StorageEvent("storage",{key:"photocraft.interface-theme.v1"})));expect(theme(a.host).dataset.editorTheme).toBe("studio");
});
it("菜单portal与宿主注册的对话框renderer继承局部配色，不改变弹窗栈调用",async()=>{
 let registration!:EditorDialogRegistration;const unregister=vi.fn(),open=vi.fn(()=>({ok:false as const,error:"blocked"}));
 const port:EditorDialogPort={registerDialog:(_id,value)=>{registration=value;return unregister;},open,close:vi.fn(),top:()=>null,subscribe:()=>()=>{},isModalActive:()=>false};
 const decorated=themedEditorDialogs(port);const cleanup=decorated.registerDialog("test",{definition:{validatePayload:()=>({ok:true,payload:null})},renderer:()=> <DropdownMenu label="Test" trigger={<button>菜单</button>} items={[{id:"x",label:"菜单项",onSelect:()=>{}}]}/>});
 const props:EditorDialogRendererProps={instance:{instanceId:"i",dialogId:"test"},requestClose:vi.fn(),setBusy:vi.fn(),replace:vi.fn()};
 const {host}=mount(registration.renderer(props));const button=host.querySelector("button")!;
 await act(async()=>button.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,button:0})));
 const content=document.querySelector('[role="menu"]');expect(content).not.toBeNull();expect(content!.closest("[data-editor-theme]")).toBe(host.querySelector("[data-editor-theme]"));
 expect(decorated.open({dialogId:"test"})).toEqual({ok:false,error:"blocked"});expect(open).toHaveBeenCalledOnce();cleanup();expect(unregister).toHaveBeenCalledOnce();
});
it("本机存储拒绝时仍应用当前会话配色并给出保存失败提示",()=>{
 let control!:ReturnType<typeof useEditorTheme>;function Controls(){control=useEditorTheme();return null;}mount(<Controls/>);
 vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("denied");});act(()=>control.select("classic"));expect(control.resolved).toBe("classic");expect(control.error).toContain("无法保存");
});
it("界面动画策略同步编辑器与对话框/portal，坏存储恢复默认且卸载清理监听",async()=>{
 const {publishInterfaceAnimations,readInterfaceAnimations}=await import("./interface-animations.js");
 localStorage.setItem("photocraft.editor-preferences.v1",JSON.stringify({enableAnimations:false}));
 const a=mount(<EditorThemeRoot><DropdownMenu label="Test" trigger={<button>菜单</button>} items={[{id:"x",label:"菜单项",onSelect:()=>{}}]}/></EditorThemeRoot>),b=mount(<EditorThemeRoot dialog><span>对话框</span></EditorThemeRoot>);
 const motion=(host:Element)=>host.querySelector<HTMLElement>("[data-editor-animations]")!.dataset.editorAnimations;
 expect(motion(a.host)).toBe("off");expect(motion(b.host)).toBe("off");
 await act(async()=>a.host.querySelector("button")!.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true,button:0})));
 expect(document.querySelector('[role="menu"]')!.closest('[data-editor-animations="off"]')).not.toBeNull();
 act(()=>publishInterfaceAnimations(true));expect(motion(a.host)).toBe("on");expect(motion(b.host)).toBe("on");
 act(()=>window.dispatchEvent(new CustomEvent("photocraft:interface-animations",{detail:"false"})));expect(motion(a.host)).toBe("on");
 localStorage.setItem("photocraft.editor-preferences.v1",JSON.stringify({enableAnimations:"false"}));expect(readInterfaceAnimations()).toBe(true);
 localStorage.setItem("photocraft.editor-preferences.v1",JSON.stringify({enableAnimations:false}));act(()=>window.dispatchEvent(new StorageEvent("storage",{key:"photocraft.editor-preferences.v1"})));expect(motion(b.host)).toBe("off");
 localStorage.clear();act(()=>window.dispatchEvent(new StorageEvent("storage",{key:null})));expect(motion(b.host)).toBe("on");
 const remove=vi.spyOn(window,"removeEventListener");act(()=>a.root.unmount());expect(remove).toHaveBeenCalledWith("photocraft:interface-animations",expect.any(Function));
});
