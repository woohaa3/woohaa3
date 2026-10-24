import { describe, expect, it } from "vitest";
import { FILL_SHORTCUTS, nudgeTarget, resolveEditorShortcut, shortcutLabel, commandShortcutLabel } from "./photo-editor-shortcuts.js";
function key(key: string, overrides: Partial<KeyboardEvent> = {}, isMac = false) {
  return resolveEditorShortcut({ key, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...overrides }, isMac);
}

it("填充使用同一平台组合定义，Shift 保透明；历史填充独立路由，拒绝混合系统修饰键", () => {
  for (const mac of [false,true]) for (const entry of FILL_SHORTCUTS) {
    const modifiers = {altKey:entry.alt,shiftKey:entry.shift,...(mac ? {metaKey:entry.mod} : {ctrlKey:entry.mod})};
    expect(key("Backspace",modifiers,mac)).toEqual({kind:"command",id:entry.id});
    if (mac) expect(key("Delete",modifiers,mac)).toEqual({kind:"command",id:entry.id});
    expect(key("Backspace",{...modifiers,isComposing:true},mac)).toBeNull();
    expect(key("Backspace",{...modifiers,keyCode:229},mac)).toBeNull();
    expect(shortcutLabel(entry.label,mac)).toContain(mac ? "Delete" : "Backspace");
  }
  expect(key("Backspace",{ctrlKey:true,altKey:true})).toEqual({kind:"command",id:"edit.fillHistory"});
  expect(key("Backspace",{ctrlKey:true},true)).toBeNull();
  expect(key("Backspace",{metaKey:true})).toBeNull();
  expect(key("Backspace",{altKey:true,metaKey:true},true)).toEqual({kind:"command",id:"edit.fillHistory"});
});
describe("图片编辑快捷键", () => {
  it("显示快捷键按平台分派，H切换手形，额外修饰键不触发",()=>{
    expect(key("h",{ctrlKey:true})).toEqual({kind:"display",action:"extras"});
    expect(key("h",{metaKey:true},true)).toEqual({kind:"display",action:"extras"});
    expect(key("Tab")).toEqual({kind:"display",action:"panels"});
    expect(key("Tab",{shiftKey:true})).toEqual({kind:"display",action:"sidebar"});
    expect(key("h")).toEqual({kind:"tool",tool:"pan",cycle:false});expect(key("h",{ctrlKey:true,shiftKey:true})).toBeNull();
    expect(key("Tab",{ctrlKey:true})).toEqual({kind:"documentCycle",direction:1});expect(key("Tab",{altKey:true})).toBeNull();
    expect(key("Tab",{isComposing:true})).toBeNull();
  });
  it.each([["m", "marquee"], ["l", "lasso"], ["v", "move"], ["b", "brush"], ["e", "eraser"], ["t", "text"]])("%s 切换到 %s", (letter, tool) => {
    expect(key(letter)).toEqual({ kind: "tool", tool, cycle: false });
  });
  it("Shift+M 轮换选框；方括号与 Shift 方括号分别调整大小和硬度", () => {
    expect(key("M", { shiftKey: true })).toMatchObject({ tool: "marquee", cycle: true });
    expect(key("[", { code: "BracketLeft" })).toMatchObject({ kind: "brush", property: "size", direction: -1 });
    expect(key("}", { code: "BracketRight", shiftKey: true })).toMatchObject({ kind: "brush", property: "hardness", direction: 1 });
    expect(key("]", { code: "BracketRight", ctrlKey: true })).toEqual({ kind: "command", id: "layer.arrange.bringForward" });
  });
  it("Mac 使用 Cmd，Windows/Linux 使用 Ctrl；修饰键不会误触工具", () => {
    expect(key("z", { metaKey: true }, true)).toEqual({ kind: "command", id: "edit.undo" });
    expect(key("Z", { ctrlKey: true, shiftKey: true })).toEqual({ kind: "command", id: "edit.redo" });
    expect(key("b", { metaKey: true }, true)).toBeNull();
    expect(key("z", { ctrlKey: true }, true)).toBeNull();
    expect(key("z", { metaKey: true })).toBeNull();
    expect(key("b", { altKey: true })).toBeNull();
    expect(shortcutLabel("Mod+Shift+Z", true)).toBe("⌘+Shift+Z");
    expect(shortcutLabel("Mod+S", false)).toBe("Ctrl+S");
  });
  it("选区、图层与保存使用 PhotoCraft / Photoshop 常用组合", () => {
    expect(key("t", { ctrlKey: true })).toEqual({ kind: "tool", tool: "transform", cycle: false });
    expect(key("t", { metaKey: true }, true)).toEqual({ kind: "tool", tool: "transform", cycle: false });
    expect(key("Enter")).toEqual({ kind: "confirm" });
    expect(key("d", { ctrlKey: true })).toEqual({ kind: "command", id: "select.deselect" });
    expect(key("D", { ctrlKey: true, shiftKey: true })).toEqual({ kind: "command", id: "select.reselect" });
    expect(key("I", { ctrlKey: true, shiftKey: true })).toEqual({ kind: "command", id: "select.inverse" });
    expect(key("j", { ctrlKey: true })).toEqual({ kind: "command", id: "layer.new.layerViaCopy" });
    expect(key("s", { ctrlKey: true })).toEqual({ kind: "save" });
    expect(key("Delete")).toEqual({ kind: "delete" });
    expect(key("e", {ctrlKey:true})).toEqual({kind:"command",id:"layer.mergeLayers"});
  });
  it("缩放与实际大小是视图动作；未支持的组合与 IME 不处理", () => {
    expect(key("+", { ctrlKey: true, shiftKey: true })).toEqual({ kind: "view", action: "zoomIn" });
    expect(key("0", { ctrlKey: true })).toEqual({ kind: "view", action: "fit" });
    expect(key("1", { ctrlKey: true })).toEqual({ kind: "view", action: "actualSize" });
    expect(key("f", { ctrlKey: true })).toBeNull();
    expect(key("h")).toEqual({kind:"tool",tool:"pan",cycle:false});
    expect(key("b", { isComposing: true })).toBeNull();
    expect(key("b", { keyCode: 229 })).toBeNull();
  });
});

