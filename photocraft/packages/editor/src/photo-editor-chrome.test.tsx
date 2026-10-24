/** @vitest-environment jsdom */
// 菜单替身只检查命令分派和可用状态，不执行图像合成。
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { EditorMenuBar,EditorToolRail } from "./photo-editor-chrome.js";
import {TOOL_SLOTS} from "./toolbar-slots.js";
import {INITIAL_EDITOR_DISPLAY} from "./editor-display.js";
vi.mock("./ui/Menu.js", async importOriginal => {
  const actual=await importOriginal<typeof import("./ui/Menu.js")>();
  const entries = (items: readonly import("./ui/Menu.js").MenuItem[]): ReactNode => items.map(item =>
    item.children ? <div key={item.id} data-submenu={item.id}>{entries(item.children)}</div> :
      <button key={item.id} data-command={item.id} disabled={item.disabled} onClick={event => item.onSelect(item.id,{altKey:event.altKey})}>{item.label}</button>);
  return {...actual,DropdownMenu: ({label, items}: {label: string; items: readonly import("./ui/Menu.js").MenuItem[]}) =>
    <div data-menu={label}>{entries(items)}</div>};
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("整图与图层旋转使用不同命令，未允许入口隐藏、暂不可用入口禁用", () => {
  const ids = ["image.imageRotation.90cw", "edit.transform.rotate90Cw", "layer.delete"];
  const commands = new Map(ids.map((id) => [id, { id, allowed: true, enabled: id !== "layer.delete" } as PhotocraftCommand]));
  commands.set("layer.new.group", { id: "layer.new.group", allowed: false, enabled: true } as PhotocraftCommand);
  const onCommand = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<EditorMenuBar commands={commands} readonly={false} canUndo={false} canRedo={false}
      onCommand={onCommand} onApply={vi.fn()} canSave={false} saving={false} />));
    const image = container.querySelector<HTMLButtonElement>('[data-menu="图像"] button')!;
    expect(image.textContent).toBe("顺时针旋转图像 90°");
    act(() => image.click());
    expect(onCommand).toHaveBeenLastCalledWith("image.imageRotation.90cw");
    const layer = container.querySelector<HTMLButtonElement>('[data-menu="编辑"] [data-submenu="transform"] button')!;
    act(() => layer.click());
    expect(onCommand).toHaveBeenLastCalledWith("edit.transform.rotate90Cw");
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-menu="图层"] button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("新建图层菜单沿共用入口请求命名，提示与快捷键定义一致", () => {
  const onCommand = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<EditorMenuBar commands={new Map([["layer.new.layer", {id:"layer.new.layer",allowed:true,enabled:true} as PhotocraftCommand]])}
      readonly={false} canUndo={false} canRedo={false} onCommand={onCommand} onApply={vi.fn()}
      canSave={false} saving={false} />));
    const button = container.querySelector<HTMLButtonElement>('[data-menu="图层"] button')!;
    expect(button.textContent).toContain("新建图层");
    expect(button.textContent).toContain("Shift+N");
    act(() => button.click());
    expect(onCommand.mock.calls).toEqual([["layer.new.layer"]]);
  } finally {act(() => root.unmount());}
});

it("视图菜单使用共用显示动作和提示，禁用时不切换或分派文档命令",()=>{
  const toggle=vi.fn(),onCommand=vi.fn();
  const container=document.createElement("div");const root=createRoot(container);
  const render=(disabled=false)=>act(()=>root.render(<EditorMenuBar commands={new Map()} readonly={false} canUndo={false} canRedo={false}
    onCommand={onCommand} onApply={vi.fn()} canSave={false} saving={false}
    display={{state:INITIAL_EDITOR_DISPLAY,toggle}} displayDisabled={disabled}/>));
  try {
    render();
    const buttons=container.querySelectorAll<HTMLButtonElement>('[data-menu="视图"] button');
    expect(buttons).toHaveLength(2);expect(buttons[0].textContent).toContain("选区与变换边界");expect(buttons[1].textContent).toContain("像素网格");
    const windows=container.querySelectorAll<HTMLButtonElement>('[data-menu="窗口"] button');
    expect(windows).toHaveLength(8);expect(windows[1].textContent).toContain("Shift+Tab");
    act(()=>[...buttons,...windows].forEach(button=>button.click()));
    expect(toggle.mock.calls).toEqual([["extras"],["pixelGrid"],["panels"],["sidebar"],["tools"],["options"],["modifiers"],["navigator"],["histogram"],["info"]]);
    render(true);act(()=>container.querySelectorAll<HTMLButtonElement>('[data-menu="视图"] button, [data-menu="窗口"] button').forEach(button=>button.click()));
    expect(toggle).toHaveBeenCalledTimes(10);expect(onCommand).not.toHaveBeenCalled();
  } finally {act(()=>root.unmount());}
});

