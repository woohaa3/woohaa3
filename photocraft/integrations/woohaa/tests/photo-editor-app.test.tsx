/** @vitest-environment jsdom */
// 只验证状态和 DOM 事件，不执行图片渲染。
import { act } from "react";
import { expect, it, vi } from "vitest";
import { DialogService } from "@woohaa3/frontend/plugin-api";
import { setup, press, canvasPort, root } from "../src/test-support/photo-editor-harness.js";

function chooseNativeTool(container:HTMLElement,id:string,slot=8) {
 let button=container.querySelector<HTMLButtonElement>(`.photo-editor__toolrail [data-tool-member="${id}"]`);
 if(!button){act(()=>container.querySelector<HTMLButtonElement>(`.photo-editor__toolrail [data-tool-slot="${slot}"]`)!.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true})));button=document.querySelector<HTMLButtonElement>(`.photo-editor__tool-group-menu [data-tool-member="${id}"]`);}
 expect(button).toBeTruthy();act(()=>button!.click());
}
async function closeNavigatorGroup(container:HTMLElement) {
 const group=container.querySelector<HTMLElement>('[data-panel-group="navigator"]')!;
 await act(async()=>group.querySelector<HTMLButtonElement>('.photo-editor__panel-group-menu')!.dispatchEvent(new MouseEvent('pointerdown',{button:0,bubbles:true})));
 await act(async()=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==='关闭面板组')!.click());
 expect(group.hidden).toBe(true);
}

it("工具选择仅展开当前参数，裁剪入口已移除", () => {
  const { container, dispatch } = setup();
  const sections = () => [...container.querySelectorAll<HTMLElement>(".photo-editor__options-group")].filter((node) => !node.hidden);
  expect(sections()).toHaveLength(1);
  act(() => container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="画笔"]')!.click());
  expect(sections().map((node) => node.getAttribute("aria-label"))).toEqual(["画笔"]);
  expect(container.querySelector(".photo-editor__crop")).toBeNull();
  expect(container.querySelector('.photo-editor__toolrail [aria-label="裁剪"]')).toBeNull();
  expect(dispatch).not.toHaveBeenCalled();
});

it("点击历史通过一个内核命令回退或重做多个状态", () => {
  const { container, dispatch,snapshot,render } = setup();
  snapshot.commands.set("history.selectState",{allowed:true,enabled:true} as never);render(false);
  const steps = container.querySelectorAll<HTMLButtonElement>(".photo-editor__history button");
  expect(steps).toHaveLength(5);
  expect(steps[2]!.disabled).toBe(true);
  act(() => steps[0]!.click());
  expect(dispatch.mock.calls).toEqual([["history.selectState",{state:0}]]);
  dispatch.mockClear();
  act(() => steps[4]!.click());
  expect(dispatch.mock.calls).toEqual([["history.selectState",{state:4}]]);
});

it("只读预览禁用历史跳转和工具，不提供平移工具", () => {
  const { container, dispatch } = setup(true);
  for (const button of container.querySelectorAll<HTMLButtonElement>(".photo-editor__history button, .photo-editor__history-actions button")) {
    expect(button.disabled).toBe(true);
    act(() => button.click());
  }
  expect(dispatch).not.toHaveBeenCalled();
  expect(container.querySelector('.photo-editor__toolrail [aria-label="平移"]')).toBeNull();
  for (const button of container.querySelectorAll<HTMLButtonElement>(".photo-editor__toolrail button")) expect(button.disabled).toBe(true);
  expect(container.querySelector('[data-canvas]')?.getAttribute("data-tool")).toBe("none");
});


it("编组快捷键经过真实编辑器路由，字段支持菜单组合，IME、手势和只读不触发",()=>{
  const {container,dispatch,snapshot,render}=setup();
  for(const id of ["layer.groupLayers","layer.ungroupLayers"]) snapshot.commands.set(id,{allowed:true,enabled:true} as never);
  render(false);
  const editor=container.querySelector(".photo-editor")!;
  expect(press(editor,"g",{ctrlKey:true}).defaultPrevented).toBe(true);
  expect(dispatch.mock.lastCall).toEqual(["layer.groupLayers",null]);
  press(editor,"G",{ctrlKey:true,shiftKey:true});
  expect(dispatch.mock.lastCall).toEqual(["layer.ungroupLayers",null]);
  dispatch.mockClear();
  press(container.querySelector("input")!,"g",{ctrlKey:true});
  expect(dispatch.mock.lastCall).toEqual(["layer.groupLayers",null]);dispatch.mockClear();
  press(editor,"g",{ctrlKey:true,isComposing:true});
  canvasPort.hasGesture.mockReturnValue(true);press(editor,"g",{ctrlKey:true});
  canvasPort.hasGesture.mockReturnValue(false);render(true);press(editor,"g",{ctrlKey:true});
  expect(dispatch).not.toHaveBeenCalled();
});

it("显示开关保留选择和工具节点，Tab 恢复先前侧栏状态，不产生文档命令",()=>{
  const {container,dispatch,render}=setup(false,{hasSelection:true});
  const editor=container.querySelector(".photo-editor")!;
  const rail=container.querySelector<HTMLElement>(".photo-editor__toolrail")!;
  const sidebar=container.querySelector<HTMLElement>(".photo-editor__sidebar")!;
  const options=container.querySelector<HTMLElement>(".photo-editor__contextbar")!;
  const outline=canvasPort.props!.selectionOutline;
  press(editor,"h",{ctrlKey:true});
  expect(canvasPort.props!.showSelectionEdges).toBe(false);
  expect(canvasPort.props!.selectionOutline).toBe(outline);
  expect(container.textContent).toContain("有选区（边界已隐藏）");
  press(editor,"Tab",{shiftKey:true});expect(sidebar.hidden).toBe(true);expect(rail.hidden).toBe(false);
  press(editor,"Tab");expect(rail.hidden&&sidebar.hidden&&options.hidden).toBe(true);
  press(editor,"Tab");expect(rail.hidden||options.hidden).toBe(false);expect(sidebar.hidden).toBe(true);
  press(editor,"Tab",{shiftKey:true});expect(sidebar.hidden).toBe(false);
  press(editor,"h",{ctrlKey:true});expect(canvasPort.props!.showSelectionEdges).toBe(true);
  expect(container.querySelector(".photo-editor__toolrail")).toBe(rail);
  const input=container.querySelector("input")!;
  expect(press(input,"Tab").defaultPrevented).toBe(false);
  canvasPort.hasGesture.mockReturnValue(true);press(editor,"Tab");expect(rail.hidden).toBe(false);
  canvasPort.hasGesture.mockReturnValue(false);render(true);press(editor,"Tab");expect(rail.hidden).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
});

it("填充总是使用当前色盘，交换和复位立即生效，输入及只读不填充", () => {
  const {container,dispatch,render,snapshot} = setup(false,{fillCommands:true});
  const editor = container.querySelector(".photo-editor")!;
  const color = container.querySelector<HTMLInputElement>('.photo-editor__swatch input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(color,"#c04020");
    color.dispatchEvent(new Event("input",{bubbles:true}));
  });
  press(editor,"Backspace",{altKey:true});
  expect(dispatch.mock.lastCall).toEqual(["edit.fillForeground",{color:"#c04020"}]);
  act(()=>container.querySelector<HTMLButtonElement>('[aria-label="交换前背景色（X）"]')!.click());
  press(editor,"Backspace",{ctrlKey:true,shiftKey:true});
  expect(dispatch.mock.lastCall).toEqual(["edit.fillBackgroundPreserve",{color:"#c04020"}]);
  press(editor,"Backspace",{altKey:true,shiftKey:true});
  expect(dispatch.mock.lastCall).toEqual(["edit.fillForegroundPreserve",{color:"#ffffff"}]);
  act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="默认")!.click());
  press(editor,"Backspace",{ctrlKey:true});
  expect(dispatch.mock.lastCall).toEqual(["edit.fillBackground",{color:"#ffffff"}]);
  const calls=dispatch.mock.calls.length;
  press(color,"Backspace",{altKey:true});
  press(editor,"Backspace",{altKey:true,isComposing:true});
  snapshot.commands.set("edit.fillForeground",{allowed:true,enabled:false} as never);
  press(editor,"Backspace",{altKey:true});
  render(true);
  press(editor,"Backspace",{ctrlKey:true});
  expect(dispatch).toHaveBeenCalledTimes(calls);
});

it("新建快捷键和面板共用宿主命名弹窗，确认只分派一次带名称的新建命令", () => {
  const dialogs = new DialogService();
  const {container, dispatch} = setup(false, {dialogs});
  const editor = container.querySelector(".photo-editor")!;
  press(editor,"N",{ctrlKey:true,shiftKey:true});
  expect(dialogs.isModalActive()).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  const input = container.querySelector<HTMLInputElement>(".photo-editor-new-layer__name input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"修边");
    input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  press(input,"Delete");
  press(input,"z",{ctrlKey:true});
  expect(dispatch).not.toHaveBeenCalled();
  act(()=>input.closest("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(dispatch.mock.calls).toEqual([["layer.new.layer",{name:"修边",color:"none",mode:"Normal",opacity:1,clipToPrevious:false,fillNeutral:false}]]);
  expect(dialogs.isModalActive()).toBe(false);
  act(()=>container.querySelector<HTMLButtonElement>('[aria-label="新建图层"]')!.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true})));
  expect(dialogs.isModalActive()).toBe(true);
  act(()=>[...container.querySelectorAll<HTMLButtonElement>(".dlg button")].find(button=>button.textContent==="取消")!.click());
  expect(dialogs.isModalActive()).toBe(false);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

it("命名组合输入不确认或取消，留空交给内核命名，失败保留重试", () => {
  const dialogs = new DialogService();
  const {container, dispatch} = setup(false, {dialogs});
  press(container.querySelector(".photo-editor")!,"N",{ctrlKey:true,shiftKey:true});
  const input = container.querySelector<HTMLInputElement>(".photo-editor-new-layer__name input")!;
  const form = input.closest("form")!;
  act(()=>input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));
  expect(press(input,"Enter",{isComposing:true}).defaultPrevented).toBe(true);
  press(input,"Escape",{isComposing:true});
  act(()=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(dispatch).not.toHaveBeenCalled();
  expect(dialogs.isModalActive()).toBe(true);
  act(()=>input.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true})));
  dispatch.mockReturnValueOnce({ok:false,message:"图层数量已达上限"} as never);
  act(()=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(container.querySelector(".dlg__error")?.textContent).toBe("图层数量已达上限");
  expect(dialogs.isModalActive()).toBe(true);
  act(()=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  expect(dispatch.mock.calls).toEqual([["layer.new.layer",{name:"Layer 1",color:"none",mode:"Normal",opacity:1,clipToPrevious:false,fillNeutral:false}],["layer.new.layer",{name:"Layer 1",color:"none",mode:"Normal",opacity:1,clipToPrevious:false,fillNeutral:false}]]);
  expect(dialogs.isModalActive()).toBe(false);
});

it("命名窗口在只读切换和卸载时关闭，不提交迟到输入", () => {
  const dialogs = new DialogService();
  const {container, dispatch, render} = setup(false, {dialogs});
  const open = () => press(container.querySelector(".photo-editor")!,"N",{ctrlKey:true,shiftKey:true});
  open();
  expect(dialogs.isModalActive()).toBe(true);
  render(true);
  expect(dialogs.isModalActive()).toBe(false);
  open();
  expect(dialogs.isModalActive()).toBe(false);
  render(false);open();
  act(()=>root.unmount());
  expect(dialogs.isModalActive()).toBe(false);
  expect(dialogs.registeredDialogIds()).not.toContain("image-editor.new-layer");
  expect(dispatch).not.toHaveBeenCalled();
});

it("命名不接受超限名称，确认时重新检查内核命令状态", () => {
  const dialogs = new DialogService();
  const {container, dispatch, snapshot} = setup(false, {dialogs});
  press(container.querySelector(".photo-editor")!,"N",{ctrlKey:true,shiftKey:true});
  const input = container.querySelector<HTMLInputElement>(".photo-editor-new-layer__name input")!;
  const change = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);
    input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  const submit = () => act(()=>input.closest("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
  change("字".repeat(201));submit();
  expect(dispatch).not.toHaveBeenCalled();
  expect(container.querySelector(".dlg__error")?.textContent).toContain("200");
  change("修边");
  snapshot.commands.set("layer.new.layer",{allowed:true,enabled:false} as never);
  submit();
  expect(dispatch).not.toHaveBeenCalled();
  expect(dialogs.isModalActive()).toBe(true);
  snapshot.commands.set("layer.new.layer",{allowed:true,enabled:true} as never);
  submit();
  expect(dispatch.mock.calls).toEqual([["layer.new.layer",{name:"修边",color:"none",mode:"Normal",opacity:1,clipToPrevious:false,fillNeutral:false}]]);
});

it("工具键、临时空格与失焦恢复使用编辑器范围，不改变当前工具", () => {
  const { container } = setup();
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  expect(document.activeElement).toBe(editor);
  press(editor, "b");
  act(()=>editor.dispatchEvent(new KeyboardEvent("keyup",{key:"b",bubbles:true})));
  expect(container.querySelector('[data-canvas]')?.getAttribute("data-tool")).toBe("brush");
  press(editor, " ", { code: "Space" });
  expect(container.querySelector('[data-canvas]')?.getAttribute("data-tool")).toBe("pan");
  act(() => editor.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true })));
  expect(container.querySelector('[data-canvas]')?.getAttribute("data-tool")).toBe("brush");
  press(editor, " ", { code: "Space" });
  act(() => window.dispatchEvent(new Event("blur")));
  expect(container.querySelector('[data-canvas]')?.getAttribute("data-tool")).toBe("brush");
});