it("方向键使用源像素，Shift 增至 10px，输入法和平台修饰键不混入微移", () => {
  expect(key("ArrowLeft")).toEqual({kind:"nudge",dx:-1,dy:0});
  expect(key("ArrowDown",{shiftKey:true})).toEqual({kind:"nudge",dx:0,dy:10});
  expect(key("ArrowRight",{ctrlKey:true})).toEqual({kind:"nudge",dx:1,dy:0,pixels:true});
  expect(key("ArrowUp",{altKey:true})).toEqual({kind:"nudge",dx:0,dy:-1,duplicate:true});
  expect(key("ArrowDown",{isComposing:true})).toBeNull();
});

it("数字、Shift 数字和 X/D 与平台快捷键分离，不误用带修饰键的输入", () => {
  expect(key("5")).toEqual({kind:"paintPercent",property:"opacity",digit:5});
  expect(key("%",{code:"Digit5",shiftKey:true})).toEqual({kind:"paintPercent",property:"flow",digit:5});
  expect(key("x")).toEqual({kind:"color",action:"swap"});
  expect(key("d")).toEqual({kind:"color",action:"reset"});
  expect(key("x",{ctrlKey:true})).toEqual({kind:"command",id:"edit.cut"});
  expect(key("5",{altKey:true})).toBeNull();
  expect(key("5",{isComposing:true})).toBeNull();
});

it("剪贴切换使用 Ctrl/Cmd+Alt/Option+G，保留平台、IME 和其他 Alt 组合隔离",()=>{
  expect(shortcutLabel("Mod+Alt+G",true)).toBe("⌘+Option+G");
  expect(key("g",{ctrlKey:true,altKey:true})).toEqual({kind:"clipping"});
  expect(key("©",{code:"KeyG",metaKey:true,altKey:true},true)).toEqual({kind:"clipping"});
  expect(key("g",{altKey:true})).toBeNull();
  expect(key("g",{ctrlKey:true,altKey:true,shiftKey:true})).toBeNull();
  expect(key("g",{metaKey:true,altKey:true})).toBeNull();
  expect(key("g",{ctrlKey:true,altKey:true,isComposing:true})).toBeNull();
  expect(key("z",{ctrlKey:true,altKey:true})).toEqual({kind:"command",id:"edit.toggleLastState"});
});