it("菜单变换进入会话、缩放走视图动作，未出现置入入口", () => {
  const ids = ["edit.transform", "select.transformSelection", "edit.undo", "edit.redo"];
  const commands = new Map(ids.map(id => [id, {id, allowed:true, enabled:true} as PhotocraftCommand]));
  const onCommand=vi.fn(),onTransform=vi.fn(),onView=vi.fn();
  const container=document.createElement("div"),root=createRoot(container);
  const render=(readonly=false)=>act(()=>root.render(<EditorMenuBar commands={commands} readonly={readonly} canUndo canRedo={false}
    onCommand={onCommand} onApply={vi.fn()} canSave={false} saving={false} onTransform={onTransform} canTransform canTransformSelection
    onView={onView} viewDisabled={readonly} />));
  try {
    render();
    expect(container.textContent).not.toContain("置入");
    act(()=>container.querySelector<HTMLButtonElement>('[data-command="edit.transform"]')!.click());
    act(()=>container.querySelector<HTMLButtonElement>('[data-command="select.transformSelection"]')!.click());
    expect(onTransform.mock.calls).toEqual([[false],[true]]);expect(onCommand).not.toHaveBeenCalled();
    act(()=>container.querySelectorAll<HTMLButtonElement>('[data-menu="视图"] button').forEach(button=>button.click()));
    expect(onView.mock.calls).toEqual([["zoomIn"],["zoomOut"],["fit"],["actualSize"],["twoHundredPercent"],["printSize"],["fitLayers"]]);
    expect(container.querySelector<HTMLButtonElement>('[data-command="edit.redo"]')!.disabled).toBe(true);
    render(true);
    act(()=>container.querySelectorAll<HTMLButtonElement>('[data-menu] button').forEach(button=>button.click()));
    expect(onTransform).toHaveBeenCalledTimes(2);expect(onView).toHaveBeenCalledTimes(7);expect(onCommand).not.toHaveBeenCalled();
  } finally {act(()=>root.unmount());}
});


it("切换上次状态依据任一历史方向启用，批量显隐遵守能力与只读门",()=>{
  const commands=new Map(["edit.toggleLastState","layer.hideLayers"].map(id=>[id,{id,allowed:true,enabled:true} as PhotocraftCommand]));
  const onCommand=vi.fn(),container=document.createElement("div"),root=createRoot(container);
  const render=(canUndo=false,canRedo=false,readonly=false)=>act(()=>root.render(<EditorMenuBar commands={commands} readonly={readonly}
    canUndo={canUndo} canRedo={canRedo} onCommand={onCommand} onApply={vi.fn()} canSave={false} saving={false}/>));
  const button=(id:string)=>container.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!;
  try {
    render();expect(button("edit.toggleLastState").disabled).toBe(true);
    for(const direction of [[true,false],[false,true]]) {
      render(...direction as [boolean,boolean]);expect(button("edit.toggleLastState").disabled).toBe(false);
      act(()=>button("edit.toggleLastState").click());
    }
    act(()=>button("layer.hideLayers").click());
    expect(onCommand.mock.calls).toEqual([["edit.toggleLastState"],["edit.toggleLastState"],["layer.hideLayers"]]);
    commands.get("layer.hideLayers")!.enabled=false;render();expect(button("layer.hideLayers").disabled).toBe(true);
    render(true,true,true);act(()=>button("edit.toggleLastState").click());expect(onCommand).toHaveBeenCalledTimes(3);
    commands.get("layer.hideLayers")!.allowed=false;render();expect(button("layer.hideLayers")).toBeNull();
  } finally {act(()=>root.unmount());}
});

