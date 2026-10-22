import { describe, expect, it } from "vitest";
import { FILL_SHORTCUTS, resolveEditorShortcut, shortcutLabel, commandShortcutLabel } from "./photo-editor-shortcuts.js";
function key(key: string, overrides: Partial<KeyboardEvent> = {}, isMac = false) {
  return resolveEditorShortcut({ key, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...overrides }, isMac);
}

it("填充使用同一平台组合定义，Shift 保透明；不开放历史填充或混合系统修饰键", () => {
  for (const mac of [false,true]) for (const entry of FILL_SHORTCUTS) {
    const modifiers = {altKey:entry.alt,shiftKey:entry.shift,...(mac ? {metaKey:entry.mod} : {ctrlKey:entry.mod})};
    expect(key("Backspace",modifiers,mac)).toEqual({kind:"command",id:entry.id});
    if (mac) expect(key("Delete",modifiers,mac)).toEqual({kind:"command",id:entry.id});
    expect(key("Backspace",{...modifiers,isComposing:true},mac)).toBeNull();
    expect(key("Backspace",{...modifiers,keyCode:229},mac)).toBeNull();
    expect(shortcutLabel(entry.label,mac)).toContain(mac ? "Delete" : "Backspace");
  }
  expect(key("Backspace",{ctrlKey:true,altKey:true})).toBeNull();
  expect(key("Backspace",{ctrlKey:true},true)).toBeNull();
  expect(key("Backspace",{metaKey:true})).toBeNull();
  expect(key("Backspace",{altKey:true,metaKey:true},true)).toBeNull();
});
describe("图片编辑快捷键", () => {
  it("显示快捷键按平台分派，H 单键和带额外修饰键不触发",()=>{
    expect(key("h",{ctrlKey:true})).toEqual({kind:"display",action:"extras"});
    expect(key("h",{metaKey:true},true)).toEqual({kind:"display",action:"extras"});
    expect(key("Tab")).toEqual({kind:"display",action:"panels"});
    expect(key("Tab",{shiftKey:true})).toEqual({kind:"display",action:"sidebar"});
    expect(key("h")).toBeNull();expect(key("h",{ctrlKey:true,shiftKey:true})).toBeNull();
    expect(key("Tab",{ctrlKey:true})).toBeNull();expect(key("Tab",{altKey:true})).toBeNull();
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
    expect(key("h")).toBeNull();
    expect(key("b", { isComposing: true })).toBeNull();
    expect(key("b", { keyCode: 229 })).toBeNull();
  });
});

it("方向键使用源像素，Shift 增至 10px，输入法和平台修饰键不混入微移", () => {
  expect(key("ArrowLeft")).toEqual({kind:"nudge",dx:-1,dy:0});
  expect(key("ArrowDown",{shiftKey:true})).toEqual({kind:"nudge",dx:0,dy:10});
  expect(key("ArrowRight",{ctrlKey:true})).toBeNull();
  expect(key("ArrowUp",{altKey:true})).toBeNull();
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
  expect(key("z",{ctrlKey:true,altKey:true})).toBeNull();
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
  expect(key("g")).toBeNull();
  expect(commandShortcutLabel("layer.groupLayers")).toBe(shortcutLabel("Mod+G"));
  expect(commandShortcutLabel("layer.ungroupLayers")).toBe(shortcutLabel("Mod+Shift+G"));
});