it("图层导航按物理标点键匹配 Option 布局；扩展选择、批量显隐与历史切换保留平台和 IME 门禁",()=>{
  for(const mac of [false,true]) {
    for(const [code,shiftKey,id] of [
      ["BracketRight",false,"layer.selectAbove"],["BracketLeft",false,"layer.selectBelow"],
      ["Period",false,"layer.selectTop"],["Comma",false,"layer.selectBottom"],
      ["BracketRight",true,"layer.addAboveToSelection"],["BracketLeft",true,"layer.addBelowToSelection"]] as const) {
      const modifiers={code,shiftKey,altKey:true};
      expect(key("ø",modifiers,mac)).toEqual({kind:"command",id});
      expect(key("ø",{...modifiers,isComposing:true},mac)).toBeNull();
      expect(key("ø",{...modifiers,...(mac?{metaKey:true}:{ctrlKey:true})},mac)).toBeNull();
      expect(commandShortcutLabel(id)).toContain(shortcutLabel("Alt"));
    }
    const platform=mac?{metaKey:true}:{ctrlKey:true};
    expect(key("≤",{...platform,code:"Comma"},mac)).toEqual({kind:"command",id:"layer.hideLayers"});
    expect(key("Ω",{...platform,code:"KeyZ",altKey:true},mac)).toEqual({kind:"command",id:"edit.toggleLastState"});
  }
  expect(key(".",{altKey:true,shiftKey:true})).toBeNull();
});


it("内部剪贴板快捷键区分合并复制和原位粘贴，IME 不触发",()=>{
  for(const mac of [false,true]) for(const [letter,shift,id] of [
    ["c",false,"edit.copy"],["c",true,"edit.copyMerged"],["x",false,"edit.cut"],
    ["v",false,"edit.paste"],["v",true,"edit.pasteSpecial.pasteInPlace"]] as const) {
    const modifiers={shiftKey:shift,...(mac?{metaKey:true}:{ctrlKey:true})};
    expect(key(letter,modifiers,mac)).toEqual({kind:"command",id});
    expect(key(letter,{...modifiers,isComposing:true},mac)).toBeNull();
  }
});

it("编组和取消编组采用平台 G 组合，与剪贴蒙版及 IME 分离",()=>{
  for(const mac of [false,true]) for(const [shiftKey,id] of [[false,"layer.groupLayers"],[true,"layer.ungroupLayers"]] as const) {
    const modifiers={shiftKey,...(mac?{metaKey:true}:{ctrlKey:true})};
    expect(key("g",modifiers,mac)).toEqual({kind:"command",id});
    expect(key("g",{...modifiers,isComposing:true},mac)).toBeNull();
  }
  expect(key("g")).toMatchObject({kind:"tool",tool:"bucket"});
  expect(commandShortcutLabel("layer.groupLayers")).toBe(shortcutLabel("Mod+G"));
  expect(commandShortcutLabel("layer.ungroupLayers")).toBe(shortcutLabel("Mod+Shift+G"));
});

it("通过剪切新建图层有独立 Mod+Shift+J，普通 Mod+J 继续复制",()=>{
  expect(key("j",{ctrlKey:true,shiftKey:true})).toEqual({kind:"command",id:"layer.new.layerViaCut"});
  expect(key("j",{ctrlKey:true})).toEqual({kind:"command",id:"layer.new.layerViaCopy"});
});

it("Shift加减循环混合模式，保留Mod缩放与IME；查找/全选图层使用平台组合",()=>{
  expect(key("+",{shiftKey:true,code:"Equal"})).toEqual({kind:"blendCycle",direction:1});expect(key("_",{shiftKey:true,code:"Minus"})).toEqual({kind:"blendCycle",direction:-1});
  expect(key("+",{ctrlKey:true,shiftKey:true})).toEqual({kind:"view",action:"zoomIn"});expect(key("+",{shiftKey:true,isComposing:true})).toBeNull();
  expect(key("a",{ctrlKey:true,altKey:true})).toEqual({kind:"command",id:"select.allLayers"});expect(key("f",{metaKey:true,altKey:true,shiftKey:true},true)).toEqual({kind:"command",id:"select.findLayers"});
});