it("文件脚本保留内核门禁与子菜单，不会被宿主关闭文档回调接管；偏好是独立界面动作",()=>{
  const container=document.createElement("div"),root=createRoot(container),close=vi.fn(),run=vi.fn(),prefs=vi.fn();
  const commands=new Map([["file.scripts.deleteAllEmptyLayers",{id:"file.scripts.deleteAllEmptyLayers",allowed:true,enabled:true} as PhotocraftCommand]]);
  const render=(readonly=false)=>act(()=>root.render(<EditorMenuBar commands={commands} readonly={readonly} canUndo={false} canRedo={false} onCommand={run} onApply={()=>{}} canSave={false} saving={false} documents={{onOpenFile:()=>{},onCloseDocument:close}} onPreferences={prefs}/>));
  try {
    render();const script=container.querySelector<HTMLButtonElement>('[data-menu="文件"] [data-command="file.scripts.deleteAllEmptyLayers"]')!;
    act(()=>script.click());expect(run).toHaveBeenCalledWith("file.scripts.deleteAllEmptyLayers");expect(close).not.toHaveBeenCalled();
    act(()=>container.querySelector<HTMLButtonElement>('[data-command="preferences"]')!.click());expect(prefs).toHaveBeenCalledOnce();
    render(true);expect(container.querySelector<HTMLButtonElement>('[data-command="preferences"]')!.disabled).toBe(true);expect(container.querySelector<HTMLButtonElement>('[data-command="file.scripts.deleteAllEmptyLayers"]')!.disabled).toBe(true);
  } finally {act(()=>root.unmount());}
});

it("Alt合并菜单执行盖印；盖印能力关闭时不退回破坏性合并",()=>{
  const container=document.createElement("div"),root=createRoot(container),run=vi.fn();
  const commands=new Map(["layer.mergeLayers","layer.mergeVisible","layer.stampDown","layer.stampVisible"].map(id=>[id,{id,allowed:true,enabled:true} as PhotocraftCommand]));
  const render=()=>act(()=>root.render(<EditorMenuBar commands={commands} readonly={false} canUndo={false} canRedo={false} onCommand={run} onApply={()=>{}} canSave={false} saving={false}/>));
  try {render();
    const select=(id:string)=>act(()=>container.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!.dispatchEvent(new MouseEvent("click",{bubbles:true,altKey:true})));
    select("layer.mergeLayers");select("layer.mergeVisible");expect(run.mock.calls).toEqual([["layer.stampDown"],["layer.stampVisible"]]);
    commands.set("layer.stampVisible",{id:"layer.stampVisible",allowed:false,enabled:true} as PhotocraftCommand);render();select("layer.mergeVisible");expect(run).toHaveBeenCalledTimes(2);
  }finally{act(()=>root.unmount());}
});

it("清理子菜单按各项内核门禁执行，只读关闭且不透传菜单修饰参数",()=>{
 const container=document.createElement("div"),root=createRoot(container),run=vi.fn();
 const ids=["edit.purge.undo","edit.purge.clipboard","edit.purge.histories","edit.purge.videoCache","edit.purge.all"];
 const commands=new Map(ids.map(id=>[id,{id,allowed:true,enabled:id!=="edit.purge.clipboard"} as PhotocraftCommand]));
 const render=(readonly=false)=>act(()=>root.render(<EditorMenuBar commands={commands} readonly={readonly} canUndo={true} canRedo={false} onCommand={run} onApply={()=>{}} canSave={false} saving={false}/>));
 try {render();for(const id of ids) act(()=>container.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!.click());
 expect(run.mock.calls).toEqual(ids.filter(id=>id!=="edit.purge.clipboard").map(id=>[id]));
 render(true);for(const id of ids) expect(container.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!.disabled).toBe(true);
 commands.get("edit.purge.all")!.allowed=false;render();expect(container.querySelector('[data-command="edit.purge.all"]')).toBeNull();
 }finally{act(()=>root.unmount());}
});


