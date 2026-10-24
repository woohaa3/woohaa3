/** @vitest-environment jsdom */
// 只验证状态和 DOM 事件，不执行图片渲染。
import { act } from "react";
import {DialogService} from "@woohaa3/frontend/plugin-api";
import { expect, it, vi } from "vitest";
import { setup, press, canvasPort, root } from "../src/test-support/photo-editor-harness.js";

it("文字层回填样式，在原位会话统一修改内容和样式，确认不分派独立命令", () => {
  vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const { container, dispatch, textPort } = setup(false, { document: {
    layers: [{ id: 1, kind: "text", name: "标题", text: { text: "已有标题" } }],
    activeTextStyle: { character: { font_family: "Noto Sans SC", size_pt: 36, color: { c: [1, 0, 0, 0] }, faux_bold: true }, paragraph: { align: "Center" } }
  } });
  const editor=container.querySelector(".photo-editor")!;
  press(editor, "t");
  const section = container.querySelector<HTMLElement>('[aria-label="文字"].photo-editor__options-group')!;
  expect(section.querySelector('input[type="text"]:not([data-numeric-input])')).toBeNull();
  expect(section.querySelector<HTMLInputElement>('input[data-numeric-input]')!.value).toBe("36");
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
function textSetup(options:Parameters<typeof setup>[1]={}) {
  const frames:FrameRequestCallback[]=[];
  vi.stubGlobal("requestAnimationFrame",vi.fn((callback:FrameRequestCallback)=>{frames.push(callback);return frames.length;}));
  vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const result=setup(false,options);
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

it("文字草稿锁住图层和工具，无保存端口不提交，取消按钮丢弃输入和迟到帧",()=>{
  const {container,textPort,dispatch,frames}=textSetup();
  const input=textInput(container,"未提交");
  for (const button of container.querySelectorAll<HTMLButtonElement>(".photo-editor__toolrail button,.photo-editor__history button")) expect(button.disabled).toBe(true);
  expect(press(input,"s",{ctrlKey:true}).defaultPrevented).toBe(true);
  act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消文字")!.click());
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
  const font=container.querySelector<HTMLElement>('.photo-editor__object-properties [aria-label="文字"] .photo-editor__font-picker')!;
  act(()=>font.dispatchEvent(new WheelEvent("wheel",{deltaY:-40,bubbles:true,cancelable:true})));
  expect(textPort.beginText).toHaveBeenCalledWith({layer:1});
  act(()=>{const tick=callback;callback=null;tick?.(0);});
  expect(textPort.previewText).toHaveBeenCalledWith(expect.objectContaining({text:"内容",font:"Inter"}));
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



it("文字字段Ctrl Tab先flush并提交再切换；失败和组合输入保留原字段",()=>{
 const onActivateDocument=vi.fn();
 const {container,textPort}=textSetup({documents:{list:[{id:"a",name:"A",active:true},{id:"b",name:"B",active:false}],onActivateDocument}});
 const input=textInput(container,"切换前最后输入");
 act(()=>input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));press(input,"Tab",{ctrlKey:true});expect(onActivateDocument).not.toHaveBeenCalled();expect(textPort.commitText).not.toHaveBeenCalled();
 act(()=>input.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true})));
 textPort.commitText.mockReturnValueOnce({ok:false,code:"failed",message:"提交失败"} as never);
 press(input,"Tab",{ctrlKey:true});expect(onActivateDocument).not.toHaveBeenCalled();expect(container.querySelector("[data-text-input]")).toBe(input);
 onActivateDocument.mockImplementation(()=>expect(textPort.commitText).toHaveBeenCalledTimes(2));
 press(input,"Tab",{ctrlKey:true});expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:"切换前最后输入"}));expect(onActivateDocument).toHaveBeenCalledWith("b");expect(textPort.cancelText).not.toHaveBeenCalled();
});