it("微移保留平台 Cmd/Ctrl、Alt复制与Shift步长，输入法不会启动",()=>{
  for(const mac of [false,true]) {
    const modifiers=mac?{metaKey:true}:{ctrlKey:true};
    expect(key("ArrowDown",{...modifiers,altKey:true,shiftKey:true},mac)).toEqual({kind:"nudge",dx:0,dy:10,pixels:true,duplicate:true});
    expect(key("ArrowDown",{...modifiers,isComposing:true},mac)).toBeNull();
  }
});

it("微移目标由工具和选区决定，普通绘画方向键不移动图层",()=>{
  for(const tool of ["marquee","lasso"] as const) {
    expect(nudgeTarget(tool,true)).toBe("boundary");expect(nudgeTarget(tool,true,true)).toBe("selectedPixels");expect(nudgeTarget(tool,false,true)).toBeNull();
  }
  expect(nudgeTarget("move",true)).toBe("selectedPixels");expect(nudgeTarget("move",false)).toBe("layer");
  expect(nudgeTarget("brush",true)).toBeNull();expect(nudgeTarget("brush",true,true)).toBe("layer");
});

it("关闭Shift切换偏好后同组工具单键可请求循环，默认仍需Shift",()=>{
  const input={key:"m",code:"KeyM",ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,isComposing:false,keyCode:0};
  expect(resolveEditorShortcut(input,false,false)).toEqual({kind:"tool",tool:"marquee",cycle:true});expect(resolveEditorShortcut(input,false)).toEqual({kind:"tool",tool:"marquee",cycle:false});
});

it("盖印快捷键按平台保留源图层，不误用普通合并",()=>{
 for(const mac of [false,true]) {const mod=mac?{metaKey:true}:{ctrlKey:true};
  expect(key("e",{...mod,altKey:true},mac)).toEqual({kind:"command",id:"layer.stampDown"});
  expect(key("e",{...mod,altKey:true,shiftKey:true},mac)).toEqual({kind:"command",id:"layer.stampVisible"});
 }
});

it("图层透明锁和蒙版/合成目标使用平台修饰键，避开Alt/Shift与IME",()=>{
 for(const mac of [false,true]) {
   const mod=mac?{metaKey:true}:{ctrlKey:true};
   expect(key("\\",{...mod,code:"Backslash"},mac)).toEqual({kind:"command",id:"channel.target.layerMask"});
   expect(key("2",{...mod,code:"Digit2"},mac)).toEqual({kind:"command",id:"channel.target.composite"});
   expect(key("/",{code:"Slash"},mac)).toEqual({kind:"layerState",action:"transparencyLock"});
   expect(key("/",{altKey:true},mac)).toBeNull();expect(key("?",{code:"Slash",shiftKey:true},mac)).toBeNull();
   expect(key("\\",{...mod,isComposing:true},mac)).toBeNull();
 }
});

it("德语符号笔刷键和物理括号键共用尺寸/硬度步进",()=>{
 expect(key("ö")).toEqual({kind:"brush",property:"size",direction:-1});
 expect(key("Ö",{shiftKey:true})).toEqual({kind:"brush",property:"hardness",direction:-1});
 expect(key("#")).toEqual({kind:"brush",property:"size",direction:1});
 expect(key("'",{shiftKey:true})).toEqual({kind:"brush",property:"hardness",direction:1});
 expect(key("ö",{ctrlKey:true})).toBeNull();
});


it("Ctrl Tab 在两个平台循环文档，排除组合输入与额外修饰键",()=>{
  for(const mac of [true,false]) {
    expect(key("Tab",{ctrlKey:true},mac)).toEqual({kind:"documentCycle",direction:1});
    expect(key("Tab",{ctrlKey:true,shiftKey:true},mac)).toEqual({kind:"documentCycle",direction:-1});
    expect(key("Tab",{ctrlKey:true,isComposing:true},mac)).toBeNull();
  }
});

