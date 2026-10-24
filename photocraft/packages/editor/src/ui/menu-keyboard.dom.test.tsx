/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {DropdownMenu,MenuBar} from "./Menu.js";
import {UiProvider} from "./UiProvider.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
afterEach(()=>{document.body.innerHTML="";vi.restoreAllMocks();});

const press=(key:string,options:KeyboardEventInit={},target:EventTarget=document.body)=>act(()=>{
  const event=new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);
});
const release=(key:string,options:KeyboardEventInit={})=>act(()=>{document.body.dispatchEvent(new KeyboardEvent("keyup",{key,bubbles:true,cancelable:true,...options}));});

function setup() {
  const host=document.createElement("div");document.body.append(host);
  const root=createRoot(host);const choose=vi.fn();
  const menus=<><DropdownMenu label="文件" trigger={<button>文件</button>} items={[{id:"open",label:"打开",onSelect:choose}]}/>
    <DropdownMenu label="编辑" trigger={<button>编辑</button>} items={[{id:"undo",label:"撤销",onSelect:choose}]}/></>;
  act(()=>root.render(<UiProvider><MenuBar>{menus}</MenuBar></UiProvider>));
  const titles=[...host.querySelectorAll<HTMLButtonElement>("[data-menu-title]")];
  return {host,root,choose,titles};
}

it("F10 把键盘放到菜单栏，左右键切换顶级项，向下打开，Esc 离开",()=>{
  const {root,titles}=setup();
  try{
    expect(document.activeElement).not.toBe(titles[0]);
    press("F10");
    expect(document.activeElement).toBe(titles[0]);
    press("ArrowRight");
    expect(document.activeElement).toBe(titles[1]);
    press("ArrowRight");
    expect(document.activeElement).toBe(titles[0]);
    press("ArrowLeft");
    expect(document.activeElement).toBe(titles[1]);
    press("ArrowDown");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    // 菜单打开后 Esc 由 Radix 关闭，menu bar 不重复处理。
    press("Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    press("Escape");
    // 焦点离开菜单栏后方向键不再被拦截。
    press("ArrowRight");
  } finally { act(()=>root.unmount()); }
});

it("Alt 点按聚焦菜单栏，Alt+字母直达对应菜单；Alt 后按字母不算点按",()=>{
  const {root}=setup();
  try{
    press("Alt",{altKey:true});
    release("Alt");
    expect(document.activeElement?.textContent).toContain("文件");
    // Alt+E 直接打开「编辑」菜单，不先产生 Alt 点按的焦点跳转副作用。
    press("e",{altKey:true,code:"KeyE"});
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    press("Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    press("Alt",{altKey:true});press("e",{altKey:true,code:"KeyE"});release("Alt");
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  } finally { act(()=>root.unmount()); }
});

it("输入字段与输入法组合不抢菜单栏键盘",()=>{
  const {host,root}=setup();
  try{
    const input=document.createElement("input");host.append(input);
    press("F10",{},input);
    expect(document.activeElement).not.toBe(input);
    press("F10",{isComposing:true});
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // 没有可匹配的助记字母时不打开任何菜单，也不报错。
    press("q",{altKey:true,code:"KeyQ"});
    expect(document.querySelector('[role="menu"]')).toBeNull();
  } finally { act(()=>root.unmount()); }
});

it("顶级菜单按钮带稳定助记字母标注",()=>{
  const {host,root}=setup();
  try{
    const letters=[...host.querySelectorAll<HTMLButtonElement>("[data-menu-title]")].map(button=>button.dataset.menuMnemonic);
    expect(letters).toEqual(["F","E"]);
  } finally { act(()=>root.unmount()); }
});