it("撤销、选区和缩放不透传给宿主；输入框与 IME 保留原生按键", () => {
  const { container, dispatch } = setup();
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  const host = vi.fn();
  window.addEventListener("keydown", host);
  try {
    expect(press(editor, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith("edit.undo", null);
    press(editor, "Z", { ctrlKey: true, shiftKey: true });
    expect(dispatch).toHaveBeenLastCalledWith("edit.redo", null);
    press(editor, "a", { ctrlKey: true });
    expect(dispatch).toHaveBeenLastCalledWith("select.all", null);
    press(editor, "1", { ctrlKey: true });
    expect(canvasPort.view).toHaveBeenLastCalledWith("actualSize");
    expect(host).not.toHaveBeenCalled();
    dispatch.mockClear();
    const input = container.querySelector("input")!;
    expect(press(input, "z", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(input, "a", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press(editor, "b", { isComposing: true }).defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(host).toHaveBeenCalledTimes(3);
  } finally { window.removeEventListener("keydown", host); }
});

it("Escape 先丢弃半笔，再取消选区；长按不连续退出层级", () => {
  const { container, dispatch } = setup(false, { hasSelection: true });
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  canvasPort.cancelGesture.mockReturnValueOnce(true);
  expect(press(editor, "Escape").defaultPrevented).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  press(editor, "Escape", { repeat: true });
  expect(dispatch).not.toHaveBeenCalled();
  press(editor, "Escape");
  expect(dispatch).toHaveBeenLastCalledWith("select.deselect", null);
});

it("没有待取消内容的 Escape 交给宿主退出；只读与重复按键不写内容", () => {
  const { container, dispatch } = setup(true);
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  expect(press(editor, "Escape").defaultPrevented).toBe(false);
  expect(press(editor, "z", { ctrlKey: true }).defaultPrevented).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  press(editor, "0", { ctrlKey: true });
  expect(canvasPort.view).not.toHaveBeenCalled();
});

it("保存键调用同一应用动作，自动重复不重复保存", async () => {
  const onApply = vi.fn();
  const { container } = setup(false, { dirty: true, onApply });
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  await act(async () => { press(editor, "s", { ctrlKey: true }); });
  expect(onApply).toHaveBeenCalledTimes(1);
  press(editor, "s", { ctrlKey: true, repeat: true });
  expect(onApply).toHaveBeenCalledTimes(1);
});

it("半笔期间工具键与空格不切换工具；只读、无效命令和重复撤销都不写入", () => {
  const { container, dispatch } = setup();
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  press(editor, "b");
  canvasPort.hasGesture.mockReturnValue(true);
  press(editor, "e");
  press(editor, " ", { code: "Space" });
  expect(container.querySelector('[data-canvas]')?.getAttribute("data-tool")).toBe("brush");
  canvasPort.hasGesture.mockReturnValue(false);
  press(editor, "z", { ctrlKey: true, repeat: true });
  press(editor, "j", { ctrlKey: true });
  expect(dispatch).not.toHaveBeenCalled();
});

it("输入框的空格释放会留给宿主，避免宿主的空格状态卡住", () => {
  const { container } = setup();
  const input = container.querySelector("input")!;
  const host = vi.fn();
  window.addEventListener("keyup", host);
  try {
    press(input, " ", { code: "Space" });
    act(() => input.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true })));
    expect(host).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("keyup", host); }
});

it("默认矩形选框；H切换手形，已移除C不切换，选区来自内核", () => {
  const { container } = setup(false, { hasSelection: true });
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  const canvas = container.querySelector('[data-canvas]')!;
  expect(canvas.getAttribute("data-tool")).toBe("marquee");
  expect(canvas.getAttribute("data-selection")).toBe("[[10,20,50,20],[50,20,50,60],[50,60,10,60],[10,60,10,20]]");
  press(editor, "h");
  expect(canvas.getAttribute("data-tool")).toBe("pan");
  press(editor, "c");
  expect(canvas.getAttribute("data-tool")).toBe("pan");
});


it("选区内部单击保留，外部单击取消；增加模式保留原选区", () => {
  const { container, dispatch } = setup(false, { hasSelection: true });
  const canvas = container.querySelector("[data-canvas]")!;
  act(() => canvas.dispatchEvent(new MouseEvent("click", { clientX: 30, clientY: 40, bubbles: true })));
  expect(dispatch).not.toHaveBeenCalled();
  act(() => canvas.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true })));
  expect(dispatch).toHaveBeenLastCalledWith("select.deselect", null); dispatch.mockClear();
  const modes = container.querySelector<HTMLSelectElement>('[aria-label="选区"] select')!;
  for (const mode of ["add", "subtract", "intersect"]) {
    act(() => { modes.value = mode; modes.dispatchEvent(new Event("change", { bubbles: true })); });
    act(() => canvas.dispatchEvent(new MouseEvent("click", { clientX: 100, clientY: 100, bubbles: true })));
  }
  expect(dispatch).not.toHaveBeenCalled();
});


it("所选调整层直接回填对应参数，编辑保留画笔工具且只修改原图层", () => {
  const { container, dispatch, adjustmentPort } = setup(false, { document: {
    layers: [{ id: 1, kind: "adjustment", name: "调色", adjustment: { kind: "brightnessContrast", params: { brightness: 30, contrast: 20 } } }]
  } });
  press(container.querySelector(".photo-editor")!, "b");
  expect(canvasPort.props!.tool).toBe("brush");
  expect(container.querySelector('.photo-editor__toolrail [aria-label="调整层"]')).toBeNull();
  expect(container.querySelector('.photo-editor__toolrail [aria-label="蒙版"]')).toBeNull();
  expect(container.querySelectorAll('[data-adjustment-control]')).toHaveLength(2);
  expect(container.querySelector('.photo-editor__object-properties')!.textContent).not.toContain("RGB 曲线");
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="调整层"].photo-editor__options-group button')];
  expect(buttons.some(button=>button.textContent==="更新亮度/对比度")).toBe(false);
  const slider=container.querySelector<HTMLInputElement>('[data-adjustment-control] input')!;
  expect(slider.value).toBe("30");
  act(()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(slider,"45");
    slider.dispatchEvent(new Event("input",{bubbles:true}));
  });
  expect(adjustmentPort.beginAdjustment).toHaveBeenCalledWith(1);
  act(()=>slider.dispatchEvent(new KeyboardEvent("keyup",{key:"ArrowRight",bubbles:true})));
  expect(adjustmentPort.previewAdjustment).toHaveBeenLastCalledWith({brightness:45});
  expect(adjustmentPort.commitAdjustment).toHaveBeenCalledOnce();expect(dispatch).not.toHaveBeenCalled();
  expect(canvasPort.props!.tool).toBe("brush");
});

it("调整取消回填原值并阻止拖动尾部补交，活动会话禁用其他文档入口",()=>{
  const {container,dispatch,adjustmentPort}=setup(false,{document:{layers:[{id:1,kind:"adjustment",name:"调色",adjustment:{kind:"hueSaturation",params:{hue:30,saturation:20,lightness:0}}}]}});
  const slider=container.querySelector<HTMLInputElement>('[data-adjustment-control] input')!;
  const pointer=(type:string)=>{const event=new MouseEvent(type,{bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>slider.dispatchEvent(event));};
  const change=(value:string)=>act(()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(slider,value);slider.dispatchEvent(new Event("input",{bubbles:true}));
  });
  pointer("pointerdown");change("60");
  expect(container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="画笔"]')!.disabled).toBe(true);
  act(()=>slider.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));
  expect(slider.value).toBe("30");change("80");pointer("pointerup");
  expect(adjustmentPort.cancelAdjustment).toHaveBeenCalledOnce();expect(adjustmentPort.commitAdjustment).not.toHaveBeenCalled();
  expect(adjustmentPort.beginAdjustment).toHaveBeenCalledOnce();expect(dispatch).not.toHaveBeenCalled();
});

it("不显示未接通的分组与未允许的图层动作", () => {
  const { container } = setup();
  expect(container.querySelector('[aria-label="新建组"]')).toBeNull();
  expect(container.querySelector('.photo-editor__layer-actions [aria-label="新建图层"]')).toBeNull();
});

it("V 只选移动，Ctrl+T 临时变换；多次预览后 Enter 一次确认并回原工具", () => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { container, transform, dispatch } = setup(false, { document: { transformFrame: [10, 10, 100, 100] } });
  const editor = container.querySelector(".photo-editor")!;
  press(editor, "v");
  expect(transform.beginTransform).not.toHaveBeenCalled();
  expect(canvasPort.props?.transformMoveOnly).toBe(true);
  press(editor, "b"); press(editor, "t", { ctrlKey: true });
  expect(transform.beginTransform).toHaveBeenCalledOnce();
  expect(container.querySelector(".photo-editor__tool-label")!.textContent).toBe("自由变换");
  act(() => {
    canvasPort.props!.onTransformPreview!([1,0,0,1,10,20]);
    canvasPort.props!.onTransform!([1,0,0,1,30,40]);
  });
  expect(transform.commitTransform).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  press(editor, "Enter");
  expect(transform.previewTransform).toHaveBeenLastCalledWith([1,0,0,1,30,40]);
  expect(transform.commitTransform).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-canvas]')!.getAttribute("data-tool")).toBe("brush");
  expect(container.querySelector(".photo-editor__tool-label")!.textContent).toBe("画笔");
});

it("变换 Escape 丢弃整次草稿，不取消原选区；输入框与只读不启动变换", () => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { container, transform, dispatch } = setup(false, { hasSelection: true, document: { transformFrame: [10, 10, 100, 100] } });
  const editor = container.querySelector(".photo-editor")!;
  press(container.querySelector("input")!, "t", { ctrlKey: true });
  expect(transform.beginTransform).toHaveBeenCalledOnce();press(editor,"Escape");
  transform.beginTransform.mockClear();transform.cancelTransform.mockClear();
  press(editor, "t", { ctrlKey: true, isComposing: true });
  expect(transform.beginTransform).not.toHaveBeenCalled();
  press(editor, "t", { ctrlKey: true });
  act(() => canvasPort.props!.onTransformPreview!([2,0,0,2,0,0]));
  press(editor, "Escape");
  expect(transform.cancelTransform).toHaveBeenCalledOnce();
  expect(transform.commitTransform).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(container.querySelector('[data-canvas]')!.getAttribute("data-tool")).toBe("marquee");
});

it("只读状态不启动自由变换", () => {
  const { container, transform } = setup(true, { document: { transformFrame: [10,10,100,100] } });
  press(container.querySelector(".photo-editor")!, "t", { ctrlKey: true });
  expect(transform.beginTransform).not.toHaveBeenCalled();
});

it("变换数值输入的 Enter 与 Escape 属于变换会话，IME 不触发提交", () => {
  const { container, transform } = setup(false, { document: { transformFrame: [10,10,100,100] } });
  const editor = container.querySelector(".photo-editor")!;
  press(editor, "t", { ctrlKey: true });
  const input = container.querySelector('.photo-editor__contextbar > .photo-editor__options-group input')!;
  press(input, "Enter", { isComposing: true });
  expect(transform.commitTransform).not.toHaveBeenCalled();
  press(input, "Enter");
  expect(transform.commitTransform).toHaveBeenCalledOnce();
  press(editor, "t", { ctrlKey: true });
  press(container.querySelector('.photo-editor__contextbar > .photo-editor__options-group input')!, "Escape");
  expect(transform.cancelTransform).toHaveBeenCalledOnce();
  expect(container.querySelector(".photo-editor__tool-label")!.textContent).toBe("矩形选框");
});

it("移动工具拖动同样预览内容，松手确认一步；取消当前拖动不提交", () => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { container, transform } = setup(false, { document: { transformFrame: [10,10,100,100] } });
  press(container.querySelector(".photo-editor")!, "v");
  act(() => { canvasPort.props!.onTransformBegin!(); canvasPort.props!.onTransformPreview!([1,0,0,1,20,10]); });
  expect(transform.commitTransform).not.toHaveBeenCalled();
  act(() => canvasPort.props!.onTransform!([1,0,0,1,30,20]));
  expect(transform.previewTransform).toHaveBeenLastCalledWith([1,0,0,1,30,20]);
  expect(transform.commitTransform).toHaveBeenCalledOnce();
  expect(canvasPort.props!.transformMoveOnly).toBe(true);
  act(() => { canvasPort.props!.onTransformBegin!(); canvasPort.props!.onTransformPreview!([1,0,0,1,50,20]); canvasPort.props!.onTransformCancel!(); });
  expect(transform.cancelTransform).toHaveBeenCalledOnce();
  expect(transform.commitTransform).toHaveBeenCalledOnce();
});

it("无效数值阻止确认旧的预览，仍可取消整次变换", () => {
  const { container, transform } = setup(false, { document: { transformFrame: [10,10,100,100] } });
  const editor = container.querySelector(".photo-editor")!;
  press(editor, "t", { ctrlKey: true });
  const input = container.querySelector<HTMLInputElement>('.photo-editor__contextbar > .photo-editor__options-group input')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setter.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); });
  press(input, "Enter"); press(editor, "Enter");
  expect(transform.commitTransform).not.toHaveBeenCalled();
  const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "确认变换")!;
  expect(confirm.disabled).toBe(true);
  press(editor, "Escape");
  expect(transform.cancelTransform).toHaveBeenCalledOnce();
});

it("移动工具传递自动选层与临时修饰键设置", () => {
  const {container,transform} = setup(false,{document:{transformFrame:[10,10,100,100]}});
  const editor = container.querySelector(".photo-editor")!;
  press(editor,"v");
  expect(canvasPort.props!.tool).toBe("move");
  act(() => { expect(canvasPort.props!.onMoveStart?.({x:30,y:40},{duplicate:true,toggleAuto:false,add:false})).toBe(true); });
  expect(transform.beginMove).toHaveBeenLastCalledWith({x:30,y:40,duplicate:true,autoSelect:false,selectedPixels:false,wholeLayer:undefined});
  act(() => canvasPort.props!.onMoveCancel?.());
  act(() => [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith("自动选择"))!.querySelector("input")!.click());
  act(() => { canvasPort.props!.onMoveStart?.({x:35,y:45},{duplicate:false,toggleAuto:true,add:false}); });
  expect(transform.beginMove).toHaveBeenLastCalledWith({x:35,y:45,duplicate:false,autoSelect:false,selectedPixels:false,wholeLayer:undefined});
  act(() => canvasPort.props!.onMoveCancel?.());
});
it("移动方向键按住到松键合并一步，Shift 为 10px；Esc 和失焦撤回", () => {
  const {container,transform} = setup(false,{document:{transformFrame:[10,10,100,100]}});
  const editor = container.querySelector(".photo-editor")!;
  press(editor,"v"); press(editor,"ArrowRight"); press(editor,"ArrowRight",{repeat:true}); press(editor,"ArrowDown",{shiftKey:true});
  expect(transform.beginMove).toHaveBeenCalledOnce(); expect(transform.commitTransform).not.toHaveBeenCalled();
  act(() => editor.dispatchEvent(new KeyboardEvent("keyup",{key:"ArrowRight",bubbles:true})));
  expect(transform.previewTransform).toHaveBeenLastCalledWith([1,0,0,1,2,10]);
  expect(transform.commitTransform).toHaveBeenCalledOnce();
  press(editor,"ArrowLeft"); press(editor,"Escape");
  expect(transform.cancelTransform).toHaveBeenCalledOnce(); expect(transform.commitTransform).toHaveBeenCalledOnce();
  press(editor,"ArrowUp"); act(() => window.dispatchEvent(new Event("blur")));
  expect(transform.cancelTransform).toHaveBeenCalledTimes(2);
  press(container.querySelector("input")!,"ArrowRight");
  expect(transform.beginMove).toHaveBeenCalledTimes(3);
});