it("页面导航解析屏幕轴与十像素步进，Home/End保留方向，排除IME/Alt/混合平台键",()=>{
 for(const mac of [false,true])for(const name of ["PageUp","PageDown","Home","End"] as const){
  expect(key(name,{},mac)).toEqual({kind:"navigate",navigation:{key:name,horizontal:false,small:false}});
  expect(key(name,{shiftKey:true,...(mac?{metaKey:true}:{ctrlKey:true})},mac)).toEqual({kind:"navigate",navigation:{key:name,horizontal:true,small:true}});
  expect(key(name,{altKey:true},mac)).toBeNull();expect(key(name,{isComposing:true},mac)).toBeNull();
 }
});

it("F2/F3/F4 are canvas clipboard alternatives with physical modifiers and IME gates",()=>{
 const event=(key:string,patch:Partial<KeyboardEvent>={})=>({key,code:key,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,isComposing:false,keyCode:0,...patch});
 for(const [key,id] of [["F2","edit.cut"],["F3","edit.copy"],["F4","edit.paste"]])for(const mac of [false,true]){
   expect(resolveEditorShortcut(event(key),mac)).toEqual({kind:"command",id});for(const patch of [{altKey:true},{shiftKey:true},{ctrlKey:true},{metaKey:true},{isComposing:true},{keyCode:229}])expect(resolveEditorShortcut(event(key,patch),mac)).toBeNull();
 }
});

it("粘贴入使用Mod+Alt+Shift+V，保留普通/原位粘贴与IME隔离",()=>{
 for(const mac of [false,true]){const mod=mac?{metaKey:true}:{ctrlKey:true};expect(key("v",{...mod,altKey:true,shiftKey:true},mac)).toEqual({kind:"command",id:"edit.pasteSpecial.pasteInto"});expect(key("v",{...mod,altKey:true,shiftKey:true,isComposing:true},mac)).toBeNull();expect(key("v",{...mod,altKey:true},mac)).toBeNull();expect(key("v",{...mod,shiftKey:true},mac)).toEqual({kind:"command",id:"edit.pasteSpecial.pasteInPlace"});}
 expect(commandShortcutLabel("edit.pasteSpecial.pasteInto")).toContain("Shift");
});

it("通用填充的Shift+F5与Shift+Backspace不影响前背景组合，IME与额外修饰不触发",()=>{
 for(const mac of [false,true])for(const name of ["F5","Backspace",...(mac?["Delete"]:[])]){
  expect(key(name,{shiftKey:true},mac)).toEqual({kind:"command",id:"edit.fill"});expect(key(name,{shiftKey:true,isComposing:true},mac)).toBeNull();
 }
 expect(commandShortcutLabel("edit.fill")).toBe("Shift+F5");expect(key("F5",{shiftKey:true,altKey:true})).toBeNull();expect(key("F5",{shiftKey:true,ctrlKey:true})).toBeNull();
});


it("历史填充使用独立Mod+Alt+Backspace，Mac Delete等价且Shift/IME拒绝",()=>{
 for(const mac of [false,true]){const mod=mac?{metaKey:true}:{ctrlKey:true};expect(key("Backspace",{...mod,altKey:true},mac)).toEqual({kind:"command",id:"edit.fillHistory"});expect(key("Backspace",{...mod,altKey:true,shiftKey:true},mac)).toBeNull();expect(key("Backspace",{...mod,altKey:true,isComposing:true},mac)).toBeNull();}
 expect(key("Delete",{metaKey:true,altKey:true},true)).toEqual({kind:"command",id:"edit.fillHistory"});
});

it("再次变换与再次变换并复制使用独立组合，不抢文字工具或粘贴入",()=>{
 expect(key("T",{ctrlKey:true,shiftKey:true})).toEqual({kind:"command",id:"edit.transform.again"});
 expect(key("T",{ctrlKey:true,shiftKey:true,altKey:true})).toEqual({kind:"command",id:"edit.transform.againCopy"});
 expect(key("v",{ctrlKey:true,shiftKey:true,altKey:true})).toEqual({kind:"command",id:"edit.pasteSpecial.pasteInto"});
 expect(key("t",{ctrlKey:true})).toEqual({kind:"tool",tool:"transform",cycle:false});
 expect(key("T",{ctrlKey:true,shiftKey:true,isComposing:true})).toBeNull();
});
