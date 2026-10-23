/** @vitest-environment jsdom */
// 菜单替身只检查命令分派和可用状态，不执行图像合成。
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";
import { EditorMenuBar } from "./photo-editor-chrome.js";
import {INITIAL_EDITOR_DISPLAY} from "./editor-display.js";
vi.mock("./ui/Menu.js", () => {
  const entries = (items: readonly import("./ui/Menu.js").MenuItem[]): ReactNode => items.map(item =>
    item.children ? <div key={item.id} data-submenu={item.id}>{entries(item.children)}</div> :
      <button key={item.id} data-command={item.id} disabled={item.disabled} onClick={() => item.onSelect(item.id)}>{item.label}</button>);
  return {DropdownMenu: ({label, items}: {label: string; items: readonly import("./ui/Menu.js").MenuItem[]}) =>
    <div data-menu={label}>{entries(items)}</div>};
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("功能菜单分派面板入口，文件保存和主按钮统一经过应用门禁",()=>{
  const container=document.createElement("div"),root=createRoot(container);
  const onApply=vi.fn(),onSave=vi.fn(),onOpenFeature=vi.fn();
  try {
    act(()=>root.render(<EditorMenuBar commands={new Map()} readonly={false} canUndo={false} canRedo={false}
      onCommand={vi.fn()} onApply={onApply} canSave saving={false} onOpenFeature={onOpenFeature}
      documents={{onSave,saveLabel:"保存工程",onExportPng:vi.fn()}}/>));
    for(const id of ["adjustments","selection","filter","vector","smartObject","typography","fillLayer","blending","matting","layerComps","stylePresets"]) {
      act(()=>container.querySelector<HTMLButtonElement>(`[data-command="feature.${id}"]`)!.click());
      expect(onOpenFeature).toHaveBeenLastCalledWith(id);
    }
    act(()=>container.querySelector<HTMLButtonElement>('[data-command="file.save"]')!.click());
    act(()=>container.querySelector<HTMLButtonElement>('.ui-button--primary')!.click());
    expect(onApply).toHaveBeenCalledTimes(2);expect(onSave).not.toHaveBeenCalled();
  } finally {act(()=>root.unmount());}
});
it("窗口菜单承载域面板入口，没有显示控件时仍可按名称打开时间轴",()=>{
  const container=document.createElement("div"),root=createRoot(container);
  const onOpenFeature=vi.fn();
  try {
    act(()=>root.render(<EditorMenuBar commands={new Map()} readonly={false} canUndo={false} canRedo={false}
      onCommand={vi.fn()} onApply={vi.fn()} canSave={false} saving={false} onOpenFeature={onOpenFeature} />));
    const timeline=container.querySelector<HTMLButtonElement>('[data-menu="窗口"] [data-command="feature.timeline"]');
    expect(timeline?.textContent).toContain("时间轴");
    act(()=>timeline!.click());
    expect(onOpenFeature).toHaveBeenCalledWith("timeline");
  } finally {act(()=>root.unmount());}
});
it("窗口与文件菜单列出各自域的 feature 入口，点击即打开对应面板",()=>{
  // 历史记录/动作/变量与数据集声明 `menu: "窗口"`，自动处理声明 `menu: "文件"`。
  // 这两处原先都没接 `featureMenuSections`：「窗口」菜单根本不存在，「文件」被显式滤掉，
  // 于是域面板只剩「高级…」一条路。
  const container=document.createElement("div"),root=createRoot(container);
  const onOpenFeature=vi.fn();
  try {
    act(()=>root.render(<EditorMenuBar commands={new Map()} readonly={false} canUndo={false} canRedo={false}
      onCommand={vi.fn()} onApply={vi.fn()} canSave={false} saving={false} onOpenFeature={onOpenFeature}
      display={{state:INITIAL_EDITOR_DISPLAY,toggle:vi.fn()}}
      documents={{onSave:vi.fn(),saveLabel:"保存工程",onCloseDocument:vi.fn()}}/>));
    for(const id of ["history","actions","dataSets"]) {
      act(()=>container.querySelector<HTMLButtonElement>(`[data-menu="窗口"] [data-command="feature.${id}"]`)!.click());
      expect(onOpenFeature).toHaveBeenLastCalledWith(id);
    }
    act(()=>container.querySelector<HTMLButtonElement>('[data-menu="文件"] [data-command="feature.automation"]')!.click());
    expect(onOpenFeature).toHaveBeenLastCalledWith("automation");
  } finally {act(()=>root.unmount());container.remove();}
});

it("宿主没有文档动作时「文件」仍渲染域入口，自动处理不是只有高级区可达",()=>{
  // 独立 dev 宿主只注入 `documents.transfer`，没有打开/保存/关闭任何一项。此时
  // `editorMenusFor` 不产出「文件」菜单；若 feature 项只在既有菜单里追加，域声明的入口
  // 就整体消失（面板还挂在高级区，但用户无从发现）。这里钉住「文件」菜单由域入口独立成立。
  const container=document.createElement("div"),root=createRoot(container);
  const onOpenFeature=vi.fn();
  try {
    act(()=>root.render(<EditorMenuBar commands={new Map()} readonly={false} canUndo={false} canRedo={false}
      onCommand={vi.fn()} onApply={vi.fn()} canSave={false} saving={false} onOpenFeature={onOpenFeature}
      display={{state:INITIAL_EDITOR_DISPLAY,toggle:vi.fn()}}
      documents={{transfer:{enabled:true,onSelect:vi.fn()}}}/>));
    const items=[...container.querySelectorAll<HTMLButtonElement>('[data-menu="文件"] button')];
    expect(items.map(item=>item.getAttribute("data-command"))).toEqual(["feature.automation", "feature.filesNewDocument", "feature.filesCopy", "feature.filesFileInfo"]);
    expect(items[0].textContent).toBe("自动处理…");
    act(()=>items[0]!.click());
    expect(onOpenFeature).toHaveBeenLastCalledWith("automation");
  } finally {act(()=>root.unmount());container.remove();}
});

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
    expect(buttons).toHaveLength(1);expect(buttons[0].textContent).toContain("选区与变换边界");
    const windows=container.querySelectorAll<HTMLButtonElement>('[data-menu="窗口"] button');
    expect(windows).toHaveLength(2);expect(windows[1].textContent).toContain("Shift+Tab");
    act(()=>[...buttons,...windows].forEach(button=>button.click()));
    expect(toggle.mock.calls).toEqual([["extras"],["panels"],["sidebar"]]);
    render(true);act(()=>container.querySelectorAll<HTMLButtonElement>('[data-menu="视图"] button, [data-menu="窗口"] button').forEach(button=>button.click()));
    expect(toggle).toHaveBeenCalledTimes(3);expect(onCommand).not.toHaveBeenCalled();
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
    expect(onView.mock.calls).toEqual([["zoomIn"],["zoomOut"],["fit"],["actualSize"]]);
    expect(container.querySelector<HTMLButtonElement>('[data-command="edit.redo"]')!.disabled).toBe(true);
    render(true);
    act(()=>container.querySelectorAll<HTMLButtonElement>('[data-menu] button').forEach(button=>button.click()));
    expect(onTransform).toHaveBeenCalledTimes(2);expect(onView).toHaveBeenCalledTimes(4);expect(onCommand).not.toHaveBeenCalled();
  } finally {act(()=>root.unmount());}
});