it("文字保存flush到检查点且保留同一输入框与选区；IME和失败不调用宿主",async()=>{
 const onApply=vi.fn();const {container,textPort}=textSetup({onApply});const input=textInput(container,"当前文字");
 input.setSelectionRange(1,3);const range=[input.selectionStart,input.selectionEnd];
 await act(async()=>{press(input,"s",{ctrlKey:true});});
 expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:"当前文字"}));expect(textPort.checkpointText).toHaveBeenCalledOnce();expect(onApply).toHaveBeenCalledOnce();
 expect(textPort.commitText).not.toHaveBeenCalled();expect(textPort.cancelText).not.toHaveBeenCalled();expect(container.querySelector("[data-text-input]")).toBe(input);expect([input.selectionStart,input.selectionEnd]).toEqual(range);
 act(()=>input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));press(input,"s",{ctrlKey:true,isComposing:true});expect(onApply).toHaveBeenCalledOnce();
 act(()=>input.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true})));
 textPort.checkpointText.mockReturnValueOnce({ok:false,code:"failed",message:"无法保存文字"} as never);
 await act(async()=>{press(input,"s",{ctrlKey:true});});expect(onApply).toHaveBeenCalledOnce();expect(container.querySelector("[data-text-input]")).toBe(input);expect(container.textContent).toContain("无法保存文字");
});

it("新建点文字默认选中Lorem Ipsum，关闭偏好后为空；已有文字不替换",()=>{
 vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const {container,textPort}=setup();textPort.beginText.mockReturnValue({ok:true,value:{layer:null,new:true,text:""}} as never);press(container.querySelector(".photo-editor")!,"t");act(()=>canvasPort.props!.onText?.({x:10,y:20}));let input=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;
 expect(input.value).toBe("Lorem Ipsum");expect([input.selectionStart,input.selectionEnd]).toEqual([0,11]);act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消文字")!.click());expect(textPort.commitText).not.toHaveBeenCalled();
 localStorage.setItem("photocraft.editor-preferences.v1",JSON.stringify({fillNewTextWithPlaceholder:false}));
 // A fresh editor reads the persisted preference; no formal text content was written by cancellation.
 act(()=>root.unmount());const second=setup();second.textPort.beginText.mockReturnValue({ok:true,value:{layer:null,new:true,text:""}} as never);press(second.container.querySelector(".photo-editor")!,"t");act(()=>canvasPort.props!.onText?.({x:10,y:20,box:[10,20,100,50]}));input=second.container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;expect(input.value).toBe("");expect([input.selectionStart,input.selectionEnd]).toEqual([0,0]);localStorage.removeItem("photocraft.editor-preferences.v1");
});

it("文字菜单插入Lorem Ipsum：已有草稿替换选择且不提交，新段落同步完成受控草稿",async()=>{
 vi.stubGlobal("requestAnimationFrame",vi.fn(()=>1));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const {container,snapshot,render,textPort,dispatch}=setup();textPort.beginText.mockReturnValue({ok:true,value:{layer:null,new:true,text:""}} as never);snapshot.commands.set("type.create",{allowed:true,enabled:true} as never);render(false);
 const invoke=async()=>{const trigger=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="文字")!;await act(async()=>trigger.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent==="插入 Lorem Ipsum")!;expect(item).toBeTruthy();act(()=>item.click());};
 await invoke();expect(textPort.beginText).toHaveBeenLastCalledWith({x:80,y:60,box:[80,60,640,480],forceNew:true});expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:expect.stringContaining("Lorem ipsum dolor sit amet"),size:30}));expect(textPort.commitText).toHaveBeenCalledOnce();expect(dispatch).not.toHaveBeenCalled();
 act(()=>canvasPort.props!.onText?.({x:30,y:40}));const input=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;expect(input.value).toBe("Lorem Ipsum");await invoke();expect(input.value).toMatch(/^Lorem ipsum dolor sit amet/);expect(input.value.endsWith("Lorem Ipsum")).toBe(false);expect(textPort.commitText).toHaveBeenCalledOnce();expect(dispatch).not.toHaveBeenCalled();
});

it("字体菜单悬停预览和移开恢复保留文字草稿，点击才改变所选格式",async()=>{
 const {container,textPort,frames}=textSetup();textInput(container,"draft text");const flush=()=>act(()=>frames.splice(0).forEach(frame=>frame(0)));flush();
 const picker=container.querySelector(".photo-editor__font-picker button")!;await act(async()=>picker.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));
 const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent==="Inter")!;expect(item).toBeTruthy();
 const move=new MouseEvent("pointermove",{bubbles:true});Object.defineProperty(move,"pointerType",{value:"mouse"});act(()=>item.dispatchEvent(move));flush();expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:"draft text",font:"Inter"}));expect(localStorage.getItem("photocraft.tools.v1.text")).toBeNull();
 act(()=>item.dispatchEvent(new MouseEvent("pointerout",{bubbles:true,relatedTarget:document.body})));flush();expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:"draft text",font:"Noto Sans SC"}));expect(textPort.commitText).not.toHaveBeenCalled();expect(textPort.cancelText).not.toHaveBeenCalled();
 act(()=>item.click());flush();expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:"draft text",font:"Inter"}));expect(textPort.commitText).not.toHaveBeenCalled();expect(container.querySelector<HTMLTextAreaElement>("[data-text-input]")!.value).toBe("draft text");
});