it("全局清理启用态覆盖当前空文档，但仍遵守内核能力白名单",()=>{
 const container=document.createElement("div"),root=createRoot(container),run=vi.fn();
 const id="edit.purge.histories";
 const commands=new Map([[id,{id,allowed:true,enabled:false} as PhotocraftCommand]]);
 const purge={commands:{"edit.purge.clipboard":{enabled:false},"edit.purge.histories":{enabled:true},"edit.purge.all":{enabled:true}},execute:vi.fn(()=>({ok:true}))};
 const render=()=>act(()=>root.render(<EditorMenuBar commands={commands} readonly={false} canUndo={false} canRedo={false} onCommand={run} onApply={()=>{}} canSave={false} saving={false} documents={{purge}}/>));
 try {render();const button=container.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!;expect(button.disabled).toBe(false);act(()=>button.click());expect(run.mock.calls).toEqual([[id]]);
 purge.commands[id].enabled=false;render();expect(button.disabled).toBe(true);
 commands.get(id)!.allowed=false;render();expect(container.querySelector(`[data-command="${id}"]`)).toBeNull();
 }finally{act(()=>root.unmount());}
});

it("手形和缩放工具单击选择，双击分别适合屏幕和实际像素，禁用不分派",()=>{
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),onTool=vi.fn(),onView=vi.fn();
 const render=(readonly=false)=>act(()=>root.render(<EditorToolRail tool="pan" onTool={onTool} onView={onView} readonly={readonly} color="#000000" onColor={()=>{}}/>));
 try {render();for(const [name,tool,view] of [["手形","pan","fit"],["缩放","zoom","actualSize"]] as const){const button=node.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;act(()=>button.click());expect(onTool).toHaveBeenLastCalledWith(tool);act(()=>button.dispatchEvent(new MouseEvent("dblclick",{bubbles:true})));expect(onView).toHaveBeenLastCalledWith(view);}
 render(true);act(()=>node.querySelector<HTMLButtonElement>('button[aria-label="手形"]')!.click());expect(onTool).toHaveBeenCalledTimes(2);
 }finally{act(()=>root.unmount());node.remove();}
});

it("工具栏按槽位渲染：5 段 16 槽，画笔与铅笔同在一个槽内",()=>{
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),onTool=vi.fn();
 try {
  act(()=>root.render(<EditorToolRail tool="brush" onTool={onTool} readonly={false} color="#000000" onColor={()=>{}}/>));
  const rail=node.querySelector<HTMLElement>(".photo-editor__toolrail")!;
  expect(rail.dataset.sections).toBe("5");
  const sections=Array.from(node.querySelectorAll<HTMLElement>(".photo-editor__tool-section"));
  expect(sections.map(section=>section.dataset.section)).toEqual(["1","2","3","4","5"]);
  expect(sections.map(section=>section.querySelectorAll("button").length)).toEqual([1,4,8,1,2]);
  // 画笔槽位（索引 8）同时承载画笔、铅笔、混合画笔与颜色替换；flyout 成员顺序由注册表断言，
  // 展开行为由 `tool-slot-button.test.tsx` 覆盖。
  const brushSlot=node.querySelector<HTMLElement>('[data-tool-slot="8"]')!;
  expect(brushSlot.dataset.toolMember).toBe("brush");
  const brushMembers=TOOL_SLOTS.find(slot=>slot.index===8)!.members.map(member=>member.id);
  expect(brushMembers).toEqual(["brush","pencil","mixer","colorReplacement"]);
  // 已保存的槽位记忆让按钮显示铅笔而不是画笔。
  act(()=>root.render(<EditorToolRail tool="move" onTool={onTool} readonly={false} color="#000000" onColor={()=>{}}
    shownMemberFor={slot=>slot.index===8?slot.members[1]!:slot.members.find(member=>member.tool==="move")??slot.members[0]!}/>));
  expect(node.querySelector<HTMLElement>('[data-tool-slot="8"]')!.dataset.toolMember).toBe("pencil");
 } finally {act(()=>root.unmount());node.remove();}
});

