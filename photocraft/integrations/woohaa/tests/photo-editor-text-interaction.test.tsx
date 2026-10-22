/** @vitest-environment jsdom */
// 只验证状态和 DOM 事件，不执行图片渲染。
import { act } from "react";
import { expect, it, vi } from "vitest";
import { setup, press, canvasPort } from "../src/test-support/photo-editor-harness.js";

it("文字层回填样式，在原位会话统一修改内容和样式，确认不分派独立命令", () => {
  vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const { container, dispatch, textPort } = setup(false, { document: {
    layers: [{ id: 1, kind: "text", name: "标题", text: { text: "已有标题" } }],
    activeTextStyle: { character: { font_family: "Noto Sans SC", size_pt: 36, color: { c: [1, 0, 0, 0] }, faux_bold: true }, paragraph: { align: "Center" } }
  } });
  const editor=container.querySelector(".photo-editor")!;
  press(editor, "t");
  const section = container.querySelector<HTMLElement>('[aria-label="文字"].photo-editor__options-group')!;
  expect(section.querySelector('input[type="text"]')).toBeNull();
  expect(section.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("36");
  act(()=>[...section.querySelectorAll<HTMLButtonElement>("button")].find((button)=>button.textContent==="编辑所选文字")!.click());
  expect(textPort.beginText).toHaveBeenCalledWith({layer:1});
  const input=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;
  expect(input.value).toBe("已有标题");expect(document.activeElement).toBe(input);
  const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;
  act(()=>{setter.call(input,"新的标题");input.setSelectionRange(4,4);input.dispatchEvent(new Event("input",{bubbles:true}));});
  act(()=>[...section.querySelectorAll<HTMLButtonElement>("button")].find((button)=>button.textContent==="确认文字")!.click());
  expect(textPort.previewText).toHaveBeenLastCalledWith({text:"新的标题",font:"Noto Sans SC",size:36,color:"#ff0000",fauxBold:true,align:"center"});
  expect(textPort.commitText).toHaveBeenCalledOnce();expect(dispatch).not.toHaveBeenCalled();
  expect(container.querySelector("[data-text-input]")).toBeNull();expect(document.activeElement).toBe(editor);
});

function textInput(container:Element,value:string) {
  const input=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;
  const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!;
  act(()=>{setter.call(input,value);input.setSelectionRange(value.length,value.length);input.dispatchEvent(new Event("input",{bubbles:true}));});
  return input;
}
function textSetup() {
  const frames:FrameRequestCallback[]=[];
  vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback)=>{frames.push(callback);return frames.length;}));
  vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const result=setup();
  press(result.container.querySelector(".photo-editor")!,"t");
  act(()=>canvasPort.props!.onText?.({x:30,y:40,box:[30,40,100,80]}));
  return {...result,frames};
}

it("T 定位启动文字草稿，输入法预编辑可预览但不确认，结束后统一提交",()=>{
  const {container,textPort,dispatch,frames}=textSetup();
  expect(textPort.beginText).toHaveBeenCalledWith({x:30,y:40,box:[30,40,100,80]});
  const input=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;
  act(()=>input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));
  textInput(container,"zhong");
  act(()=>frames[0]?.(0));
  expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:"zhong"}));
  const confirm=[...container.querySelectorAll<HTMLButtonElement>("button")].find((button)=>button.textContent==="确认文字")!;
  expect(confirm.disabled).toBe(true);
  press(input,"Enter",{ctrlKey:true});press(input,"Escape");
  expect(textPort.commitText).not.toHaveBeenCalled();expect(textPort.cancelText).not.toHaveBeenCalled();
  expect(container.querySelector("[data-text-input]")).toBe(input);
  textInput(container,"中");
  act(()=>input.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"中"})));
  press(input,"Enter",{ctrlKey:true});
  expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:"中"}));
  expect(textPort.commitText).toHaveBeenCalledOnce();expect(dispatch).not.toHaveBeenCalled();
  expect(container.querySelector("[data-text-input]")).toBeNull();
});

it("文字草稿锁住图层和工具，保存键不触发宿主，Esc 丢弃输入和迟到帧",()=>{
  const {container,textPort,dispatch,frames}=textSetup();
  const input=textInput(container,"未提交");
  for (const button of container.querySelectorAll<HTMLButtonElement>(".photo-editor__toolrail button,.photo-editor__history button")) expect(button.disabled).toBe(true);
  expect(press(input,"s",{ctrlKey:true}).defaultPrevented).toBe(true);
  expect(container.textContent).toContain("请先确认或取消文字编辑");
  press(input,"Escape");
  act(()=>frames.forEach((callback)=>callback(0)));
  expect(textPort.previewText).not.toHaveBeenCalled();expect(textPort.commitText).not.toHaveBeenCalled();
  expect(textPort.cancelText).toHaveBeenCalledOnce();expect(dispatch).not.toHaveBeenCalled();
  expect(container.querySelector("[data-text-input]")).toBeNull();
});