it("刷新文字与默认样式菜单遵循内核可用性并分派一次，失败原因保留",async()=>{
 const {container,snapshot,render,dispatch}=setup();for(const id of ["type.updateAllTextLayers","type.saveDefaultTypeStyles","type.loadDefaultTypeStyles"])snapshot.commands.set(id,{allowed:true,enabled:true} as never);render(false);
 const invoke=async(label:string)=>{await act(async()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="文字")!.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent===label)!;act(()=>item.click());};
 await invoke("刷新全部文字图层");expect(dispatch).toHaveBeenLastCalledWith("type.updateAllTextLayers",null);await invoke("保存默认文字样式");expect(dispatch).toHaveBeenLastCalledWith("type.saveDefaultTypeStyles",null);await invoke("载入默认文字样式");expect(dispatch).toHaveBeenLastCalledWith("type.loadDefaultTypeStyles",null);expect(dispatch).toHaveBeenCalledTimes(3);
});

it("打开文档显示缺失字体，真实宿主映射窗口取消不写、确认先关闭再分派",async()=>{
 const dialogs=new DialogService(),{container,snapshot,render,dispatch}=setup(false,{dialogs,missingFonts:["Missing A","Missing B"]});snapshot.commands.set("type.resolveMissingFonts",{allowed:true,enabled:true} as never);render(false);
 expect(container.textContent).toContain("缺少字体：Missing A、Missing B");expect(dispatch).not.toHaveBeenCalled();
 const open=()=>act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="替换…")!.click());open();expect(document.querySelector('[role="dialog"]')?.textContent).toContain("替换缺失字体");act(()=>[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button=>button.textContent==="取消")!.click());expect(dispatch).not.toHaveBeenCalled();
 open();const fields=[...document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')];act(()=>{fields[0]!.value="Noto Sans SC";fields[0]!.dispatchEvent(new Event("change",{bubbles:true}));fields[1]!.value="";fields[1]!.dispatchEvent(new Event("change",{bubbles:true}));});act(()=>document.querySelector('[role="dialog"] form')!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(dialogs.isModalActive()).toBe(false);expect(dispatch.mock.calls).toEqual([["type.resolveMissingFonts",{map:{"Missing A":"Noto Sans SC"}}]]);
 render(true);expect(container.textContent).toContain("缺少字体");expect([...container.querySelectorAll("button")].find(button=>button.textContent==="替换…")).toBeUndefined();
});

async function textMenu(container:Element,menu:string,label:string) {
 await act(async()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent===menu)!.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));
 const item=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent===label)!;expect(item).toBeTruthy();return item;
}
it("文字菜单剪贴板只处理UTF16选区，成功写后才剪切，粘贴保持一个未提交草稿",async()=>{
 const writeText=vi.fn(async(_text:string)=>{}),readText=vi.fn(async()=>"替换🖌");Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText,readText}});
 const {container,dispatch,textPort}=textSetup();const input=textInput(container,"A😀中文B");
 act(()=>{input.setSelectionRange(1,5);input.dispatchEvent(new KeyboardEvent("keyup",{key:"Shift",bubbles:true}));});
 let item=await textMenu(container,"编辑","复制");expect(item.dataset.disabled).toBeUndefined();await act(async()=>item.click());expect(writeText).toHaveBeenLastCalledWith("😀中文");expect(input.value).toBe("A😀中文B");
 item=await textMenu(container,"编辑","剪切");await act(async()=>item.click());expect(input.value).toBe("AB");expect(input.selectionStart).toBe(1);
 item=await textMenu(container,"编辑","粘贴");await act(async()=>item.click());expect(input.value).toBe("A替换🖌B");expect(input.selectionStart).toBe(5);
 item=await textMenu(container,"选择","全部");await act(async()=>item.click());expect([input.selectionStart,input.selectionEnd]).toEqual([0,input.value.length]);
 expect(dispatch).not.toHaveBeenCalled();expect(textPort.commitText).not.toHaveBeenCalled();
});
it("文字剪切被拒绝保留内容，迟到粘贴不覆盖输入/输入法或新草稿",async()=>{
 let resolve:(text:string)=>void=()=>{};const readText=vi.fn(()=>new Promise<string>(done=>{resolve=done;})),writeText=vi.fn(async()=>{throw new Error("denied");});Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText,readText}});
 const {container,dispatch}=textSetup();let input=textInput(container,"原文");
 act(()=>{input.setSelectionRange(0,2);input.dispatchEvent(new KeyboardEvent("keyup",{key:"Shift",bubbles:true}));});
 let item=await textMenu(container,"编辑","剪切");await act(async()=>item.click());expect(input.value).toBe("原文");expect(container.textContent).toContain("无法访问系统文字剪贴板");
 item=await textMenu(container,"编辑","粘贴");act(()=>item.click());textInput(container,"继续输入");await act(async()=>resolve("迟到"));expect(input.value).toBe("继续输入");
 item=await textMenu(container,"编辑","粘贴");act(()=>item.click());act(()=>input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));await act(async()=>resolve("旧候选"));expect(input.value).toBe("继续输入");
 act(()=>input.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true})));
 item=await textMenu(container,"编辑","粘贴");act(()=>item.click());act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消文字")!.click());
 act(()=>canvasPort.props!.onText?.({x:20,y:20}));input=container.querySelector<HTMLTextAreaElement>("[data-text-input]")!;await act(async()=>resolve("旧会话"));expect(input.value).not.toBe("旧会话");expect(dispatch).not.toHaveBeenCalled();
});

