/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { expect, it, vi } from "vitest";
import { PaintingControlsContext } from "./controls-context.js";
import { usePaintingGestureSettings } from "./gesture-settings.js";
import { PaintingToolOptionsPanel } from "./panels.js";
import { PaintingContextOptions } from "./context-options.js";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("面板修改的尺寸与顶部选项、实际落笔命令同源，切换工具互不污染", () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  let settings!: ReturnType<typeof usePaintingGestureSettings>;
  const choose = vi.fn();
  const controller = {features:{painting:{}}} as unknown as EditorWorkspaceController;
  function App() {
    settings = usePaintingGestureSettings(640,480);
    return <PaintingControlsContext.Provider value={{painting:settings,tool:"pencil",choose}}>
      <PaintingContextOptions disabled={false} onMore={vi.fn()}/>
      <PaintingToolOptionsPanel controller={controller} locked={false} colors={{foreground:"#000000"}} width={640} height={480}/>
    </PaintingControlsContext.Provider>;
  }
  try {
    act(()=>root.render(<App/>));
    const input = [...container.querySelectorAll("label")].find(label=>label.textContent?.includes("尺寸（源像素）"))!.querySelector("input")!;
    act(()=>{input.value="42";Simulate.change(input);});
    expect(settings.compileStroke("pencil",[{x:1,y:1}],"#000000",{})?.params.size).toBe(42);
    expect(container.querySelector<HTMLInputElement>('[data-painting-context="pencil"] input[type="number"]')?.value).toBe("42");
    act(()=>settings.update("backgroundEraser",{size:100}));
    expect(settings.settings.pencil.size).toBe(42);
    const toolSelect = container.querySelector<HTMLSelectElement>('[data-painting-tools] select')!;
    act(()=>{toolSelect.value="bucket";Simulate.change(toolSelect);});
    expect(choose).toHaveBeenCalledWith("bucket");
  } finally {act(()=>root.unmount());container.remove();}
});