it("单成员槽位不画 flyout 三角；多成员槽位画三角",()=>{
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 try {
  act(()=>root.render(<EditorToolRail tool="move" onTool={()=>{}} readonly={false} color="#000000" onColor={()=>{}}/>));
  for(const index of [0,2,3,6,10,12,19,20]) {
   expect(node.querySelector<HTMLElement>(`[data-tool-slot="${index}"]`)!.querySelector(".photo-editor__tool-group-mark")).toBeNull();
  }
  for(const index of [1,7,8,9,11,13,14,16]) {
   expect(node.querySelector<HTMLElement>(`[data-tool-slot="${index}"]`)!.querySelector(".photo-editor__tool-group-mark")).not.toBeNull();
  }
 } finally {act(()=>root.unmount());node.remove();}
});

it("快速蒙版按钮随文档状态切换提示并派发同一命令",()=>{
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node),onQuickMask=vi.fn();
 const render=(quickMask:boolean,readonly=false)=>act(()=>root.render(<EditorToolRail tool="marquee" onTool={()=>{}}
   readonly={readonly} color="#000000" onColor={()=>{}} quickMask={quickMask} onQuickMask={onQuickMask}/>));
 try {
  render(false);
  const button=node.querySelector<HTMLButtonElement>(".photo-editor__quick-mask")!;
  expect(button.getAttribute("aria-label")).toBe("以快速蒙版模式编辑（Q）");
  expect(button.getAttribute("aria-pressed")).toBe("false");
  act(()=>button.click());
  expect(onQuickMask).toHaveBeenCalledOnce();
  render(true);
  const active=node.querySelector<HTMLButtonElement>(".photo-editor__quick-mask")!;
  expect(active.getAttribute("aria-label")).toBe("以标准模式编辑（Q）");
  expect(active.getAttribute("aria-pressed")).toBe("true");
  render(true,true);
  act(()=>node.querySelector<HTMLButtonElement>(".photo-editor__quick-mask")!.click());
  expect(onQuickMask).toHaveBeenCalledOnce();
 } finally {act(()=>root.unmount());node.remove();}
});

it("槽位按钮高亮：槽内任一成员为当前工具即高亮",()=>{
 const node=document.createElement("div");document.body.append(node);const root=createRoot(node);
 try {
  act(()=>root.render(<EditorToolRail tool="pencil" onTool={()=>{}} readonly={false} color="#000000" onColor={()=>{}}/>));
  expect(node.querySelector<HTMLElement>('[data-tool-slot="8"]')!.getAttribute("aria-pressed")).toBe("true");
  expect(node.querySelector<HTMLElement>('[data-tool-slot="0"]')!.getAttribute("aria-pressed")).toBe("false");
 } finally {act(()=>root.unmount());node.remove();}
});

it("批量关闭菜单使用宿主回调，关闭其他仅在多文档可用",()=>{
 const host=document.createElement("div"),root=createRoot(host),all=vi.fn(),others=vi.fn(),native=vi.fn();
 const render=(count:number,readonly=false)=>act(()=>root.render(<EditorMenuBar commands={new Map()} readonly={readonly} canUndo={false} canRedo={false} onCommand={native} onApply={()=>{}} canSave={false} saving={false} documents={{onCloseAllDocuments:all,onCloseOtherDocuments:others,list:Array.from({length:count},(_,i)=>({id:String(i),name:String(i),active:i===0}))}}/>));
 try {render(2);act(()=>host.querySelector<HTMLButtonElement>('[data-command="file.closeAll"]')!.click());act(()=>host.querySelector<HTMLButtonElement>('[data-command="file.closeOthers"]')!.click());expect(all).toHaveBeenCalledOnce();expect(others).toHaveBeenCalledOnce();expect(native).not.toHaveBeenCalled();render(1);expect(host.querySelector<HTMLButtonElement>('[data-command="file.closeOthers"]')!.disabled).toBe(true);render(2,true);expect(host.querySelector<HTMLButtonElement>('[data-command="file.closeAll"]')!.disabled).toBe(true);}finally{act(()=>root.unmount());}
});

