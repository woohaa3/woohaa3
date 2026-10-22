/** @vitest-environment jsdom */
// 只验证状态和 DOM 事件，不执行图片渲染。
import { act } from "react";
import { expect, it, vi } from "vitest";
import { DialogService } from "@woohaa3/frontend/plugin-api";
import { setup, press, canvasPort, root } from "../src/test-support/photo-editor-harness.js";

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

it("操作历史可回退多个步骤，也可回到重做分支", () => {
  const { container, dispatch } = setup();
  const steps = container.querySelectorAll<HTMLButtonElement>(".photo-editor__history button");
  expect(steps).toHaveLength(5);
  expect(steps[2]!.disabled).toBe(true);
  act(() => steps[0]!.click());
  expect(dispatch.mock.calls).toEqual([["edit.undo"], ["edit.undo"]]);
  dispatch.mockClear();
  act(() => steps[4]!.click());
  expect(dispatch.mock.calls).toEqual([["edit.redo"], ["edit.redo"]]);
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


it("编组快捷键经过真实编辑器路由，输入、IME、手势和只读不触发",()=>{
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
  expect(dispatch.mock.calls).toEqual([["layer.new.layer",{name:"修边"}]]);
  expect(dialogs.isModalActive()).toBe(false);
  act(()=>container.querySelector<HTMLButtonElement>('[aria-label="新建图层"]')!.click());
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
  expect(dispatch.mock.calls).toEqual([["layer.new.layer",{}],["layer.new.layer",{}]]);
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
  expect(dispatch.mock.calls).toEqual([["layer.new.layer",{name:"修边"}]]);
});

it("工具键、临时空格与失焦恢复使用编辑器范围，不改变当前工具", () => {
  const { container } = setup();
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  expect(document.activeElement).toBe(editor);
  press(editor, "b");
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

it("默认矩形选框；H 和已移除的 C 不切换工具，选区来自内核", () => {
  const { container } = setup(false, { hasSelection: true });
  const editor = container.querySelector<HTMLElement>(".photo-editor")!;
  const canvas = container.querySelector('[data-canvas]')!;
  expect(canvas.getAttribute("data-tool")).toBe("marquee");
  expect(canvas.getAttribute("data-selection")).toBe("[[10,20,50,20],[50,20,50,60],[50,60,10,60],[10,60,10,20]]");
  press(editor, "h");
  expect(canvas.getAttribute("data-tool")).toBe("marquee");
  press(editor, "c");
  expect(canvas.getAttribute("data-tool")).toBe("marquee");
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
  expect(transform.beginTransform).not.toHaveBeenCalled();
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
  act(() => { expect(canvasPort.props!.onMoveStart?.({x:30,y:40},{duplicate:true,toggleAuto:false})).toBe(true); });
  expect(transform.beginMove).toHaveBeenLastCalledWith({x:30,y:40,duplicate:true,autoSelect:true});
  act(() => canvasPort.props!.onMoveCancel?.());
  act(() => [...container.querySelectorAll("label")].find((node) => node.textContent === "自动选择图层")!.querySelector("input")!.click());
  act(() => { canvasPort.props!.onMoveStart?.({x:35,y:45},{duplicate:false,toggleAuto:true}); });
  expect(transform.beginMove).toHaveBeenLastCalledWith({x:35,y:45,duplicate:false,autoSelect:true});
  act(() => canvasPort.props!.onMoveCancel?.());
});
it("移动方向键按住到松键合并一步，Shift 为 10px；Esc 和失焦撤回", () => {
  const {container,transform} = setup(false,{document:{transformFrame:[10,10,100,100]}});
  const editor = container.querySelector(".photo-editor")!;
  press(editor,"v"); press(editor,"ArrowRight"); press(editor,"ArrowRight",{repeat:true}); press(editor,"ArrowDown",{shiftKey:true});
  expect(transform.beginTransform).toHaveBeenCalledOnce(); expect(transform.commitTransform).not.toHaveBeenCalled();
  act(() => editor.dispatchEvent(new KeyboardEvent("keyup",{key:"ArrowRight",bubbles:true})));
  expect(transform.previewTransform).toHaveBeenLastCalledWith([1,0,0,1,2,10]);
  expect(transform.commitTransform).toHaveBeenCalledOnce();
  press(editor,"ArrowLeft"); press(editor,"Escape");
  expect(transform.cancelTransform).toHaveBeenCalledOnce(); expect(transform.commitTransform).toHaveBeenCalledOnce();
  press(editor,"ArrowUp"); act(() => window.dispatchEvent(new Event("blur")));
  expect(transform.cancelTransform).toHaveBeenCalledTimes(2);
  press(container.querySelector("input")!,"ArrowRight");
  expect(transform.beginTransform).toHaveBeenCalledTimes(3);
});

it("方向键微移后点击自由变换，先结束微移，不复用尚未结束的会话", () => {
  const {container,transform} = setup(false,{document:{transformFrame:[10,10,100,100]}});
  const editor = container.querySelector(".photo-editor")!;
  press(editor,"v"); press(editor,"ArrowRight");
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "自由变换")!.click());
  expect(transform.commitTransform).toHaveBeenCalledOnce(); expect(transform.beginTransform).toHaveBeenCalledTimes(2);
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
  act(() => canvasPort.props!.onMoveStart!({x:30,y:40},{duplicate:false,toggleAuto:true}));
  expect(transform.beginMove).toHaveBeenLastCalledWith({x:30,y:40,autoSelect:false,duplicate:false});
});

it("画笔与橡皮分别记住尺寸/不透明度/流量；前背景色共用且 X/D 可用", () => {
  const {container,dispatch}=setup(); const editor=container.querySelector(".photo-editor")!;
  const field=(name:string) => [...container.querySelectorAll<HTMLLabelElement>('[aria-label="画笔"] label')].find((label)=>label.textContent?.trim().startsWith(name))!.querySelector<HTMLInputElement>("input")!;
  const foreground=() => container.querySelector<HTMLInputElement>('.photo-editor__swatch input')!;
  const background=() => container.querySelector<HTMLInputElement>('.photo-editor__background-swatch input')!;
  press(editor,"b"); press(editor,"]",{code:"BracketRight"}); press(editor,"5"); press(editor,"3");
  expect(field("尺寸").value).toBe("29"); expect(field("不透明度").value).toBe("53");
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
  act(()=>canvasPort.props!.onMoveStart!({x:20,y:30},{duplicate:false,toggleAuto:false}));
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
});

it.each([
  ["文字",{kind:"text",text:{text:"内容"}},"pixels"],
  ["蒙版",{kind:"raster",hasMask:true},"mask"],
  ["调整层",{kind:"adjustment",adjustment:{kind:"brightnessContrast",params:{brightness:20,contrast:10}}},"pixels"]
])("所选%s属性显示在侧栏，折叠不重建图层或历史",(label,layer,editTarget)=>{
  const {container,dispatch}=setup(false,{document:{editTarget,activeTextStyle:{size:30,font:"Inter",color:"#112233"},layers:[{id:1,name:"所选图层",opacity:1,blend:"Normal",...layer as object}]}});
  const sidebar=container.querySelector(".photo-editor__sidebar")!;
  expect(sidebar.querySelector(`[aria-label="${label}"]`)!.hasAttribute("hidden")).toBe(false);
  expect(container.querySelector(`.photo-editor__contextbar [aria-label="${label}"]`)).toBeNull();
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
  {mask:true,selection:true,several:false,id:"edit.fillBackground",params:{color:"#ffffff"}},
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