it("方向键微移后点击自由变换，先结束微移，不复用尚未结束的会话", () => {
  const {container,transform} = setup(false,{document:{transformFrame:[10,10,100,100]}});
  const editor = container.querySelector(".photo-editor")!;
  press(editor,"v"); press(editor,"ArrowRight");
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "自由变换")!.click());
  expect(transform.commitTransform).toHaveBeenCalledOnce(); expect(transform.beginMove).toHaveBeenCalledOnce(); expect(transform.beginTransform).toHaveBeenCalledOnce();
  act(() => editor.dispatchEvent(new KeyboardEvent("keyup",{key:"ArrowRight",bubbles:true})));
  expect(transform.commitTransform).toHaveBeenCalledOnce();
  press(editor,"Escape"); expect(transform.cancelTransform).toHaveBeenCalledOnce();
});

it("选区手势消费空格和修饰键，不切换平移；输入框与 IME 不进入手势键盘端口", () => {
  const {container} = setup();
  const editor = container.querySelector(".photo-editor")!;
  canvasPort.selectionKey.mockReturnValue(true);
  expect(press(editor," ",{code:"Space"}).defaultPrevented).toBe(true);
  expect(canvasPort.props!.tool).toBe("marquee");
  expect(canvasPort.selectionKey).toHaveBeenLastCalledWith(" ",true);
  act(() => editor.dispatchEvent(new KeyboardEvent("keyup",{key:" ",code:"Space",bubbles:true})));
  expect(canvasPort.selectionKey).toHaveBeenLastCalledWith(" ",false);
  expect(canvasPort.props!.tool).toBe("marquee");
  canvasPort.selectionKey.mockClear();
  press(container.querySelector("input")!,"Shift"); press(editor," ",{isComposing:true});
  expect(canvasPort.selectionKey).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("blur")));
  expect(canvasPort.cancelGesture).toHaveBeenCalled();
});
it("选区提交使用本次手势模式；加减或相交模式的单击不会取消原选区", () => {
  const {dispatch} = setup(false,{hasSelection:true});
  act(() => canvasPort.props!.onMarquee?.({x:10,y:20,width:30,height:40},"subtract"));
  expect(dispatch).toHaveBeenLastCalledWith("select.rect",expect.objectContaining({mode:"subtract",x:10,width:30}));
  act(() => canvasPort.props!.onLasso?.([{x:1,y:1},{x:10,y:1},{x:10,y:10}],"intersect"));
  expect(dispatch).toHaveBeenLastCalledWith("select.lasso",expect.objectContaining({mode:"intersect"}));
  dispatch.mockClear();
  act(() => canvasPort.props!.onSelectionClick?.({x:500,y:500},"add"));
  act(() => canvasPort.props!.onSelectionClick?.({x:500,y:500},"subtract"));
  act(() => canvasPort.props!.onSelectionClick?.({x:500,y:500},"intersect"));
  expect(dispatch).not.toHaveBeenCalled();
  act(() => canvasPort.props!.onSelectionClick?.({x:500,y:500},"replace"));
  expect(dispatch).toHaveBeenLastCalledWith("select.deselect",null);
});

it("选区边界使用独立变换草稿；像素移动与 V 的自动选层保持不同语义", () => {
  const {container,transform}=setup(false,{hasSelection:true,document:{selectionFrame:[10,20,50,60],transformFrame:[20,30,40,50]}});
  act(() => { expect(canvasPort.props!.onSelectionMoveStart!(false)).toBe(true); });
  expect(transform.beginTransform).toHaveBeenLastCalledWith(true);
  act(() => canvasPort.props!.onMoveCancel!());
  act(() => { expect(canvasPort.props!.onSelectionMoveStart!(true)).toBe(true); });
  expect(transform.beginTransform).toHaveBeenLastCalledWith();
  act(() => canvasPort.props!.onMoveCancel!());
  const button=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "变换选区")!;
  act(() => button.click());
  expect(canvasPort.props!.transformFrame).toEqual([10,20,50,60]);
  expect(canvasPort.props!.selectionMatrix).toEqual([1,0,0,1,0,0]);
  press(container.querySelector(".photo-editor")!,"Escape");
  expect(container.querySelector('[data-canvas]')!.getAttribute("data-tool")).toBe("marquee");
  press(container.querySelector(".photo-editor")!,"v");
  act(() => canvasPort.props!.onMoveStart!({x:30,y:40},{duplicate:false,toggleAuto:true,add:false}));
  expect(transform.beginMove).toHaveBeenLastCalledWith({x:30,y:40,autoSelect:false,duplicate:false,selectedPixels:true,wholeLayer:undefined});
});

it("画笔与橡皮分别记住尺寸/不透明度/流量；前背景色共用且 X/D 可用", () => {
  const {container,dispatch}=setup(); const editor=container.querySelector(".photo-editor")!;
  const field=(name:string) => [...container.querySelectorAll<HTMLLabelElement>('[aria-label="画笔"] label')].find((label)=>label.textContent?.trim().startsWith(name))!.querySelector<HTMLInputElement>("input")!;
  const foreground=() => container.querySelector<HTMLInputElement>('.photo-editor__swatch input')!;
  const background=() => container.querySelector<HTMLInputElement>('.photo-editor__background-swatch input')!;
  press(editor,"b"); press(editor,"]",{code:"BracketRight"}); press(editor,"5"); press(editor,"3");
  expect(field("尺寸").value).toBe("30"); expect(field("不透明度").value).toBe("53");
  press(editor,"%",{code:"Digit5",shiftKey:true}); expect(field("流量").value).toBe("50");
  press(editor,"e"); expect(field("尺寸").value).toBe("24"); expect(field("不透明度").value).toBe("100"); expect(field("流量").value).toBe("100");
  press(editor,"2"); press(editor,"b"); expect(field("不透明度").value).toBe("53"); expect(field("流量").value).toBe("50");
  press(editor,"e"); expect(field("不透明度").value).toBe("20");
  press(editor,"x"); expect(foreground().value).toBe("#ffffff"); expect(background().value).toBe("#000000");
  press(editor,"d"); expect(foreground().value).toBe("#000000"); expect(background().value).toBe("#ffffff");
  press(field("尺寸"),"x"); expect(foreground().value).toBe("#000000");
  press(editor,"b");
  expect(press(editor,"Alt",{altKey:true}).defaultPrevented).toBe(true);
  expect(canvasPort.props!.sampling).toBe(true);
  act(() => window.dispatchEvent(new Event("blur")));
  expect(canvasPort.props!.sampling).toBe(false);
  press(editor,"Alt",{altKey:true,isComposing:true});
  expect(canvasPort.props!.sampling).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
});

it("缩略图分别选内容和蒙版；Shift 启停、Alt 单独查看，目标边框和链接状态读取内核", () => {
  const {container,dispatch}=setup(false,{document:{editTarget:"mask",layerMaskView:{layer:1,mode:"gray"},
    layers:[{id:1,name:"带蒙版层",kind:"raster",hasMask:true,maskEnabled:false,maskLinked:false}],transformFrame:[0,0,800,600]}});
  const mask=container.querySelector<HTMLButtonElement>('[data-edit-target="mask"]')!;
  const pixels=container.querySelector<HTMLButtonElement>('[data-edit-target="pixels"]')!;
  expect(mask.dataset.targetActive).toBe("true"); expect(mask.dataset.maskEnabled).toBe("false"); expect(mask.dataset.maskView).toBe("true");
  expect(pixels.dataset.targetActive).toBeUndefined();
  expect(container.querySelector('button[aria-label="链接蒙版"]')).not.toBeNull();
  act(()=>mask.dispatchEvent(new MouseEvent("click",{bubbles:true,shiftKey:true})));
  expect(dispatch.mock.calls).toEqual([["layer.layerMask.enabled",{layer:1,enabled:true}]]);
  dispatch.mockClear(); act(()=>mask.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true})));
  expect(dispatch.mock.calls).toEqual([["layer.select",{layer:1,mode:"replace"}],["channel.target.layerMask",null],["view.layerMask",{layer:1,mode:"toggleGray"}]]);
  dispatch.mockClear(); act(()=>pixels.click());
  expect(dispatch.mock.calls).toEqual([["layer.select",{layer:1,mode:"replace"}],["view.layerMask",{layer:1,mode:"off"}],["channel.target.composite",null]]);
  const editor=container.querySelector(".photo-editor")!; press(editor,"v");
  act(()=>canvasPort.props!.onMoveStart!({x:20,y:30},{duplicate:false,toggleAuto:false,add:false}));
  expect(canvasPort.props!.transformFrame).toEqual([0,0,800,600]);
});
it("只读状态禁止蒙版目标、启停和单独查看", () => {
  const {container,dispatch}=setup(true,{document:{layers:[{id:1,name:"层",kind:"raster",hasMask:true}]}});
  for (const button of container.querySelectorAll<HTMLButtonElement>('[data-edit-target]')) {expect(button.disabled).toBe(true); act(()=>button.click());}
  expect(dispatch).not.toHaveBeenCalled();
});


it.each([
  [false,false,"revealAll"], [false,true,"hideAll"],
  [true,false,"revealSelection"], [true,true,"hideSelection"]
])("添加蒙版按选区与 Alt 分派（选区=%s，反向=%s）", (hasSelection,invert,operation) => {
  const {container,dispatch}=setup(false,{hasSelection,maskCommands:true});
  const button=container.querySelector<HTMLButtonElement>('.photo-editor__layer-actions [aria-label="添加蒙版"]')!;
  expect(button.disabled).toBe(false);
  act(()=>button.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:invert})));
  expect(dispatch.mock.calls).toEqual([[`layer.layerMask.${operation}`,{layer:1}]]);
});

it("已有蒙版禁止再次生成，保留应用和删除入口", () => {
  const {container,dispatch}=setup(false,{hasSelection:true,maskCommands:true,document:{editTarget:"mask",layers:[{id:1,name:"层",kind:"raster",hasMask:true}]}});
  const add=container.querySelector<HTMLButtonElement>('.photo-editor__layer-actions [aria-label="添加蒙版"]')!;
  expect(add.disabled).toBe(true); act(()=>add.click());
  const buttons=[...container.querySelectorAll<HTMLButtonElement>('.photo-editor__options-group[aria-label="蒙版"] button')];
  expect(container.querySelector('.photo-editor__options-group[aria-label="蒙版"]')!.hasAttribute("hidden")).toBe(false);
  expect(buttons.map(button=>button.textContent)).toEqual(["启用/停用","应用蒙版","删除"]);
  expect(dispatch).not.toHaveBeenCalled();
  act(()=>buttons.find(b=>b.textContent==="应用蒙版")!.click());
  expect(dispatch.mock.calls).toEqual([["layer.layerMask.apply",{layer:1}]]);
});

it("图层范围和增减选择只分派内核选择，不把取消选择的行切成编辑目标",()=>{
  const {container,dispatch}=setup(false,{document:{selectedLayers:[1,2],layers:[
    {id:1,name:"上层",kind:"raster"},{id:2,name:"下层",kind:"raster"}]}});
  const row=container.querySelector('[data-layer-id="2"]')!;
  const name=row.querySelector(".photo-editor__layer-name")!;
  for (const modifiers of [{shiftKey:true},{ctrlKey:true},{metaKey:true}]) {
    dispatch.mockClear();act(()=>name.dispatchEvent(new MouseEvent("click",{bubbles:true,...modifiers})));
    expect(dispatch.mock.calls).toEqual([["layer.select",{layer:2,mode:"shiftKey" in modifiers ? "range" : "toggle"}]]);
  }
  dispatch.mockClear();
  act(()=>row.querySelector<HTMLButtonElement>('[data-edit-target="pixels"]')!.click());
  expect(dispatch.mock.calls).toEqual([["layer.select",{layer:2,mode:"replace"}],["view.layerMask",{layer:2,mode:"off"}],["channel.target.composite",null]]);
});

it("Shift+M 与工具列、标题和实际选框一致，切换其他工具后记住子工具",()=>{
  const {container,dispatch}=setup();const editor=container.querySelector(".photo-editor")!;
  const current=()=>container.querySelector(".photo-editor__tool-label")!.textContent;
  expect(current()).toBe("矩形选框");expect(canvasPort.props!.ellipse).toBe(false);
  press(editor,"M",{shiftKey:true});expect(current()).toBe("椭圆选框");expect(canvasPort.props!.ellipse).toBe(true);
  expect(container.querySelector('.photo-editor__toolrail [aria-label="椭圆选框"]')).not.toBeNull();
  press(editor,"b");press(editor,"m");expect(current()).toBe("椭圆选框");expect(canvasPort.props!.ellipse).toBe(true);
  act(()=>canvasPort.props!.onMarquee?.({x:10,y:20,width:40,height:30},"replace"));
  expect(dispatch.mock.lastCall).toEqual(["select.rect",expect.objectContaining({ellipse:true})]);
  press(editor,"M",{shiftKey:true});expect(current()).toBe("矩形选框");expect(canvasPort.props!.ellipse).toBe(false);
  chooseNativeTool(container,"singleRowMarquee",1);expect(current()).toBe("单行选框");expect(canvasPort.props!.marqueeLine).toBe("row");
  chooseNativeTool(container,"singleColumnMarquee",1);expect(current()).toBe("单列选框");
});