it("不提供无效果预览/语言勾选和Web本机路径占位菜单，即使外部误报allowed",()=>{
  const ids=["view.pixelArtPreview",...(["small","medium","large","extraLarge","huge"].map(size=>`type.fontPreviewSize.${size}`)),...(["defaultFeatures","eastAsianFeatures","middleEasternFeatures","middleEasternAndSouthAsianComposer"].map(option=>`type.languageOptions.${option}`)),"file.import.videoFramesToLayers","edit.presets.migratePresets","file.print","file.printOneCopy","file.generate.imageAssets","file.import.wiaSupport","file.placeEmbedded","file.placeLinked","file.scripts.loadFilesIntoStack","file.automate.contactSheetII","file.automate.lensCorrection","file.scripts.imageProcessor","file.automate.createDroplet"];
  const commands=new Map(ids.map(id=>[id,{id,allowed:true,enabled:true} as PhotocraftCommand])),onCommand=vi.fn();
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  try{
    act(()=>root.render(<EditorMenuBar commands={commands} readonly={false} canUndo={false} canRedo={false} onCommand={onCommand} onApply={vi.fn()} canSave={false} saving={false}/>));
    for(const id of ids)expect(container.querySelector(`[data-command="${id}"]`)).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
  }finally{act(()=>root.unmount());container.remove();}
});

it("适合图像与全局蒙版烘焙使用各自File子菜单并遵守能力/只读门禁",()=>{
 const ids=["file.automate.fitImage","file.scripts.flattenAllMasks","file.scripts.browse"],run=vi.fn();const node=document.createElement("div"),root=createRoot(node);
 const render=(readonly=false,allowed=true)=>act(()=>root.render(<EditorMenuBar commands={new Map(ids.map(id=>[id,{id,allowed,enabled:true} as PhotocraftCommand]))} readonly={readonly} canUndo={false} canRedo={false} onCommand={run} onApply={vi.fn()} canSave={false} saving={false}/>));
 try {render();for(const id of ids)act(()=>node.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!.click());expect(run.mock.calls).toEqual(ids.map(id=>[id]));render(true);for(const id of ids)expect(node.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!.disabled).toBe(true);render(false,false);for(const id of ids)expect(node.querySelector(`[data-command="${id}"]`)).toBeNull();}finally{act(()=>root.unmount());}
});

it("复制整文档是图像菜单宿主动作，能力/忙碌/只读禁用，不透传内核多文档命令",()=>{
 const duplicate=vi.fn(),native=vi.fn(),node=document.createElement("div"),root=createRoot(node);
 const render=(enabled:boolean,readonly=false)=>act(()=>root.render(<EditorMenuBar commands={new Map()} readonly={readonly} canUndo={false} canRedo={false} onCommand={native} onApply={()=>{}} canSave={false} saving={false} documents={{onDuplicateDocument:duplicate,duplicateDisabled:!enabled}}/>));
 try{render(true);const button=node.querySelector<HTMLButtonElement>('[data-menu="图像"] [data-command="image.duplicateDocument"]')!;expect(button).not.toBeNull();act(()=>button.click());expect(duplicate).toHaveBeenCalledOnce();expect(native).not.toHaveBeenCalled();render(false);act(()=>button.click());render(true,true);act(()=>button.click());expect(duplicate).toHaveBeenCalledOnce();}finally{act(()=>root.unmount());}
});

it("粘贴入/外使用选择性粘贴菜单，能力关闭隐藏、缺选区禁用且只传命令id",()=>{
 const into="edit.pasteSpecial.pasteInto",outside="edit.pasteSpecial.pasteOutside",run=vi.fn(),node=document.createElement("div"),root=createRoot(node),commands=new Map([[into,{allowed:true,enabled:true}],[outside,{allowed:true,enabled:false}]]) as Map<string,PhotocraftCommand>;
 const render=(readonly=false)=>act(()=>root.render(<EditorMenuBar commands={commands} readonly={readonly} canUndo={false} canRedo={false} onCommand={run} onApply={()=>{}} canSave={false} saving={false}/>));
 try{render();const inside=node.querySelector<HTMLButtonElement>(`[data-submenu="pasteSpecial"] [data-command="${into}"]`)!;expect(inside.textContent).toContain("粘贴入");act(()=>inside.click());expect(run.mock.calls).toEqual([[into]]);expect(node.querySelector<HTMLButtonElement>(`[data-command="${outside}"]`)!.disabled).toBe(true);render(true);expect(inside.disabled).toBe(true);commands.set(outside,{allowed:false,enabled:true} as PhotocraftCommand);render();expect(node.querySelector(`[data-command="${outside}"]`)).toBeNull();}finally{act(()=>root.unmount());}
});