it("文字确认失败保留同一输入节点，重试确认成功",()=>{
  const {container,textPort}=textSetup();
  const input=textInput(container,"保留输入");
  textPort.commitText.mockReturnValueOnce({ok:false,message:"确认失败",code:"failed"} as never);
  press(input,"Enter",{ctrlKey:true});
  expect(container.querySelector("[data-text-input]")).toBe(input);expect(input.value).toBe("保留输入");
  expect(container.textContent).toContain("确认失败");
  press(input,"Enter",{ctrlKey:true});expect(textPort.commitText).toHaveBeenCalledTimes(2);
  expect(container.querySelector("[data-text-input]")).toBeNull();
});

it("文字点击先补齐未到帧的输入，拖选和软换行导航查询原生几何",()=>{
  const {container,textPort}=textSetup();
  textInput(container,"中😀a");
  textPort.textGeometry.mockImplementation((params:unknown)=>{
    const query=params as {start:number;end:number;hit?:[number,number]};
    return {ok:true,value:{caret:[[10,20],[10,50]],selection:[],hit:query.hit && query.hit[0]>20?3:1,next:0}};
  });
  const layer=container.querySelector<HTMLElement>("[data-text-editing]")!;
  layer.setPointerCapture=vi.fn();layer.hasPointerCapture=()=>true;layer.releasePointerCapture=vi.fn();
  const send=(type:string,x:number,y:number)=>{
    const event=new MouseEvent(type,{button:0,clientX:x,clientY:y,bubbles:true});Object.defineProperty(event,"pointerId",{value:1});
    act(()=>layer.dispatchEvent(event));
  };
  send("pointerdown",5,10);send("pointermove",15,20);send("pointerup",15,20);
  expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:"中😀a"}));
  const input=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;
  expect(input.selectionStart).toBe(1);expect(input.selectionEnd).toBe(3);
  expect(textPort.textGeometry).toHaveBeenCalledWith(expect.objectContaining({hit:[30,40]}));
  press(input,"ArrowUp");
  expect(textPort.textGeometry).toHaveBeenCalledWith(expect.objectContaining({move:"linePrev"}));
  expect(input.selectionStart).toBe(0);expect(input.selectionEnd).toBe(0);
  expect(container.querySelector("[data-text-input]")).toBe(input);
});

it("直接修改所选文字的侧栏样式会进入同一文字草稿，不只改变工具偏好",()=>{
  let callback:FrameRequestCallback|null=null;
  vi.stubGlobal("requestAnimationFrame",vi.fn((next:FrameRequestCallback)=>{callback=next;return 1;}));
  vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const {container,textPort}=setup(false,{document:{layers:[{id:1,name:"文字层",kind:"text",text:{text:"内容"},opacity:1,blend:"Normal"}]}});
  const font=container.querySelector<HTMLSelectElement>('.photo-editor__object-properties [aria-label="文字"] select')!;
  act(()=>{font.value=font.value==="Inter"?"Noto Sans SC":"Inter";font.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(textPort.beginText).toHaveBeenCalledWith({layer:1});
  act(()=>{const tick=callback;callback=null;tick?.(0);});
  expect(textPort.previewText).toHaveBeenCalledWith(expect.objectContaining({text:"内容",font:font.value}));
  expect(container.querySelector("[data-text-input]")).not.toBeNull();
});

it("显式文字工具可覆盖所选调整层属性，隐藏侧栏后开始文字会重新展开属性",()=>{
  const {container,textPort}=setup(false,{document:{layers:[{id:1,name:"调整层",kind:"adjustment",adjustment:{kind:"brightnessContrast",params:{brightness:20,contrast:0}}}]}});
  const editor=container.querySelector(".photo-editor")!;
  press(editor,"t");
  const textOptions=container.querySelector('.photo-editor__object-properties [aria-label="文字"]')!;
  expect(textOptions.hasAttribute("hidden")).toBe(false);
  press(editor,"Tab",{shiftKey:true});expect(container.querySelector<HTMLElement>(".photo-editor__sidebar")!.hidden).toBe(true);
  act(()=>canvasPort.props!.onText?.({x:40,y:50}));
  expect(textPort.beginText).toHaveBeenCalledWith({x:40,y:50});
  expect(container.querySelector<HTMLElement>(".photo-editor__sidebar")!.hidden).toBe(false);
  expect(textOptions.hasAttribute("hidden")).toBe(false);
  expect(container.querySelector("[data-text-input]")).not.toBeNull();
});