it.each([
  ["文字",{kind:"text",text:{text:"内容"}},"pixels"],
  ["蒙版",{kind:"raster",hasMask:true},"mask"],
  ["调整层",{kind:"adjustment",adjustment:{kind:"brightnessContrast",params:{brightness:20,contrast:10}}},"pixels"]
])("所选%s属性显示在侧栏，折叠不重建图层或历史",(label,layer,editTarget)=>{
  const {container,dispatch}=setup(false,{document:{editTarget,activeTextStyle:{size:30,font:"Inter",color:"#112233"},layers:[{id:1,name:"所选图层",opacity:1,blend:"Normal",...layer as object}]}});
  const sidebar=container.querySelector(".photo-editor__sidebar")!;
  expect(sidebar.querySelector(`[aria-label="${label==="橡皮"?"橡皮擦":label}"]`)!.hasAttribute("hidden")).toBe(false);
  expect(container.querySelector(`.photo-editor__contextbar [aria-label="${label==="橡皮"?"橡皮擦":label}"]`)).toBeNull();
  const layers=sidebar.querySelector(".photo-editor__layers"),history=sidebar.querySelector(".photo-editor__history");
  act(()=>sidebar.querySelector<HTMLButtonElement>('[title="折叠图层"]')!.click());
  expect(layers!.parentElement!.parentElement!.getAttribute("data-collapsed")).toBe("true");
  act(()=>sidebar.querySelector<HTMLButtonElement>('[title="展开图层"]')!.click());
  expect(sidebar.querySelector(".photo-editor__layers")).toBe(layers);expect(sidebar.querySelector(".photo-editor__history")).toBe(history);
  expect(dispatch).not.toHaveBeenCalled();
});

it("源像素调度装配到 App，缩放读取可见区域，只读及卸载撤回细节",()=>{
  let next=0;const jobs=new Map<number,FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{jobs.set(++next,cb);return next;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>{jobs.delete(id);});
  const publish=vi.fn();const options={document:{width:4096,height:3000},onDetailPreview:publish,zoom:1};
  const h=setup(false,options);
  const drain=()=>act(()=>{for(let i=0;jobs.size&&i<100;i++){const [id,cb]=jobs.entries().next().value!;jobs.delete(id);cb(0);}});
  drain();expect(h.region).toHaveBeenCalled();expect(publish.mock.lastCall![0]?.width).toBe(4096);
  const first=publish.mock.lastCall![0];expect(first.tiles.every((t:{width:number;height:number})=>t.width<=512&&t.height<=512)).toBe(true);
  options.zoom=2;h.render(false);drain();expect(publish.mock.lastCall![0]).not.toBeNull();
  h.render(true);expect(publish).toHaveBeenLastCalledWith(null);expect(jobs.size).toBe(0);
  act(()=>root.unmount());expect(publish).toHaveBeenLastCalledWith(null);
});

it.each([
  {mask:false,selection:false,several:false,id:"layer.delete",params:null},
  {mask:false,selection:true,several:false,id:"edit.clear",params:{color:"#ffffff"}},
  {mask:true,selection:false,several:false,id:"layer.layerMask.delete",params:null},
  {mask:true,selection:true,several:false,id:"edit.fillBackground",params:{color:"#000000"}},
  {mask:true,selection:false,several:true,id:"layer.delete",params:null}
])("Delete 跟随图层、选区和蒙版目标：$id（mask=$mask selection=$selection several=$several）", ({mask,selection,several,id,params}) => {
  const {container,dispatch,snapshot,render}=setup(false,{hasSelection:selection,document:{editTarget:mask?"mask":"pixels",selectedLayers:several?[1,2]:[1],
    layers:[{id:1,name:"目标",kind:"raster",hasMask:mask},...(several?[{id:2,name:"第二层",kind:"raster"}]:[])]}});
  for(const command of ["layer.delete","layer.layerMask.delete","edit.clear","edit.fillBackground"]) snapshot.commands.set(command,{allowed:true,enabled:true} as never);
  render(false);
  act(()=>container.querySelector('.photo-editor')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true})));
  expect(dispatch.mock.calls).toEqual([[id,params]]);
});

it("多选时菜单和 Ctrl+E 共用合并所选图层命令", () => {
  const {container,dispatch,snapshot,render}=setup(false,{document:{selectedLayers:[1,3],layers:[
    {id:1,name:"所选一",kind:"raster"},{id:2,name:"未选",kind:"raster"},{id:3,name:"所选二",kind:"raster"}
  ]}});
  snapshot.commands.set("layer.mergeLayers",{allowed:true,enabled:true} as never);render(false);
  press(container.querySelector('.photo-editor')!,"e",{ctrlKey:true});
  const trigger=[...container.querySelectorAll<HTMLButtonElement>('.photo-editor__menubar button')].find(button=>button.textContent==='图层')!;
  press(trigger,"Enter");
  const merge=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent?.startsWith('合并图层'))!;
  act(()=>merge.click());
  expect(dispatch.mock.calls).toEqual([["layer.mergeLayers",null],["layer.mergeLayers",null]]);
});


it("Ctrl Tab 从字段循环文档，绕回并拒绝半笔与重复事件",()=>{
 const onActivateDocument=vi.fn();
 const {container}=setup(false,{documents:{list:[{id:"a",name:"A",active:true},{id:"b",name:"B",active:false},{id:"c",name:"C",active:false}],onActivateDocument}});
 const field=container.querySelector("input")!;
 expect(press(field,"Tab",{ctrlKey:true}).defaultPrevented).toBe(true);
 expect(onActivateDocument.mock.lastCall).toEqual(["b"]);
 press(field,"Tab",{ctrlKey:true,shiftKey:true});expect(onActivateDocument.mock.lastCall).toEqual(["c"]);
 canvasPort.hasGesture.mockReturnValue(true);press(field,"Tab",{ctrlKey:true});
 canvasPort.hasGesture.mockReturnValue(false);press(field,"Tab",{ctrlKey:true,repeat:true});
 press(field,"Tab",{ctrlKey:true,isComposing:true});expect(onActivateDocument).toHaveBeenCalledTimes(2);
});


it("移动变换控件独立于Extras，工具栏列数持久化且不分派工程命令",()=>{
 const {container,dispatch}=setup(false,{hasSelection:true,document:{transformFrame:[10,10,100,100]}});
 const editor=container.querySelector(".photo-editor")!;press(editor,"v");
 const toggle=[...container.querySelectorAll("label")].find(label=>label.textContent==="显示变换控件")!.querySelector("input")!;
 expect(canvasPort.props!.transformFrame).toEqual([10,10,100,100]);
 act(()=>toggle.click());expect(canvasPort.props!.transformFrame).toBeNull();expect(canvasPort.props!.showSelectionEdges).toBe(true);
 press(editor,"h",{ctrlKey:true});press(editor,"h",{ctrlKey:true});expect(canvasPort.props!.transformFrame).toBeNull();
 act(()=>toggle.click());expect(canvasPort.props!.transformFrame).toEqual([10,10,100,100]);
 act(()=>container.querySelector<HTMLButtonElement>('[title="切换为双列工具栏"]')!.click());
 expect(container.querySelector('.photo-editor__toolrail')!.getAttribute('data-columns')).toBe("2");
 expect(JSON.parse(localStorage.getItem("woohaa.image-editor.panels.v1")!).toolbarDouble).toBe(true);
 expect(container.querySelector('.photo-editor__tool-list .photo-editor__colors')).toBeNull();expect(dispatch).not.toHaveBeenCalled();
});


it("选框宽高交换同步画布，空字段关闭创建而不复用上次有效尺寸",()=>{
 const {container,dispatch}=setup();
 const label=(text:string)=>[...container.querySelectorAll(".photo-editor__contextbar label")].find(label=>label.firstChild?.textContent===text)!;
 const select=label("样式").querySelector("select")!;act(()=>{select.value="size";select.dispatchEvent(new Event("change",{bubbles:true}));});
 const field=(name:string)=>label(name).querySelector("input")!;
 const input=(node:HTMLInputElement,value:string)=>act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(node,value);node.dispatchEvent(new Event("input",{bubbles:true}));});
 input(field("宽"),"80");input(field("高"),"40");expect(canvasPort.props!.marqueeConstraint).toEqual({mode:"size",width:80,height:40});
 act(()=>container.querySelector<HTMLButtonElement>('[title="交换选框宽高"]')!.click());expect(canvasPort.props!.marqueeConstraint).toEqual({mode:"size",width:40,height:80});
 input(field("宽"),"");expect(canvasPort.props!.tool).toBe("none");input(field("宽"),"20");expect(canvasPort.props!.tool).toBe("marquee");expect(dispatch).not.toHaveBeenCalled();
});


it("命令搜索复用已有命令与工具入口，最近项持久化，关闭不执行，门禁变化拒绝迟到选择",async()=>{
 const dialogs=new DialogService();const {container,dispatch,snapshot,render}=setup(false,{dialogs});
 snapshot.commands.set("layer.renameLayer",{allowed:true,enabled:true} as never);snapshot.commands.set("layer.delete",{allowed:true,enabled:true} as never);render(false);
 const editor=container.querySelector(".photo-editor")!;
 const open=()=>{press(editor,"f",{ctrlKey:true});expect(dialogs.isModalActive()).toBe(true);};
 const query=(value:string)=>{const input=container.querySelector<HTMLInputElement>('.photo-editor-command-search__query')!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});return input;};
 const row=()=>container.querySelector<HTMLButtonElement>('.photo-editor-command-search__results button')!;
 open();query("画笔");await act(async()=>row().click());expect(dialogs.isModalActive()).toBe(false);expect(canvasPort.props!.tool).toBe("brush");expect(dispatch).not.toHaveBeenCalled();
 expect(JSON.parse(localStorage.getItem("photocraft.command-search.recent.v1")!)[0]).toBe("tool:brush");
 open();expect(row().textContent).toContain("画笔");query("删除图层");snapshot.commands.set("layer.delete",{allowed:true,enabled:false} as never);act(()=>row().click());expect(dialogs.isModalActive()).toBe(true);expect(dispatch).not.toHaveBeenCalled();
 const input=query("不存在的命令");expect(container.textContent).toContain("没有匹配的命令");press(input,"Enter");expect(dispatch).not.toHaveBeenCalled();
 press(input,"Escape");expect(dialogs.isModalActive()).toBe(false);expect(dispatch).not.toHaveBeenCalled();
 snapshot.commands.set("layer.hideLayers",{allowed:true,enabled:true} as never);
 open();const commandInput=query("隐藏 / 显示所选图层");press(commandInput,"ArrowDown");press(commandInput,"ArrowUp");press(commandInput,"Enter");
 expect(dialogs.isModalActive()).toBe(false);expect(dispatch.mock.calls).toEqual([["layer.hideLayers",null]]);
 localStorage.removeItem("photocraft.command-search.recent.v1");
});


it("Move仅边界偏好推迟像素候选直到释放，取消不提交，显式自由变换继续实时预览",()=>{
 localStorage.setItem("photocraft.editor-preferences.v1",JSON.stringify({showBoundingBoxWhenDraggingLayer:true}));
 try {
 const {container,transform}=setup(false,{document:{transformFrame:[10,10,100,100]}});const editor=container.querySelector(".photo-editor")!;press(editor,"v");
 act(()=>canvasPort.props!.onMoveStart!({x:30,y:40},{duplicate:false,toggleAuto:false,add:false}));
 act(()=>canvasPort.props!.onMovePreview!([1,0,0,1,30,20]));expect(transform.previewTransform).not.toHaveBeenCalled();expect(canvasPort.props!.transformMatrix).toEqual([1,0,0,1,30,20]);
 act(()=>canvasPort.props!.onMoveEnd!([1,0,0,1,40,25]));expect(transform.previewTransform).toHaveBeenLastCalledWith([1,0,0,1,40,25]);expect(transform.commitTransform).toHaveBeenCalledOnce();
 transform.previewTransform.mockClear();act(()=>canvasPort.props!.onMoveStart!({x:30,y:40},{duplicate:false,toggleAuto:false,add:false}));act(()=>canvasPort.props!.onMovePreview!([1,0,0,1,50,40]));act(()=>canvasPort.props!.onMoveCancel!());expect(transform.previewTransform).not.toHaveBeenCalled();expect(transform.commitTransform).toHaveBeenCalledOnce();expect(transform.cancelTransform).toHaveBeenCalledOnce();
 press(editor,"t",{ctrlKey:true});act(()=>canvasPort.props!.onTransformPreview!([1,0,0,1,60,30]));press(editor,"Enter");expect(transform.previewTransform).toHaveBeenLastCalledWith([1,0,0,1,60,30]);
 }finally{localStorage.removeItem("photocraft.editor-preferences.v1");}
});

it("工具短按保持，按住300ms恢复；使用画布后等半笔结束再恢复",()=>{
 let now=0;const clock=vi.spyOn(performance,"now").mockImplementation(()=>now);
 try {const {container}=setup(),editor=container.querySelector<HTMLElement>(".photo-editor")!,canvas=container.querySelector<HTMLElement>('[data-canvas]')!;
 const up=(key:string)=>act(()=>editor.dispatchEvent(new KeyboardEvent("keyup",{key,bubbles:true,cancelable:true})));
 press(editor,"b");expect(localStorage.getItem("photocraft.tools.v1.current")).toBeNull();now=100;up("b");expect(canvas.dataset.tool).toBe("brush");expect(JSON.parse(localStorage.getItem("photocraft.tools.v1.current")!)).toBe("brush");
 now=200;press(editor,"e");expect(JSON.parse(localStorage.getItem("photocraft.tools.v1.current")!)).toBe("brush");now=500;up("e");expect(canvas.dataset.tool).toBe("brush");
 now=600;press(editor,"v");act(()=>canvas.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));canvasPort.hasGesture.mockReturnValue(true);now=601;up("v");expect(canvas.dataset.tool).toBe("move");
 canvasPort.hasGesture.mockReturnValue(false);act(()=>canvas.dispatchEvent(new MouseEvent("pointerup",{button:0,bubbles:true})));expect(canvas.dataset.tool).toBe("brush");
 }finally{clock.mockRestore();}
});
it("按住工具时显式点击另一个工具取消旧恢复请求，失焦不遗留临时工具",()=>{
 let now=0;const clock=vi.spyOn(performance,"now").mockImplementation(()=>now);
 try {const {container}=setup(),editor=container.querySelector<HTMLElement>(".photo-editor")!,canvas=container.querySelector<HTMLElement>('[data-canvas]')!;
 press(editor,"b");act(()=>container.querySelector<HTMLButtonElement>('button[aria-label="橡皮擦"]')!.click());now=500;act(()=>editor.dispatchEvent(new KeyboardEvent("keyup",{key:"b",bubbles:true})));expect(canvas.dataset.tool).toBe("eraser");
 press(editor,"h");act(()=>window.dispatchEvent(new Event("blur")));expect(canvas.dataset.tool).toBe("eraser");
 }finally{clock.mockRestore();}
});