it("文字栅格化菜单使用公开命令，禁用状态保持且不进入文字草稿",async()=>{
 const {container,dispatch,snapshot,render,textPort}=setup(false,{document:{layers:[{id:1,kind:"text",name:"标题",text:{text:"保留"}}]}});
 for(const id of ["layer.rasterize.type","layer.rasterize.allLayers","type.rasterizeTypeLayer"])snapshot.commands.set(id,{allowed:true,enabled:true} as never);render(false);
 let item=await textMenu(container,"文字","栅格化文字图层");await act(async()=>item.click());expect(dispatch.mock.lastCall).toEqual(["type.rasterizeTypeLayer",null]);expect(textPort.beginText).not.toHaveBeenCalled();
 snapshot.commands.set("type.rasterizeTypeLayer",{allowed:true,enabled:false} as never);render(false);item=await textMenu(container,"文字","栅格化文字图层");expect(item.dataset.disabled).toBe("");act(()=>item.click());expect(dispatch).toHaveBeenCalledOnce();
});

it("文字右键复用菜单剪贴板及草稿确认，输入变化关闭旧菜单且IME不打开",async()=>{
 const writeText=vi.fn(async(_text:string)=>{}),readText=vi.fn(async()=>"替换");Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText,readText}});
 const {container,textPort,dispatch}=textSetup();let input=textInput(container,"A😀中文B");
 act(()=>{input.setSelectionRange(1,5);input.dispatchEvent(new KeyboardEvent("keyup",{key:"Shift",bubbles:true}));});
 const open=async()=>{const event=new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:200,clientY:160,button:2});await act(async()=>input.dispatchEvent(event));expect(event.defaultPrevented).toBe(true);};
 const item=(label:string)=>[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node=>node.textContent===label)!;
 await open();expect(document.querySelector('[aria-label="文字编辑"][data-cursor-menu]')).not.toBeNull();await act(async()=>item("复制").click());expect(writeText).toHaveBeenLastCalledWith("😀中文");expect(input.value).toBe("A😀中文B");expect(textPort.commitText).not.toHaveBeenCalled();
 await open();await act(async()=>item("粘贴").click());expect(input.value).toBe("A替换B");
 await open();input=textInput(container,"继续输入");expect(document.querySelector('[aria-label="文字编辑"][data-cursor-menu]')).toBeNull();
 act(()=>input.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})));await open();expect(document.querySelector('[aria-label="文字编辑"][data-cursor-menu]')).toBeNull();act(()=>input.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true})));
 await open();await act(async()=>item("确认文字").click());expect(textPort.commitText).toHaveBeenCalledOnce();expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({text:"继续输入"}));expect(dispatch).not.toHaveBeenCalled();expect(container.querySelector('[data-text-input]')).toBeNull();
});
it("文字抗锯齿选项只更新候选，菜单七种模式在文字编辑中仍可用，取消不提交",async()=>{
 const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",vi.fn((frame:FrameRequestCallback)=>{frames.push(frame);return frames.length;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const {container,textPort,dispatch,snapshot,render}=setup();
 snapshot.commands.set("type.create",{allowed:true,enabled:true} as never);
 for(const mode of ["none","sharp","crisp","strong","smooth","windowsLcd","windows"])snapshot.commands.set(`type.antiAlias.${mode}`,{allowed:true,enabled:true} as never);render(false);
 press(container.querySelector(".photo-editor")!,"t");act(()=>canvasPort.props!.onText?.({x:30,y:40,box:[30,40,100,80]}));
 const select=[...container.querySelectorAll<HTMLSelectElement>('[aria-label="文字"].photo-editor__options-group select')].find(select=>select.parentElement?.textContent?.startsWith("抗锯齿"))!;expect(select.options).toHaveLength(7);
 act(()=>{select.value="none";select.dispatchEvent(new Event("change",{bubbles:true}));});act(()=>frames.splice(0).forEach(frame=>frame(0)));expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({antialias:"none"}));expect(textPort.commitText).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
 const button=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="文字")!;await act(async()=>button.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));
 const submenu=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="抗锯齿")!;await act(async()=>submenu.click());
 const windows=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="Windows LCD")!;expect(windows).toBeDefined();expect(windows.getAttribute("data-disabled")).toBeNull();await act(async()=>windows.click());act(()=>frames.splice(0).forEach(frame=>frame(0)));expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({antialias:"windowsLcd"}));
 act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消文字")!.click());expect(textPort.commitText).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
});
it("文字方向选项与菜单在同一草稿内切换，竖排候选取消不分派正式命令",async()=>{
 const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",vi.fn((frame:FrameRequestCallback)=>{frames.push(frame);return frames.length;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const {container,snapshot,render,textPort,dispatch}=setup();for(const id of ["type.create","type.orientation.horizontal","type.orientation.vertical"])snapshot.commands.set(id,{allowed:true,enabled:true} as never);render(false);press(container.querySelector(".photo-editor")!,"t");act(()=>canvasPort.props!.onText?.({x:20,y:20,box:[20,20,50,100]}));
 const select=[...container.querySelectorAll<HTMLSelectElement>('[aria-label="文字"].photo-editor__options-group select')].find(select=>select.parentElement?.textContent?.startsWith("方向"))!;act(()=>{select.value="vertical";select.dispatchEvent(new Event("change",{bubbles:true}));});act(()=>frames.splice(0).forEach(frame=>frame(0)));expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({orientation:"vertical"}));expect(container.querySelector<HTMLTextAreaElement>('textarea')!.style.writingMode).toBe("vertical-rl");
 const button=[...container.querySelectorAll<HTMLButtonElement>(".photo-editor__menubar button")].find(button=>button.textContent==="文字")!;await act(async()=>button.dispatchEvent(new MouseEvent("pointerdown",{button:0,bubbles:true})));const submenu=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="方向")!;await act(async()=>submenu.click());const horizontal=[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item=>item.textContent==="横排")!;await act(async()=>horizontal.click());act(()=>frames.splice(0).forEach(frame=>frame(0)));expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({orientation:"horizontal"}));
 act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消文字")!.click());expect(textPort.commitText).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
});

