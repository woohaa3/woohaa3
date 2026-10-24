/** @vitest-environment jsdom */
import {expect,it} from "vitest";
import {AltTap,menuMnemonic,moveMenuFocus,resolveMenuBarKey} from "./menu-keyboard.js";

const key=(patch:Partial<{key:string;code:string;altKey:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean}>={})=>({key:"",code:"",altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,...patch});

it("顶级菜单助记字母沿用上游习惯，纯中文未知菜单不伪造字母",()=>{
  expect(menuMnemonic("文件")).toBe("F");
  expect(menuMnemonic("编辑")).toBe("E");
  expect(menuMnemonic("图像")).toBe("I");
  expect(menuMnemonic("图层")).toBe("L");
  expect(menuMnemonic("文字")).toBe("Y");
  expect(menuMnemonic("选择")).toBe("S");
  expect(menuMnemonic("视图")).toBe("V");
  expect(menuMnemonic("窗口")).toBe("W");
  expect(menuMnemonic("帮助")).toBe("H");
  expect(menuMnemonic("Insert")).toBe("I");
  expect(menuMnemonic("关于")).toBeNull();
  expect(menuMnemonic("")).toBeNull();
});

it("左右键在顶级项间循环，越界钳制而非跳过",()=>{
  expect(moveMenuFocus(0,5,1)).toBe(1);
  expect(moveMenuFocus(4,5,1)).toBe(0);
  expect(moveMenuFocus(0,5,-1)).toBe(4);
  expect(moveMenuFocus(-1,5,1)).toBe(0);
  expect(moveMenuFocus(-1,5,-1)).toBe(4);
  expect(moveMenuFocus(9,5,1)).toBe(0);
  expect(moveMenuFocus(0,0,1)).toBe(-1);
});

it("F10 与 Alt+字母解析为焦点/直达，菜单内部按键交给 Radix",()=>{
  // F10：未聚焦时聚焦第一项，已聚焦时离开。
  expect(resolveMenuBarKey(key({key:"F10"}),false,false)).toEqual({kind:"focus",index:0});
  expect(resolveMenuBarKey(key({key:"F10"}),true,false)).toEqual({kind:"leave"});
  // 已展开的菜单：除了 F10，其他按键都不拦截。
  for(const entry of [key({key:"ArrowRight"}),key({key:"Escape"}),key({key:"Enter"}),key({key:"a",code:"KeyA",altKey:true})])
    expect(resolveMenuBarKey(entry,true,true)).toEqual({kind:"ignore"});
  // 未聚焦时方向键不属于菜单栏。
  expect(resolveMenuBarKey(key({key:"ArrowRight"}),false,false)).toEqual({kind:"ignore"});
  // 聚焦后左右切换、向下/Enter/空格打开、Escape 离开。
  expect(resolveMenuBarKey(key({key:"ArrowRight"}),true,false)).toEqual({kind:"move",delta:1});
  expect(resolveMenuBarKey(key({key:"ArrowLeft"}),true,false)).toEqual({kind:"move",delta:-1});
  for(const entry of [key({key:"ArrowDown"}),key({key:"Enter"}),key({key:" "})])
    expect(resolveMenuBarKey(entry,true,false)).toEqual({kind:"open"});
  expect(resolveMenuBarKey(key({key:"Escape"}),true,false)).toEqual({kind:"leave"});
  // Alt+字母：字母来自物理键码，避开输入法组合。
  expect(resolveMenuBarKey(key({key:"f",code:"KeyF",altKey:true}),false,false)).toEqual({kind:"mnemonic",letter:"F"});
  expect(resolveMenuBarKey(key({key:"f",code:"KeyF",altKey:true}),true,false)).toEqual({kind:"mnemonic",letter:"F"});
  // 输入法组合与 229 一律不处理；Mod+Alt（宿主快捷键）也不进菜单栏。
  expect(resolveMenuBarKey({...key({key:"F10"}),isComposing:true},false,false)).toEqual({kind:"ignore"});
  expect(resolveMenuBarKey({...key({key:"F10"}),keyCode:229},false,false)).toEqual({kind:"ignore"});
  expect(resolveMenuBarKey(key({key:"f",code:"KeyF",altKey:true,ctrlKey:true}),false,false)).toEqual({kind:"ignore"});
  expect(resolveMenuBarKey(key({key:"f",code:"KeyF",altKey:true,shiftKey:true}),false,false)).toEqual({kind:"ignore"});
});

it("Alt 点按只在按下后未按其他键就松开时成立",()=>{
  const tap=new AltTap();
  tap.keydown({key:"Alt"});expect(tap.keyup({key:"Alt"})).toBe(true);
  // 按住 Alt 又按字母：不是点按。
  tap.keydown({key:"Alt"});tap.keydown({key:"f"});expect(tap.keyup({key:"Alt"})).toBe(false);
  // 重复的 Alt keydown 不重置判定。
  tap.keydown({key:"Alt"});tap.keydown({key:"Alt",repeat:true});expect(tap.keyup({key:"Alt"})).toBe(true);
  // 没有按下就松开不算。
  expect(tap.keyup({key:"Alt"})).toBe(false);
  // reset 丢弃未完成的按下。
  tap.keydown({key:"Alt"});tap.reset();expect(tap.keyup({key:"Alt"})).toBe(false);
});