it("油漆桶选项沿画布点按分派严格参数，无效输入与只读不提交",()=>{
 const {container,dispatch,snapshot,render}=setup();snapshot.commands.set("paint.bucket",{allowed:true,enabled:true} as never);
 act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="油漆桶"]')!.click());
 expect(canvasPort.props?.tool).toBe("bucket");act(()=>canvasPort.props?.onBucket?.({x:12.5,y:24}));
 expect(dispatch).toHaveBeenLastCalledWith("paint.bucket",{contents:"foreground",opacity:100,tolerance:32,antiAlias:true,contiguous:true,sampleAllLayers:false,x:12.5,y:24,color:"#000000",target:"pixels"});
 const field=container.querySelector<HTMLInputElement>('[aria-label="油漆桶选项"] input[data-numeric-input]')!;
 act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,"");field.dispatchEvent(new Event("input",{bubbles:true}));});
 dispatch.mockClear();act(()=>canvasPort.props?.onBucket?.({x:10,y:10}));expect(dispatch).not.toHaveBeenCalled();expect(container.textContent).toContain("1–100%");
 render(true);expect(canvasPort.props?.tool).toBe("none");act(()=>canvasPort.props?.onBucket?.({x:10,y:10}));expect(dispatch).not.toHaveBeenCalled();
});

it("绘画方向键调整笔尖1°/15°，Alt与Mod保持原门禁，笔迹使用最新角度",()=>{
 const {container,dispatch}=setup();act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="画笔"]')!.click());
 const editor=container.querySelector(".photo-editor")!,angle=()=>container.querySelector<HTMLInputElement>('[aria-label="画笔"] input[data-numeric-input]')!.value;
 press(editor,"ArrowRight");expect(angle()).toBe("1");press(editor,"ArrowLeft",{shiftKey:true});expect(angle()).toBe("-14");
 press(editor,"ArrowRight",{altKey:true});press(editor,"ArrowRight",{ctrlKey:true});expect(angle()).toBe("-14");expect(dispatch).not.toHaveBeenCalled();
});

it("Mod+O复用宿主打开入口，IME与半笔不弹选择器",()=>{
 const open=vi.fn(),{container}=setup(false,{documents:{onOpenFile:open}}),editor=container.querySelector(".photo-editor")!;
 press(editor,"o",{ctrlKey:true});expect(open).toHaveBeenCalledOnce();
 press(editor,"o",{ctrlKey:true,isComposing:true});expect(open).toHaveBeenCalledOnce();
 canvasPort.hasGesture.mockReturnValue(true);press(editor,"o",{ctrlKey:true});expect(open).toHaveBeenCalledOnce();
});

it("Shift+B循环铅笔，独立笔头记忆，自动擦除与橡皮模式控件按工具显示",()=>{
 const {container,dispatch}=setup();const editor=container.querySelector(".photo-editor")!;
 press(editor,"b");press(editor,"B",{shiftKey:true});expect(canvasPort.props!.tool).toBe("pencil");expect(canvasPort.props!.brushSize).toBe(1);
 const group=container.querySelector<HTMLElement>('section[aria-label="画笔"]')!;
 const auto=[...group.querySelectorAll("label")].find(label=>label.textContent?.includes("自动擦除"))!.querySelector<HTMLInputElement>("input")!;
 expect(auto.checked).toBe(false);act(()=>auto.click());expect(auto.checked).toBe(true);
 press(editor,"B",{shiftKey:true});expect(canvasPort.props!.tool).toBe("mixer");press(editor,"B",{shiftKey:true});expect(canvasPort.props!.tool).toBe("colorReplacement");press(editor,"B",{shiftKey:true});expect(canvasPort.props!.tool).toBe("brush");expect(canvasPort.props!.brushSize).not.toBe(1);
 press(editor,"e");const mode=[...group.querySelectorAll("select")].find(select=>[...select.options].some(option=>option.value==="block"))!;
 act(()=>{mode.value="block";mode.dispatchEvent(new Event("change",{bubbles:true}));});expect(canvasPort.props!.eraserMode).toBe("block");
 expect(group.querySelector<HTMLInputElement>('input[data-numeric-input]')!.disabled).toBe(true);expect(mode.disabled).toBe(false);expect(dispatch).not.toHaveBeenCalled();
});

it("反引号临时擦除不切工具，keyup跨字段恢复，失焦与IME不残留",()=>{
 vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const {container,strokePort}=setup();const editor=container.querySelector(".photo-editor")!;
 const stroke=()=>{act(()=>canvasPort.props!.onStrokeStart?.({x:4,y:4}));const params=strokePort.beginStroke.mock.lastCall?.[0] as unknown as Record<string,unknown>;act(()=>canvasPort.props!.onStrokeCancel?.());return params;};
 act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="画笔"]')!.click());press(editor,"`",{code:"Backquote"});expect(stroke()).toMatchObject({erase:true});expect(canvasPort.props!.tool).toBe("brush");
 const input=container.querySelector("input")!;act(()=>input.dispatchEvent(new KeyboardEvent("keyup",{key:"`",code:"Backquote",bubbles:true})));expect(stroke()).toMatchObject({erase:false});
 press(editor,"`",{code:"Backquote",isComposing:true});expect(stroke()).toMatchObject({erase:false});
 press(input,"`",{code:"Backquote"});expect(stroke()).toMatchObject({erase:false});
 press(editor,"`",{code:"Backquote"});act(()=>window.dispatchEvent(new Event("blur")));expect(stroke()).toMatchObject({erase:false});
 chooseNativeTool(container,"pencil");press(editor,"~",{code:"Backquote",shiftKey:true});expect(stroke()).toMatchObject({erase:true,strokeCommand:"paint.pencil",autoErase:false});
});

it("绘画对称拖动只改轴候选，释放消费最终位置，Enter一次确认、Escape与失焦取消",()=>{
 const {container,snapshot,render,dispatch}=setup();
 for(const id of ["paint.setSymmetry","paint.symmetryFromPath","paint.symmetryDisable"])snapshot.commands.set(id,{allowed:true,enabled:true} as never);
 const symmetry={mode:"vertical" as const,center:[8,6] as [number,number],rotation:0,segments:[[[8,0],[8,12]]]};
 snapshot.view.document!.paintingSymmetry=symmetry;render(false);
 chooseNativeTool(container,"pencil");
 const begin=()=>act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="变换对称")!.click());
 begin();expect(canvasPort.props!.tool).toBe("none");
 const svg=container.querySelector<SVGSVGElement>(".photo-editor-canvas__symmetry")!;svg.setPointerCapture=vi.fn();svg.hasPointerCapture=()=>true;svg.releasePointerCapture=vi.fn();
 const send=(target:Element,type:string,x:number,y:number)=>{const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});act(()=>target.dispatchEvent(event));};
 send(svg.querySelector('[data-symmetry-handle="center"]')!,"pointerdown",100,100);send(svg,"pointermove",110,120);send(svg,"pointerup",114,124);
 expect(dispatch).not.toHaveBeenCalled();expect(snapshot.view.document!.paintingSymmetry).toBe(symmetry);
 press(container.querySelector(".photo-editor")!,"Enter");expect(dispatch.mock.calls).toEqual([["paint.setSymmetry",{mode:"vertical",center:[36,54],rotation:0}]]);expect(canvasPort.props!.tool).toBe("pencil");
 dispatch.mockClear();begin();press(container.querySelector(".photo-editor")!,"Escape");expect(dispatch).not.toHaveBeenCalled();expect(container.querySelector('[data-symmetry-editing="true"]')).toBeNull();
 begin();act(()=>window.dispatchEvent(new Event("blur")));expect(dispatch).not.toHaveBeenCalled();expect(container.querySelector('[data-symmetry-editing="true"]')).toBeNull();
});

it("独立吸管共享取样设置，Alt只更新背景色，不触发文档写命令",()=>{
 const {container,samplePort,dispatch,snapshot}=setup();const editor=container.querySelector(".photo-editor")!;press(editor,"i");expect(canvasPort.props!.tool).toBe("eyedropper");
 const select=(label:string,value:string)=>{const input=[...container.querySelectorAll("label")].find(node=>node.textContent?.startsWith(label))!.querySelector<HTMLSelectElement>("select")!;act(()=>{input.value=value;input.dispatchEvent(new Event("change",{bubbles:true}));});};
 select("取样尺寸","11");select("取样来源","currentAndBelowNoAdjustments");const revision=snapshot.view.document!.revision;
 act(()=>canvasPort.props!.onSampleColor?.({x:2,y:3},{background:true}));expect(samplePort).toHaveBeenLastCalledWith(2,3,{size:11,sampleLayer:"currentAndBelowNoAdjustments"});
 const swatches=container.querySelectorAll<HTMLInputElement>('.photo-editor__swatch input,.photo-editor__background-swatch input');expect(swatches[0]!.value).toBe("#000000");expect(swatches[1]!.value).toBe("#336699");
 act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="画笔"]')!.click());act(()=>canvasPort.props!.onSampleColor?.({x:4,y:5}));expect(samplePort).toHaveBeenLastCalledWith(4,5,{size:11,sampleLayer:"currentAndBelowNoAdjustments"});expect(swatches[0]!.value).toBe("#336699");expect(dispatch).not.toHaveBeenCalled();expect(snapshot.view.document!.revision).toBe(revision);
});

it("状态栏数值缩放和信息切换只更新取景/本机选择，不分派文档命令",()=>{
 const {container,dispatch,snapshot}=setup();const revision=snapshot.view.document!.revision;const input=container.querySelector<HTMLInputElement>(".photo-editor__zoom-field")!;
 act(()=>{input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"150%");input.dispatchEvent(new Event("input",{bubbles:true}));});press(input,"Enter");expect(canvasPort.zoomTo).toHaveBeenCalledWith(1.5);
 const select=container.querySelector<HTMLSelectElement>(".photo-editor__status-choice")!;act(()=>{select.value="tool";select.dispatchEvent(new Event("change",{bubbles:true}));});chooseNativeTool(container,"pencil");expect(container.querySelector('[data-document-status="tool"]')!.textContent).toBe("铅笔");expect(dispatch).not.toHaveBeenCalled();expect(snapshot.view.document!.revision).toBe(revision);
 localStorage.removeItem("photocraft.status-info.v1");
});

it("批量关闭快捷键走宿主，半笔、IME与只读门禁保护文档",()=>{
 const all=vi.fn(),others=vi.fn();const {container,render}=setup(false,{documents:{onCloseAllDocuments:all,onCloseOtherDocuments:others,list:[{id:"a",name:"a",active:true},{id:"b",name:"b",active:false}]}});const editor=container.querySelector(".photo-editor")!;
 press(editor,"w",{ctrlKey:true,altKey:true});press(editor,"p",{ctrlKey:true,altKey:true});expect(all).toHaveBeenCalledOnce();expect(others).toHaveBeenCalledOnce();
 canvasPort.hasGesture.mockReturnValue(true);press(editor,"w",{ctrlKey:true,altKey:true});canvasPort.hasGesture.mockReturnValue(false);press(editor,"w",{ctrlKey:true,altKey:true,isComposing:true});render(true);press(editor,"p",{ctrlKey:true,altKey:true});expect(all).toHaveBeenCalledOnce();expect(others).toHaveBeenCalledOnce();
});

it("主题亮度快捷键只改局部外观，字段和IME不触发，不修改工程或宿主主题",()=>{
 localStorage.removeItem("photocraft.interface-theme.v1");
 const {container,dispatch,snapshot}=setup();const editor=container.querySelector(".photo-editor")!,scope=container.querySelector<HTMLElement>("[data-editor-theme]")!,revision=snapshot.view.document!.revision;
 document.documentElement.style.setProperty("--app-web-panel","host-color");
 press(editor,"F1",{ctrlKey:true,shiftKey:true});expect(scope.dataset.editorTheme).toBe("pro");
 press(editor,"F2",{ctrlKey:true,shiftKey:true});expect(scope.dataset.editorTheme).toBe("proMedium");
 press(container.querySelector("input")!,"F2",{ctrlKey:true,shiftKey:true});press(editor,"F2",{ctrlKey:true,shiftKey:true,isComposing:true});expect(scope.dataset.editorTheme).toBe("proMedium");
 press(editor,"F2",{ctrlKey:true,shiftKey:true});expect(scope.dataset.editorTheme).toBe("proLightGray");
 expect(dispatch).not.toHaveBeenCalled();expect(snapshot.view.document!.revision).toBe(revision);expect(document.documentElement.style.getPropertyValue("--app-web-panel")).toBe("host-color");localStorage.removeItem("photocraft.interface-theme.v1");
});

it("偏好弹窗不会因自身modalActive立即关闭，配色覆盖renderer且取消保留设置",async()=>{
 const dialogs=new DialogService();const {container,dispatch}=setup(false,{dialogs});
 const edit=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent?.startsWith("编辑"))!;
 await act(async()=>edit.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));
 const preferences=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="偏好设置…")!;expect(preferences).toBeDefined();
 await act(async()=>preferences.click());expect(dialogs.top()?.dialogId).toBe("image-editor.preferences");
 const dialog=document.querySelector<HTMLElement>('[aria-label="编辑器偏好设置"]')!;expect(dialog).not.toBeNull();expect(dialog.closest("[data-editor-theme]")).not.toBeNull();
 await act(async()=>[...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消")!.click());expect(dialogs.top()).toBeNull();expect(dispatch).not.toHaveBeenCalled();
});