it("工具组直接选择竖排，新建点文字和段落文字保留方向记忆，取消不写正式命令",async()=>{
 const frames:FrameRequestCallback[]=[];vi.stubGlobal("requestAnimationFrame",vi.fn((frame:FrameRequestCallback)=>{frames.push(frame);return frames.length;}));vi.stubGlobal("cancelAnimationFrame",vi.fn());
 const {container,snapshot,render,textPort,dispatch}=setup();for(const id of ["type.create","type.orientation.horizontal","type.orientation.vertical"])snapshot.commands.set(id,{allowed:true,enabled:true} as never);render(false);
 textPort.beginText.mockReturnValue({ok:true,value:{layer:null,new:true,text:""}} as never);
 const trigger=container.querySelector<HTMLButtonElement>('.photo-editor__toolrail button[aria-label="文字"]')!;
 await act(async()=>trigger.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true})));
 const vertical=document.querySelector<HTMLButtonElement>('[data-text-orientation="vertical"]')!;expect(vertical).not.toBeNull();await act(async()=>vertical.click());
 for(const placement of [{x:20,y:20},{x:20,y:20,box:[20,20,30,80] as [number,number,number,number]}]){
  act(()=>canvasPort.props!.onText?.(placement));act(()=>frames.splice(0).forEach(frame=>frame(0)));
  expect(textPort.previewText).toHaveBeenLastCalledWith(expect.objectContaining({orientation:"vertical"}));
  act(()=>[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="取消文字")!.click());
 }
 expect(textPort.commitText).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
});