/**
 * U58/U59/U61：新登记的命令必须真的能在菜单里点到。
 *
 * 仓库的菜单是手写清单（内核 `commandsJson()` 的 `menu` 元数据不参与渲染），所以「命令已登记」
 * 不等于「用户可达」。这条用例逐个断言本域新增条目的位置与分派目标。
 */
it("图层与编辑菜单提供链接、剪切建层、盖印、粘贴入/外与图层样式入口", () => {
  const ids = [
    "layer.linkLayers", "layer.selectLinkedLayers", "layer.new.layerViaCut", "layer.new.layerFromBackground",
    "layer.new.backgroundFromLayer", "layer.stampVisible", "layer.stampDown", "layer.arrange.reverse",
    "layer.layerStyle.blendingOptions", "layer.layerStyle.copyLayerStyle", "layer.layerStyle.pasteLayerStyle",
    "layer.layerStyle.clear", "layer.layerStyle.scaleEffects", "layer.layerStyle.createLayer",
    "layer.rasterize.layerStyle", "layer.matting.defringe", "layer.matting.removeBlackMatte",
    "layer.matting.removeWhiteMatte", "layer.matting.colorDecontaminate",
    "edit.pasteSpecial.pasteInto", "edit.pasteSpecial.pasteOutside",
  ];
  const commands = new Map(ids.map((id) => [id, { id, allowed: true, enabled: true } as PhotocraftCommand]));
  const onCommand = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<EditorMenuBar commands={commands} readonly={false} canUndo={false} canRedo={false}
      onCommand={onCommand} onApply={vi.fn()} canSave={false} saving={false} />));
    // 每个 id 都必须作为某个已渲染按钮出现（不是只在数据里存在）。
    for (const id of ids) expect(container.querySelector(`[data-command="${id}"]`), id).not.toBeNull();
    // 抽样分派：盖印、反转、样式栅格化、粘贴入。
    for (const id of ["layer.stampVisible", "layer.arrange.reverse", "layer.rasterize.layerStyle", "edit.pasteSpecial.pasteInto"]) {
      act(() => container.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!.click());
      expect(onCommand).toHaveBeenLastCalledWith(id);
    }
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("单一滤镜菜单包含分类命令；导出动作收在子菜单且保留回调", () => {
  const container = document.createElement("div"), root = createRoot(container);
  const onFeatureCommand = vi.fn(), onExportPng = vi.fn();
  try {
    act(() => root.render(<EditorMenuBar commands={new Map([["filter.lastFilter", {id:"filter.lastFilter",allowed:true,enabled:true} as PhotocraftCommand]])}
      readonly={false} canUndo={false} canRedo={false} onCommand={vi.fn()} onApply={vi.fn()} canSave={false} saving={false}
      onOpenFeature={vi.fn()} onFeatureCommand={onFeatureCommand}
      featureCommands={[{panel:"filter",command:"blur.gaussian",label:"高斯模糊…",category:"模糊"},{panel:"adjustments",command:"levels",label:"色阶…",category:"调整"}]}
      documents={{onExportPng}} />));
    expect(container.querySelectorAll('[data-menu="滤镜"]')).toHaveLength(1);
    act(() => container.querySelector<HTMLButtonElement>('[data-menu="滤镜"] [data-submenu="category.模糊"] button')!.click());
    expect(onFeatureCommand).toHaveBeenLastCalledWith("filter", "blur.gaussian");
    act(() => container.querySelector<HTMLButtonElement>('[data-menu="图像"] [data-submenu="category.调整"] button')!.click());
    expect(onFeatureCommand).toHaveBeenLastCalledWith("adjustments", "levels");
    act(() => container.querySelector<HTMLButtonElement>('[data-submenu="file.export"] [data-command="file.exportPng"]')!.click());
    expect(onExportPng).toHaveBeenCalledOnce();
  } finally {act(() => root.unmount());container.remove();}
});