it("工具图标右键重置仅当前画笔，全部重置先确认并保留前后景色和工程",async()=>{
 const dialogs=new DialogService();const {container,dispatch}=setup(false,{dialogs});
 const choose=(label:string)=>chooseNativeTool(container,label==="铅笔"?"pencil":"brush");
 const editSize=(value:string)=>act(()=>{const input=[...container.querySelectorAll<HTMLInputElement>('.photo-editor__contextbar input[data-numeric-input]')].find(input=>input.parentElement!.textContent?.includes("尺寸"))!;expect(input).toBeDefined();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
 const menu=async(label:string)=>{await act(async()=>container.querySelector(".photo-editor__tool-label")!.dispatchEvent(new MouseEvent("contextmenu",{clientX:20,clientY:20,bubbles:true,cancelable:true})));const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent===label)!;expect(item).toBeDefined();await act(async()=>item.click());};
 choose("画笔");editSize("77");choose("铅笔");editSize("9");choose("画笔");expect(canvasPort.props!.brushSize).toBe(77);
 await menu("重置当前工具");expect(canvasPort.props!.brushSize).toBe(24);choose("铅笔");expect(canvasPort.props!.brushSize).toBe(9);
 const fg=container.querySelector<HTMLInputElement>(".photo-editor__swatch input")!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(fg,"#2468ac");fg.dispatchEvent(new Event("input",{bubbles:true}));});
 await menu("重置全部工具…");expect(dialogs.top()?.dialogId).toBe("image-editor.reset-all-tools");expect(canvasPort.props!.brushSize).toBe(9);
 const click=async(text:string)=>act(async()=>[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button=>button.textContent===text)!.click());
 await click("取消");expect(canvasPort.props!.brushSize).toBe(9);await menu("重置全部工具…");await click("重置全部");expect(canvasPort.props!.brushSize).toBe(1);expect(fg.value).toBe("#2468ac");choose("画笔");expect(canvasPort.props!.brushSize).toBe(24);expect(dispatch).not.toHaveBeenCalled();
});

it("颜色选择器复用宿主栈，取消不改前景，确认只改工具颜色，前后景及蒙版分别记忆",()=>{
 const dialogs=new DialogService(),{container,dispatch,snapshot,render}=setup(false,{dialogs});const front=()=>container.querySelector<HTMLInputElement>('.photo-editor__swatch input')!,back=()=>container.querySelector<HTMLInputElement>('.photo-editor__background-swatch input')!;
 const open=()=>act(()=>front().click());const hex=()=>document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]:not([data-numeric-input])')!;
 const input=(value:string)=>act(()=>{const field=hex();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});const cancel=()=>act(()=>[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button=>button.textContent==="取消")!.click());
 open();expect(document.querySelector('[role="dialog"]')?.textContent).toContain("颜色选择器");input("#c04020");cancel();expect(front().value).toBe("#000000");open();input("#c04020");act(()=>document.querySelector('[role="dialog"] form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(front().value).toBe("#c04020");expect(back().value).toBe("#ffffff");expect(dispatch).not.toHaveBeenCalled();
 snapshot.view.document!.editTarget="mask";render(false);expect(front().value).toBe("#ffffff");expect(back().value).toBe("#000000");open();input("#999999");act(()=>document.querySelector('[role="dialog"] form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));snapshot.view.document!.editTarget="pixels";render(false);expect(front().value).toBe("#c04020");snapshot.view.document!.editTarget="mask";render(false);expect(front().value).toBe("#999999");expect(dispatch).not.toHaveBeenCalled();
});

it("Move悬停使用只读内核候选，自动选择/修饰键/选区/蒙版/只读决定门禁，不改正式选择",()=>{
 const value={layer:9,frame:[10,20,30,40] as [number,number,number,number]},{container,hoverPort,dispatch,snapshot,render}=setup(false,{hover:value});press(container.querySelector(".photo-editor")!,"v");
 const hover=(toggleAuto=false)=>{let result:unknown;act(()=>{result=canvasPort.props!.onMoveHover?.({x:30,y:40},{toggleAuto});});return result;};const before=snapshot.view.document!.activeLayerId;
 expect(hover()).toEqual(value);expect(hoverPort).toHaveBeenLastCalledWith({x:30,y:40,target:"group"});hoverPort.mockClear();expect(hover(true)).toBeNull();expect(hoverPort).not.toHaveBeenCalled();
 act(()=>[...container.querySelectorAll("label")].find(node=>node.textContent?.startsWith("自动选择"))!.querySelector("input")!.click());expect(hover()).toBeNull();expect(hover(true)).toEqual(value);
 snapshot.view.document!.hasSelection=true;render(false);hoverPort.mockClear();expect(hover(true)).toBeNull();expect(hoverPort).not.toHaveBeenCalled();snapshot.view.document!.hasSelection=false;snapshot.view.document!.editTarget="mask";render(false);expect(hover(true)).toBeNull();snapshot.view.document!.editTarget="pixels";render(true);expect(hover(true)).toBeNull();expect(snapshot.view.document!.activeLayerId).toBe(before);expect(dispatch).not.toHaveBeenCalled();
});

it("Window工具栏与选项栏独立控制，Tab恢复原组合且保持工具节点和文档",async()=>{
 const {container,dispatch}=setup(),editor=container.querySelector(".photo-editor")!,rail=container.querySelector<HTMLElement>(".photo-editor__toolrail")!,options=container.querySelector<HTMLElement>(".photo-editor__contextbar")!;
 const click=async(name:string)=>{await act(async()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="窗口")!.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent===name)!;expect(item).toBeTruthy();act(()=>item.click());};
 await click("选项栏");expect(options.hidden).toBe(true);expect(rail.hidden).toBe(false);
 press(editor,"Tab");expect(rail.hidden).toBe(true);press(editor,"Tab");expect(rail.hidden).toBe(false);expect(options.hidden).toBe(true);
 await click("工具栏");expect(rail.hidden).toBe(true);await click("选项栏");expect(options.hidden).toBe(false);expect(rail.hidden).toBe(true);
 press(editor,"Tab");press(editor,"Tab");expect(rail.hidden).toBe(true);expect(options.hidden).toBe(false);
 expect(container.querySelector(".photo-editor__toolrail")).toBe(rail);expect(dispatch).not.toHaveBeenCalled();
});

it.each([
 ["brightnessContrast",{brightness:30,contrast:20},{brightness:0,contrast:0}],
 ["hueSaturation",{hue:30,saturation:20,lightness:10},{hue:0,saturation:0,lightness:0}]
] as const)("%s单项双击仅复位当前值，整层恢复默认值合并为同一草稿并同步确认",(kind,params,defaults)=>{
 vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const {container,adjustmentPort,dispatch,render}=setup(false,{document:{layers:[{id:1,kind:"adjustment",name:"调色",adjustment:{kind,params}}]}});
 const slider=container.querySelector<HTMLInputElement>('[data-adjustment-control] input')!,first=kind==="brightnessContrast"?"brightness":"hue";
 act(()=>slider.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true})));expect(adjustmentPort.previewAdjustment).toHaveBeenLastCalledWith({[first]:0});expect(adjustmentPort.commitAdjustment).toHaveBeenCalledOnce();
 const reset=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="恢复调整默认值")!;act(()=>reset.click());expect(adjustmentPort.previewAdjustment).toHaveBeenLastCalledWith(defaults);expect(adjustmentPort.commitAdjustment).toHaveBeenCalledTimes(2);expect(dispatch).not.toHaveBeenCalled();
 render(true);act(()=>reset.click());act(()=>slider.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true})));expect(adjustmentPort.commitAdjustment).toHaveBeenCalledTimes(2);
});


it("缩放连续拖动选项存本机并传给画布，页面导航只路由视图且不抢数值字段",()=>{
 const {container,dispatch,render}=setup(),editor=container.querySelector(".photo-editor")!;
 act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="缩放"]')!.click());
 expect(canvasPort.props!.zoomScrubby).toBe(true);
 const toggle=[...container.querySelectorAll<HTMLLabelElement>("label")].find(label=>label.textContent==="左右拖动连续缩放")!.querySelector<HTMLInputElement>("input")!;
 act(()=>toggle.click());expect(canvasPort.props!.zoomScrubby).toBe(false);expect(JSON.parse(localStorage.getItem("photocraft.tools.v1.zoom.scrubby")!)).toBe(false);
 press(editor,"PageDown",{ctrlKey:true,shiftKey:true});expect(canvasPort.navigate).toHaveBeenLastCalledWith({key:"PageDown",horizontal:true,small:true});
 const before=canvasPort.navigate.mock.calls.length;
 press(container.querySelector<HTMLInputElement>('input[data-numeric-input]')!,"Home");expect(canvasPort.navigate).toHaveBeenCalledTimes(before);
 render(true);press(editor,"PageDown");expect(canvasPort.navigate).toHaveBeenCalledTimes(before);expect(dispatch).not.toHaveBeenCalled();
});
it("临时Hand的Space+F双向循环工作区颜色并记忆；字段、重复、半笔与松开后不循环",()=>{
 localStorage.removeItem("photocraft.editor-preferences.v1");const {container,dispatch}=setup();const editor=container.querySelector(".photo-editor")!;
 expect(canvasPort.props!.pasteboard?.color).toBe("default");press(editor," ",{code:"Space"});press(editor,"f");expect(canvasPort.props!.pasteboard?.color).toBe("black");
 press(editor,"F",{shiftKey:true});expect(canvasPort.props!.pasteboard?.color).toBe("default");press(editor,"F",{shiftKey:true});expect(canvasPort.props!.pasteboard?.color).toBe("custom");
 expect(JSON.parse(localStorage.getItem("photocraft.editor-preferences.v1")!).pasteboard.color).toBe("custom");
 press(editor,"f",{repeat:true});press(container.querySelector("input")!,"f");expect(canvasPort.props!.pasteboard?.color).toBe("custom");
 canvasPort.hasGesture.mockReturnValue(true);press(editor,"f");expect(canvasPort.props!.pasteboard?.color).toBe("custom");canvasPort.hasGesture.mockReturnValue(false);
 act(()=>editor.dispatchEvent(new KeyboardEvent("keyup",{key:" ",code:"Space",bubbles:true})));press(editor,"f");expect(canvasPort.props!.pasteboard?.color).toBe("custom");expect(dispatch).not.toHaveBeenCalled();localStorage.removeItem("photocraft.editor-preferences.v1");
});
it("Window修饰键面板锁存三键，关闭保留至再次关闭按键，切面板不改工程",async()=>{
 const {container,dispatch,render}=setup();
 const open=async()=>{const trigger=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent?.startsWith("窗口"))!;await act(async()=>trigger.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const item=[...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"],[role="menuitem"]')].find(node=>node.textContent==="修饰键")!;await act(async()=>item.click());};
 await open();const panel=()=>container.querySelector<HTMLElement>(".photo-editor__modifier-keys")!;
 expect(panel()).not.toBeNull();act(()=>panel().querySelectorAll<HTMLButtonElement>("[data-sticky-key]").forEach(button=>button.click()));expect(panel().querySelectorAll("[data-sticky-on]")).toHaveLength(3);
 act(()=>[...panel().querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="关闭")!.click());expect(panel()).toBeNull();
 await open();expect(panel().querySelectorAll("[data-sticky-on]")).toHaveLength(3);act(()=>panel().querySelector<HTMLButtonElement>('[data-sticky-key="alt"]')!.click());expect(panel().querySelectorAll("[data-sticky-on]")).toHaveLength(2);
 render(true);expect([...panel().querySelectorAll<HTMLButtonElement>("[data-sticky-key]")].every(button=>button.disabled)).toBe(true);expect(dispatch).not.toHaveBeenCalled();
});

it("F三屏模式保留原工具组合，全屏Tab只临时chrome，滚动条随模式，浏览器退出恢复",async()=>{
  let full:Element|null=null;
  Object.defineProperty(document,"fullscreenElement",{configurable:true,get:()=>full});
  const changed=()=>document.dispatchEvent(new Event("fullscreenchange"));
  const request=vi.fn(async()=>{full=document.documentElement;changed();}),exit=vi.fn(async()=>{full=null;changed();});
  Object.defineProperty(document.documentElement,"requestFullscreen",{configurable:true,value:request});Object.defineProperty(document,"exitFullscreen",{configurable:true,value:exit});
  const {container,dispatch,render}=setup(),editor=container.querySelector(".photo-editor")!,rail=container.querySelector<HTMLElement>(".photo-editor__toolrail")!,options=container.querySelector<HTMLElement>(".photo-editor__contextbar")!,sidebar=container.querySelector<HTMLElement>(".photo-editor__sidebar")!;
  const mode=()=>editor.getAttribute("data-screen-mode");
  try{
    press(editor,"Tab");press(editor,"Tab");press(editor,"Tab",{shiftKey:true});expect(sidebar.hidden).toBe(true);
    await act(async()=>press(editor,"f"));expect(mode()).toBe("fullScreenWithMenuBar");expect(request).toHaveBeenCalledTimes(1);expect(canvasPort.props!.showScrollbars).toBe(false);expect(rail.hidden).toBe(false);expect(sidebar.hidden).toBe(true);
    press(editor,"f");expect(mode()).toBe("fullScreen");expect(rail.hidden&&options.hidden&&sidebar.hidden).toBe(true);expect(editor.getAttribute("data-editor-chrome")).toBe("hidden");
    press(editor,"Tab");expect(rail.hidden||options.hidden).toBe(false);expect(sidebar.hidden).toBe(true);expect(editor.hasAttribute("data-editor-chrome")).toBe(false);
    press(editor,"Tab");expect(rail.hidden).toBe(true);expect(canvasPort.props!.showScrollbars).toBe(false);
    act(()=>{full=null;changed();});expect(mode()).toBe("standard");expect(rail.hidden||options.hidden).toBe(false);expect(sidebar.hidden).toBe(true);expect(canvasPort.props!.showScrollbars).toBe(true);
    press(container.querySelector("input")!,"f");press(editor,"f",{repeat:true});press(editor,"f",{isComposing:true});canvasPort.hasGesture.mockReturnValue(true);press(editor,"f");canvasPort.hasGesture.mockReturnValue(false);render(true);press(editor,"f");expect(request).toHaveBeenCalledTimes(1);expect(dispatch).not.toHaveBeenCalled();
    render(false);await act(async()=>press(editor,"f"));press(editor,"f");await act(async()=>press(editor,"f"));expect(mode()).toBe("standard");expect(exit).toHaveBeenCalledTimes(1);
  }finally{full=null;changed();delete (document.documentElement as Partial<HTMLElement>).requestFullscreen;delete (document as Partial<Document>).exitFullscreen;Reflect.deleteProperty(document,"fullscreenElement");}
});

it("桶数字键只改工具opacity，Shift不改图层，00保持原生1%下限；字段/IME/半笔隔离",()=>{
  const {container,dispatch,render,snapshot}=setup(),editor=container.querySelector(".photo-editor")!;
  snapshot.commands.set("paint.bucket",{allowed:true,enabled:true} as never);
  press(editor,"g");const opacity=()=>container.querySelector<HTMLInputElement>('[aria-label="油漆桶选项"] label input')!.value;
  press(editor,"2");press(editor,"9");expect(opacity()).toBe("29");expect(dispatch).not.toHaveBeenCalled();
  press(editor,"%",{code:"Digit5",shiftKey:true});expect(opacity()).toBe("29");expect(dispatch).not.toHaveBeenCalled();
  press(editor,"0");expect(opacity()).toBe("100");press(editor,"0");expect(opacity()).toBe("1");
  const field=container.querySelector<HTMLInputElement>('[aria-label="油漆桶选项"] label input')!;
  press(field,"8");press(editor,"8",{isComposing:true});press(editor,"8",{repeat:true});canvasPort.hasGesture.mockReturnValue(true);press(editor,"8");canvasPort.hasGesture.mockReturnValue(false);expect(opacity()).toBe("1");
  act(()=>canvasPort.props!.onBucket?.({x:2,y:3}));expect(dispatch).toHaveBeenLastCalledWith("paint.bucket",expect.objectContaining({opacity:1}));dispatch.mockClear();
  const saved=localStorage.getItem("photocraft.tools.v1.bucket");render(true);press(container.querySelector(".photo-editor")!,"5");expect(localStorage.getItem("photocraft.tools.v1.bucket")).toBe(saved);expect(dispatch).not.toHaveBeenCalled();
});

it("Pencil无Shift流量，Brush流量00最低1%；Pencil模式循环进入实际笔迹参数",()=>{
  const {container,dispatch,strokePort}=setup(),editor=container.querySelector(".photo-editor")!;
  press(editor,"b");press(editor,"!",{code:"Digit0",shiftKey:true});press(editor,"!",{code:"Digit0",shiftKey:true});
  const flow=()=>[...container.querySelectorAll<HTMLLabelElement>('[aria-label="画笔"] label')].find(label=>label.textContent?.startsWith("流量"))!.querySelector<HTMLInputElement>("input")!.value;
  expect(flow()).toBe("1");
  press(editor,"B",{shiftKey:true});expect(canvasPort.props!.tool).toBe("pencil");
  const before=JSON.parse(localStorage.getItem("photocraft.tools.v1.paint")!);press(editor,"%",{code:"Digit5",shiftKey:true});expect(JSON.parse(localStorage.getItem("photocraft.tools.v1.paint")!)).toEqual(before);
  press(editor,"+",{code:"Equal",shiftKey:true});act(()=>canvasPort.props!.onStrokeStart?.({x:3,y:4}));
  expect(strokePort.beginStroke).toHaveBeenLastCalledWith(expect.objectContaining({strokeCommand:"paint.pencil",mode:"Dissolve"}));expect(dispatch).not.toHaveBeenCalled();
});

it("F8与Window信息面板同状态，原生读数跟随指针/尺寸偏好，隐藏不再采样且零命令",()=>{
  let id=0;const frames=new Map<number,FrameRequestCallback>();vi.stubGlobal("requestAnimationFrame",(fn:FrameRequestCallback)=>{frames.set(++id,fn);return id;});vi.stubGlobal("cancelAnimationFrame",(id:number)=>frames.delete(id));
  const {container,dispatch,infoPort}=setup(),editor=container.querySelector(".photo-editor")!;
  const flush=()=>act(()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn(0);}});
  try{
    press(editor,"F8");expect(container.querySelector("[data-info-panel]")).not.toBeNull();flush();expect(infoPort).toHaveBeenLastCalledWith({x:null,y:null,size:1});
    act(()=>canvasPort.props!.onPointerPosition?.({x:4.4,y:5.5}));flush();expect(infoPort).toHaveBeenLastCalledWith({x:4.4,y:5.5,size:1});expect(container.querySelector("[data-info-panel]")?.textContent).toContain("800 × 600 px");
    infoPort.mockClear();press(editor,"F8");expect(container.querySelector("[data-info-panel]")).toBeNull();flush();expect(infoPort).not.toHaveBeenCalled();expect(canvasPort.props!.onPointerPosition).toBeUndefined();expect(dispatch).not.toHaveBeenCalled();
  }finally{vi.unstubAllGlobals();}
});

