import { describe, expect, it } from "vitest";
import { FILL_SHORTCUTS, resolveEditorShortcut, shortcutLabel, commandShortcutLabel } from "./photo-editor-shortcuts.js";
function key(key: string, overrides: Partial<KeyboardEvent> = {}, isMac = false) {
  return resolveEditorShortcut({ key, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...overrides }, isMac);
}

it("Photoshop 工具键覆盖选择、修复、仿制与钢笔，同组用 Shift 循环",()=>{
  expect(key("w")).toEqual({kind:"tool",tool:"wand",cycle:false});
  expect(key("w",{shiftKey:true})).toEqual({kind:"tool",tool:"quick",cycle:true});
  expect(key("j")).toEqual({kind:"tool",tool:"heal",cycle:false});
  expect(key("j",{shiftKey:true})).toEqual({kind:"tool",tool:"retouch",cycle:true});
  expect(key("s")).toEqual({kind:"tool",tool:"clone",cycle:false});
  expect(key("p")).toEqual({kind:"tool",tool:"pen",cycle:false});
});

it("Q 进快速蒙版走本域草稿动作，不是绕过草稿的上游命令", () => {
  // 关键回归：`{kind:"command", id:"select.editInQuickMaskMode"}` 会被共享 `run()` 直接执行，
  // 内核进入快速蒙版而选区域没有草稿 —— 画笔无处可落、保存却照常成功。必须是域内动作。
  expect(key("q")).toEqual({ kind: "quickMask" });
  expect(key("q")).not.toEqual({ kind: "command", id: "select.editInQuickMaskMode" });
  // 修饰键组合不抢：Mod+Q 在浏览器/系统层，Shift+Q 也不进快速蒙版。
  expect(key("q", { ctrlKey: true })).toBeNull();
  expect(key("q", { metaKey: true }, true)).toBeNull();
  expect(key("q", { shiftKey: true })).toBeNull();
  expect(key("q", { altKey: true })).toBeNull();
  expect(key("q", { isComposing: true })).toBeNull();
});

it("反斜杠走蒙版叠加切换，且 Shift/修饰键不抢", () => {
  // 面板上写着「切换叠加（\\）」。此前只有按钮、没有键：按 \\ 什么都不会发生。
  // 这里锁定解析结果，避免文案与实现再次脱节。
  expect(key("\\", { code: "Backslash" })).toEqual({ kind: "maskOverlay" });
  // 布局差异：`key` 不是 `\` 但物理键位是 Backslash 时仍要认。
  expect(key("", { code: "Backslash" })).toEqual({ kind: "maskOverlay" });
  // Shift+\\ 是 `|`，不抢；系统修饰键留给浏览器/系统。
  expect(key("\\", { code: "Backslash", shiftKey: true })).toBeNull();
  expect(key("\\", { code: "Backslash", ctrlKey: true })).toBeNull();
  expect(key("\\", { code: "Backslash", metaKey: true }, true)).toBeNull();
  expect(key("\\", { code: "Backslash", altKey: true })).toBeNull();
  expect(key("\\", { code: "Backslash", isComposing: true })).toBeNull();
});

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
  it("显示快捷键按平台分派，H 单键为抓手，带额外修饰键不触发",()=>{
    expect(key("h",{ctrlKey:true})).toEqual({kind:"display",action:"extras"});
    expect(key("h",{metaKey:true},true)).toEqual({kind:"display",action:"extras"});
    expect(key("Tab")).toEqual({kind:"display",action:"panels"});
    expect(key("Tab",{shiftKey:true})).toEqual({kind:"display",action:"sidebar"});
    expect(key("h")).toEqual({kind:"tool",tool:"hand",cycle:false});expect(key("h",{ctrlKey:true,shiftKey:true})).toBeNull();
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
    expect(key("h")).toEqual({kind:"tool",tool:"hand",cycle:false});
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

it("重复上次滤镜用 Ctrl/Cmd+Alt/Option+F，且不吃掉无 Alt 的 Mod+F",()=>{
  // 与上游 `filter.lastFilter` 同键位；两端平台都要认。
  expect(key("f",{ctrlKey:true,altKey:true})).toEqual({kind:"command",id:"filter.lastFilter"});
  expect(key("f",{metaKey:true,altKey:true},true)).toEqual({kind:"command",id:"filter.lastFilter"});
  expect(commandShortcutLabel("filter.lastFilter")).toBeDefined();
  // Alt 项只经 alt 分支命中：无 Alt 的 Mod+F 仍不处理（任务栏/搜索留给宿主）。
  expect(key("f",{ctrlKey:true})).toBeNull();
  expect(key("f",{metaKey:true},true)).toBeNull();
  // 修饰键隔离：缺 Mod、多 Shift、对侧平台修饰、IME 都不触发。
  expect(key("f",{altKey:true})).toBeNull();
  expect(key("f",{ctrlKey:true,altKey:true,shiftKey:true})).toBeNull();
  expect(key("f",{metaKey:true,altKey:true})).toBeNull();
  expect(key("f",{ctrlKey:true,altKey:true,isComposing:true})).toBeNull();
  // 剪贴切换没被新键位影响。
  expect(key("g",{ctrlKey:true,altKey:true})).toEqual({kind:"clipping"});
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
  expect(key("g")).toEqual({kind:"tool",tool:"gradient",cycle:false});
  expect(commandShortcutLabel("layer.groupLayers")).toBe(shortcutLabel("Mod+G"));
  expect(commandShortcutLabel("layer.ungroupLayers")).toBe(shortcutLabel("Mod+Shift+G"));
});

// 集成矢量工具后，工具清单声明的 U 必须落到真实矩形工具。
it("U selects the delivered rectangle tool", () => {
  expect(resolveEditorShortcut({ key: "u", code: "KeyU", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0 }, false)).toEqual({ kind: "tool", tool: "shape-rect", cycle: false });
});