it("像素网格切换只读候选端口，Extras隐藏后停读且不改文档",async()=>{
  const {container,dispatch}=setup();const editor=container.querySelector(".photo-editor")!;
  const clickGrid=async()=>{await act(async()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.trim()==="视图")!.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));await act(async()=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(button=>button.textContent?.trim()==="显示")!.click());await act(async()=>[...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"],[role="menuitem"]')].find(button=>button.textContent?.trim()==="像素网格")!.click());};
  expect(canvasPort.props!.pixelGrid).toBeUndefined();await clickGrid();expect(canvasPort.props!.pixelGrid?.contextKey).toBeTruthy();
  press(editor,"h",{ctrlKey:true});expect(canvasPort.props!.pixelGrid).toBeUndefined();press(editor,"h",{ctrlKey:true});expect(canvasPort.props!.pixelGrid).toBeTruthy();
  await clickGrid();expect(canvasPort.props!.pixelGrid).toBeUndefined();expect(dispatch).not.toHaveBeenCalled();
});

it("Window直方图只读原生缓存，关闭后停止更新且不派发文档命令",async()=>{
  const {container,dispatch,histogramPort}=setup();
  const open=async()=>{await act(async()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="窗口")!.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));await act(async()=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="直方图")!.click());};
  await open();await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});expect(container.querySelector("[data-histogram-panel]")).not.toBeNull();expect(histogramPort).toHaveBeenCalledTimes(1);expect(container.querySelector("[data-histogram-panel]")?.textContent).toContain("480000");
  await open();await closeNavigatorGroup(container);expect(dispatch).not.toHaveBeenCalled();
});

it("Window导航器从主画布读取范围并路由缩放，关闭停止读取且不分派工程命令",async()=>{
  const callbacks:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",(fn:FrameRequestCallback)=>{callbacks.push(fn);return callbacks.length;});vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const {container,dispatch,navigatorPort}=setup();
  const open=async()=>{await act(async()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="窗口")!.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));await act(async()=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="导航器")!.click());};
  await open();expect(canvasPort.props!.onNavigatorFrame).toBeDefined();act(()=>{for(const fn of callbacks.splice(0))fn(0);canvasPort.props!.onNavigatorFrame?.({viewport:{x:0,y:0,zoom:.5},size:{width:800,height:600},document:{width:800,height:600}});});
  expect(navigatorPort).toHaveBeenCalledTimes(1);expect(container.querySelector("[data-navigator-panel]")?.textContent).toContain("导航预览不可用");
  const panel=container.querySelector("[data-navigator-panel]")!;act(()=>[...panel.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="+")!.click());expect(canvasPort.zoomTo).toHaveBeenLastCalledWith(2/3);
  await open();await closeNavigatorGroup(container);expect(canvasPort.props!.onNavigatorFrame).toBeUndefined();expect(dispatch).not.toHaveBeenCalled();
});

it("F2/F3/F4仅在画布无半手势时路由内部剪贴板，不抢字段/IME且只读拒绝",()=>{
 const {container,dispatch,snapshot,render}=setup(),editor=container.querySelector(".photo-editor")!;
 for(const id of ["edit.cut","edit.copy","edit.paste"])snapshot.commands.set(id,{allowed:true,enabled:true} as never);
 press(editor,"F3");expect(dispatch).toHaveBeenLastCalledWith("edit.copy",null);press(editor,"F2");expect(dispatch).toHaveBeenLastCalledWith("edit.cut",{color:"#ffffff"});press(editor,"F4");expect(dispatch).toHaveBeenLastCalledWith("edit.paste",expect.any(Object));
 dispatch.mockClear();press(container.querySelector("input")!,"F3");press(editor,"F3",{isComposing:true});press(editor,"F3",{repeat:true});canvasPort.hasGesture.mockReturnValue(true);press(editor,"F3");canvasPort.hasGesture.mockReturnValue(false);expect(dispatch).not.toHaveBeenCalled();render(true);press(editor,"F3");expect(dispatch).not.toHaveBeenCalled();
});

it("普通粘贴可见内容保持原位，离开视口后居中；选区不强制重定位",()=>{
 const {container,dispatch,snapshot,clipboardBoundsPort}=setup(false,{document:{selectionFrame:[10,20,50,80]}}),editor=container.querySelector(".photo-editor")!;
 snapshot.commands.set("edit.paste",{allowed:true,enabled:true} as never);
 clipboardBoundsPort.mockReturnValue({ok:true,value:[100,100,150,150]});press(editor,"F4");expect(dispatch).toHaveBeenLastCalledWith("edit.paste",{});
 clipboardBoundsPort.mockReturnValue({ok:true,value:[2000,2000,2100,2100]});press(editor,"F4");expect(dispatch).toHaveBeenLastCalledWith("edit.paste",{center:[400,300]});
});

it("File脚本浏览使用文件字节入口，半手势不被取消或误执行",async()=>{
 const {container,dispatch,snapshot,render}=setup();snapshot.commands.set("file.scripts.browse",{allowed:true,enabled:true} as never);render(false);
 canvasPort.cancelGesture.mockClear();
 const picker=vi.spyOn(HTMLInputElement.prototype,"click").mockImplementation(()=>{});
 const open=async()=>{
  const menu=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="文件")!;
  await act(async()=>menu.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));
  const scripts=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="脚本")!;expect(scripts).toBeDefined();await act(async()=>scripts.click());
  const browse=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="浏览脚本…")!;expect(browse).toBeDefined();await act(async()=>browse.click());
 };
 try{
  canvasPort.hasGesture.mockReturnValue(true);await open();expect(picker).not.toHaveBeenCalled();expect(canvasPort.cancelGesture).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
  canvasPort.hasGesture.mockReturnValue(false);await open();expect(picker).toHaveBeenCalledOnce();
  const input=container.querySelector<HTMLInputElement>("[data-script-import]")!;
  const file=new File(["layer.new.layer"],"steps.txt",{type:"text/plain"});Object.defineProperty(file,"arrayBuffer",{value:async()=>new TextEncoder().encode("layer.new.layer").buffer});
  await act(async()=>{Object.defineProperty(input,"files",{value:[file],configurable:true});input.dispatchEvent(new Event("change",{bubbles:true}));await Promise.resolve();});
  expect(dispatch.mock.calls).toEqual([["file.scripts.browse",{name:"steps.txt",source:"layer.new.layer"}]]);expect(canvasPort.cancelGesture).not.toHaveBeenCalled();
  const foreign=document.createElement("div");foreign.setAttribute("data-menu-bar-owner","another-editor");document.body.append(foreign);act(()=>container.querySelector(".photo-editor")!.dispatchEvent(new FocusEvent("focusout",{bubbles:true,relatedTarget:foreign})));expect(canvasPort.cancelGesture).toHaveBeenCalledOnce();foreign.remove();
 }finally{picker.mockRestore();}
});

it("Move选项栏快速对齐自动选择参照，半手势/只读拒绝并随工具收起",()=>{
 const {container,dispatch,snapshot,render}=setup(undefined,{hasSelection:true});
 const kinds=["leftEdges","horizontalCenters","rightEdges","topEdges","verticalCenters","bottomEdges"];
 for(const id of [...kinds.map(kind=>`layer.align.${kind}`),...kinds.map(kind=>`layer.distribute.${kind}`),"layer.distribute.horizontally","layer.distribute.vertically"])snapshot.commands.set(id,{allowed:true,enabled:true} as never);render(false);
 act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="移动"]')!.click());
 const quick=()=>container.querySelector<HTMLElement>(".photo-editor__contextbar [data-quick-layout]")!;
 expect(quick().querySelector("select")).toBeNull();const left=()=>quick().querySelector<HTMLButtonElement>('[aria-label="左对齐"]')!;
 canvasPort.cancelGesture.mockClear();canvasPort.hasGesture.mockReturnValue(true);act(()=>left().click());expect(dispatch).not.toHaveBeenCalled();expect(canvasPort.cancelGesture).not.toHaveBeenCalled();
 canvasPort.hasGesture.mockReturnValue(false);act(()=>left().click());expect(dispatch.mock.lastCall).toEqual(["layer.align.leftEdges",{to:"selection"}]);
 dispatch.mockClear();render(true);expect(left().disabled).toBe(true);act(()=>left().click());expect(dispatch).not.toHaveBeenCalled();
 render(false);act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="画笔"]')!.click());expect(quick()).toBeNull();
});

it("复制文档菜单在半手势不执行或取消，正常时调用宿主，只读保持禁用",async()=>{
 const duplicate=vi.fn(),{container,dispatch,render}=setup(false,{documents:{onDuplicateDocument:duplicate}});
 const open=async()=>{const image=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="图像")!;await act(async()=>image.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="复制文档")!;};
 canvasPort.cancelGesture.mockClear();canvasPort.hasGesture.mockReturnValue(true);const blocked=await open();expect(blocked).toBeDefined();await act(async()=>blocked.click());expect(duplicate).not.toHaveBeenCalled();expect(canvasPort.cancelGesture).not.toHaveBeenCalled();
 canvasPort.hasGesture.mockReturnValue(false);const ready=await open();await act(async()=>ready.click());expect(duplicate).toHaveBeenCalledOnce();expect(dispatch).not.toHaveBeenCalled();
 render(true);const readOnly=await open();expect(readOnly.getAttribute("data-disabled")).not.toBeNull();await act(async()=>readOnly.click());expect(duplicate).toHaveBeenCalledOnce();
});

it("蒙版目标的Cut使用像素背景调色盘，保留蒙版调色盘和目标",()=>{
 const oldPixel=localStorage.getItem("photocraft.tools.v1.colors"),oldMask=localStorage.getItem("photocraft.tools.v1.maskColors");
 localStorage.setItem("photocraft.tools.v1.colors",JSON.stringify({background:"#123456"}));localStorage.setItem("photocraft.tools.v1.maskColors",JSON.stringify({background:"#654321"}));
 try{const {container,snapshot,dispatch}=setup(false,{document:{editTarget:"mask",layers:[{id:1,name:"Layer",kind:"raster",hasMask:true}]}});snapshot.commands.set("edit.cut",{allowed:true,enabled:true} as never);press(container.querySelector(".photo-editor")!,"F2");expect(dispatch).toHaveBeenLastCalledWith("edit.cut",{color:"#123456"});expect(container.querySelector<HTMLInputElement>('.photo-editor__background-swatch input')!.value).toBe("#654321");expect(snapshot.view.document!.editTarget).toBe("mask");}
 finally{if(oldPixel===null)localStorage.removeItem("photocraft.tools.v1.colors");else localStorage.setItem("photocraft.tools.v1.colors",oldPixel);if(oldMask===null)localStorage.removeItem("photocraft.tools.v1.maskColors");else localStorage.setItem("photocraft.tools.v1.maskColors",oldMask);}
});

it("粘贴入快捷键与菜单复用原生命令，半手势不取消，只读遵守原门禁",async()=>{
 const {container,snapshot,dispatch,render}=setup(false,{hasSelection:true});const into="edit.pasteSpecial.pasteInto";snapshot.commands.set(into,{allowed:true,enabled:true} as never);render(false);
 const editor=container.querySelector(".photo-editor")!;press(editor,"v",{ctrlKey:true,altKey:true,shiftKey:true});expect(dispatch).toHaveBeenLastCalledWith(into,null);dispatch.mockClear();
 const open=async()=>{const edit=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="编辑")!;await act(async()=>edit.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const special=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="选择性粘贴")!;await act(async()=>special.click());return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent?.startsWith("粘贴入"))!;};
 canvasPort.hasGesture.mockReturnValue(true);canvasPort.cancelGesture.mockClear();const blocked=await open();await act(async()=>blocked.click());expect(dispatch).not.toHaveBeenCalled();expect(canvasPort.cancelGesture).not.toHaveBeenCalled();
 canvasPort.hasGesture.mockReturnValue(false);const ready=await open();await act(async()=>ready.click());expect(dispatch).toHaveBeenLastCalledWith(into,null);dispatch.mockClear();render(true);press(editor,"v",{ctrlKey:true,altKey:true,shiftKey:true});expect(dispatch).not.toHaveBeenCalled();
});


it("查找替换菜单打开专属表单，关闭零命令，半手势与只读不打开或取消候选",async()=>{
 const dialogs=new DialogService(),{container,snapshot,dispatch,render}=setup(false,{dialogs});snapshot.commands.set("edit.findAndReplaceText",{allowed:true,enabled:true} as never);render(false);
 const select=async()=>{const edit=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="编辑")!;await act(async()=>edit.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="查找和替换文字…")!;await act(async()=>item.click());};
 canvasPort.hasGesture.mockReturnValue(true);canvasPort.cancelGesture.mockClear();await select();expect(dialogs.isModalActive()).toBe(false);expect(canvasPort.cancelGesture).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
 canvasPort.hasGesture.mockReturnValue(false);await select();expect(dialogs.isModalActive()).toBe(true);expect(container.textContent).toContain("搜索所有文字图层");const finish=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="完成")!;act(()=>finish.click());expect(dialogs.isModalActive()).toBe(false);expect(dispatch).not.toHaveBeenCalled();
 render(true);await select();expect(dialogs.isModalActive()).toBe(false);expect(dispatch).not.toHaveBeenCalled();
});

it("定义图案菜单表单不因自己的模态状态立即关闭，取消不写文档",async()=>{
 const dialogs=new DialogService(),{container,snapshot,dispatch,render}=setup(false,{dialogs});snapshot.commands.set("edit.definePattern",{allowed:true,enabled:true} as never);render(false);
 const edit=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="编辑")!;await act(async()=>edit.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="定义图案…")!;await act(async()=>item.click());
 expect(dialogs.isModalActive()).toBe(true);expect(container.textContent).toContain("图案名称");const cancel=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消")!;act(()=>cancel.click());expect(dialogs.isModalActive()).toBe(false);expect(dispatch).not.toHaveBeenCalled();
});

it("Shift+F5/Shift+Backspace打开通用填充表单，确认送入当前色盘，半手势/只读不取消或写入",()=>{
 localStorage.removeItem("photocraft.fill.v1");const dialogs=new DialogService(),{container,snapshot,dispatch,render}=setup(false,{dialogs});snapshot.commands.set("edit.fill",{allowed:true,enabled:true} as never);render(false);const editor=container.querySelector(".photo-editor")!;
 const foreground=container.querySelector<HTMLInputElement>('.photo-editor__swatch input')!.value;
 canvasPort.hasGesture.mockReturnValue(true);canvasPort.cancelGesture.mockClear();press(editor,"F5",{shiftKey:true});expect(dialogs.isModalActive()).toBe(false);expect(canvasPort.cancelGesture).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
 canvasPort.hasGesture.mockReturnValue(false);press(editor,"F5",{shiftKey:true});expect(dialogs.isModalActive()).toBe(true);expect(container.textContent).toContain("保留透明度");const form=container.querySelector('[aria-label="填充"] form')!;act(()=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(dispatch).toHaveBeenLastCalledWith("edit.fill",expect.objectContaining({contents:"foreground",color:foreground,opacity:100,mode:"Normal"}));expect(dialogs.isModalActive()).toBe(false);
 dispatch.mockClear();press(editor,"Backspace",{shiftKey:true});expect(dialogs.isModalActive()).toBe(true);render(true);expect(dialogs.isModalActive()).toBe(false);press(editor,"F5",{shiftKey:true});expect(dispatch).not.toHaveBeenCalled();localStorage.removeItem("photocraft.fill.v1");
});

it("历史填充组合键不注入色盘，半手势和只读不写也不取消",()=>{
 const {container,snapshot,dispatch,render}=setup();snapshot.commands.set("edit.fillHistory",{allowed:true,enabled:true} as never);render(false);const editor=container.querySelector(".photo-editor")!;
 press(editor,"Backspace",{ctrlKey:true,altKey:true});expect(dispatch).toHaveBeenLastCalledWith("edit.fillHistory",null);dispatch.mockClear();canvasPort.hasGesture.mockReturnValue(true);canvasPort.cancelGesture.mockClear();press(editor,"Backspace",{ctrlKey:true,altKey:true});expect(dispatch).not.toHaveBeenCalled();expect(canvasPort.cancelGesture).not.toHaveBeenCalled();canvasPort.hasGesture.mockReturnValue(false);render(true);press(editor,"Backspace",{ctrlKey:true,altKey:true});expect(dispatch).not.toHaveBeenCalled();
});

it("拼写检查菜单打开专属表单，关闭零命令，半手势与只读不打开或取消候选",async()=>{
 const dialogs=new DialogService(),{container,snapshot,dispatch,render}=setup(false,{dialogs});snapshot.commands.set("edit.checkSpelling",{allowed:true,enabled:true} as never);render(false);
 const select=async()=>{const edit=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="编辑")!;await act(async()=>edit.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="检查拼写…")!;await act(async()=>item.click());};
 canvasPort.hasGesture.mockReturnValue(true);canvasPort.cancelGesture.mockClear();await select();expect(dialogs.isModalActive()).toBe(false);expect(canvasPort.cancelGesture).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
 canvasPort.hasGesture.mockReturnValue(false);await select();expect(dialogs.isModalActive()).toBe(true);expect(container.textContent).toContain("检查所有文字图层");const finish=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="完成")!;act(()=>finish.click());expect(dialogs.isModalActive()).toBe(false);expect(dispatch).not.toHaveBeenCalled();
 render(true);await select();expect(dialogs.isModalActive()).toBe(false);expect(dispatch).not.toHaveBeenCalled();
});

it("像素描边菜单打开专属表单，关闭零命令，半手势与只读不打开或取消候选",async()=>{
 const dialogs=new DialogService(),{container,snapshot,dispatch,render}=setup(false,{dialogs});snapshot.commands.set("edit.stroke",{allowed:true,enabled:true} as never);render(false);
 const select=async()=>{const edit=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="编辑")!;await act(async()=>edit.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="描边…")!;await act(async()=>item.click());};
 canvasPort.hasGesture.mockReturnValue(true);canvasPort.cancelGesture.mockClear();await select();expect(dialogs.isModalActive()).toBe(false);expect(canvasPort.cancelGesture).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
 canvasPort.hasGesture.mockReturnValue(false);await select();expect(dialogs.isModalActive()).toBe(true);expect(container.textContent).toContain("有选区时描边选区边缘");const finish=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消")!;act(()=>finish.click());expect(dialogs.isModalActive()).toBe(false);expect(dispatch).not.toHaveBeenCalled();
 render(true);await select();expect(dialogs.isModalActive()).toBe(false);expect(dispatch).not.toHaveBeenCalled();
});

it("润饰工具组短按启用润饰工具，笔画在释放时一次提交对应原生命令",()=>{
 localStorage.setItem("photocraft.tools.v1.retouch.tool",JSON.stringify("colorReplacement"));
 const first=setup();first.dispatch.mockClear();
 const {container,dispatch,snapshot,render}=first;
 snapshot.commands.set("paint.colorReplacement",{allowed:true,enabled:true} as never);
 render(false);
 chooseNativeTool(container,"colorReplacement");
 expect(canvasPort.props!.tool).toBe("colorReplacement");
 act(()=>canvasPort.props!.onStrokeStart!({x:10,y:10},{shift:false}));
 act(()=>canvasPort.props!.onStrokeMove!([{x:20,y:20},{x:30,y:30}]));
 act(()=>canvasPort.props!.onStroke!([{x:10,y:10},{x:20,y:20},{x:30,y:30}]));
 expect(dispatch.mock.lastCall?.[0]).toBe("paint.colorReplacement");
 expect(dispatch.mock.lastCall?.[1]).toMatchObject({points:[[10,10],[20,20],[30,30]],mode:"color",sampling:"continuous",limits:"contiguous",target:"pixels"});
 expect(container.querySelector(".photo-editor__contextbar")?.textContent).toContain("颜色替换画笔");
 dispatch.mockClear();
 act(()=>canvasPort.props!.onStrokeStart!({x:5,y:5},{shift:false}));act(()=>canvasPort.props!.onStrokeCancel!());
 expect(dispatch).not.toHaveBeenCalled();
 localStorage.removeItem("photocraft.tools.v1.retouch.tool");
});

it("润饰点按工具在按下时提交一次坐标，选中不可用命令时不派发",()=>{
 localStorage.setItem("photocraft.tools.v1.retouch.tool",JSON.stringify("redEye"));
 const {container,dispatch,snapshot,render}=setup();
 snapshot.commands.set("paint.redEye",{allowed:true,enabled:true} as never);
 render(false);
 chooseNativeTool(container,"redEye",7);
 act(()=>canvasPort.props!.onStrokeStart!({x:44.6,y:55.2},{shift:false}));
 expect(dispatch).toHaveBeenLastCalledWith("paint.redEye",{x:45,y:55,pupilSize:50,darken:50});
 dispatch.mockClear();snapshot.commands.set("paint.redEye",{allowed:true,enabled:false,disabledReason:"仅支持像素层"} as never);render(false);
 act(()=>canvasPort.props!.onStrokeStart!({x:44.6,y:55.2},{shift:false}));
 expect(dispatch).not.toHaveBeenCalled();
 expect(container.textContent).toContain("仅支持像素层");
 localStorage.removeItem("photocraft.tools.v1.retouch.tool");
});

it("Move空白框选按相交图层一次提交，Shift追加；pasteboard单击清除图层选择",()=>{
 const {container,dispatch,snapshot,render,controller}=setup(false,{document:{activeLayer:1,layers:[{id:1,name:"背景",kind:"raster",opacity:1,blend:"Normal"}]}});
 snapshot.commands.set("layer.selectInRect",{allowed:true,enabled:true} as never);
 snapshot.commands.set("select.deselectLayers",{allowed:true,enabled:true} as never);
 // pickLayerAt 返回 null 时进入框选回退。
 const pick=vi.fn(()=>({ok:true,value:null}));
 (controller as unknown as {pickLayerAt:typeof pick}).pickLayerAt=pick;
 render(false);
 act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="移动"]')!.click());
 const pickResult=canvasPort.props!.onMovePick!({x:10,y:10},{duplicate:false,toggleAuto:false,add:false});
 expect(pickResult).toBe("box");
 act(()=>canvasPort.props!.onMoveBoxEnd!({x:5,y:6},{x:30,y:40},false,true));
 expect(dispatch).toHaveBeenLastCalledWith("layer.selectInRect",{x:5,y:6,width:25,height:34,target:"group",mode:"replace"});
 dispatch.mockClear();
 // 每次手势各自申请框选回退；释放后所有权立即失效。
 expect(canvasPort.props!.onMovePick!({x:10,y:10},{duplicate:false,toggleAuto:false,add:false})).toBe("box");
 act(()=>canvasPort.props!.onMoveBoxEnd!({x:5,y:6},{x:30,y:40},true,true));
 expect(dispatch).toHaveBeenLastCalledWith("layer.selectInRect",expect.objectContaining({mode:"add"}));
 dispatch.mockClear();
 act(()=>canvasPort.props!.onMoveBoxEnd!({x:5,y:6},{x:30,y:40},true,true));
 expect(dispatch).not.toHaveBeenCalled();
 expect(canvasPort.props!.onMovePick!({x:10,y:10},{duplicate:false,toggleAuto:false,add:false})).toBe("box");
 act(()=>canvasPort.props!.onMoveBoxEnd!({x:5,y:6},{x:5,y:6},false,false));
 expect(dispatch).not.toHaveBeenCalled();
 expect(canvasPort.props!.onMovePick!({x:-4,y:-4},{duplicate:false,toggleAuto:false,add:false})).toBe("box");
 act(()=>canvasPort.props!.onMoveBoxEnd!({x:-4,y:-4},{x:-4,y:-4},false,false));
 expect(dispatch).toHaveBeenLastCalledWith("select.deselectLayers",{});
});
