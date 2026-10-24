/** @vitest-environment jsdom */
// 独立文件动作条：保存工程、另存为与导出 PNG 的入口与禁用状态。
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {FileDocumentActionsBar} from "../src/file-document-surface.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";vi.restoreAllMocks();vi.unstubAllGlobals();});

function setup(props:Partial<Parameters<typeof FileDocumentActionsBar>[0]>={}) {
  const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const actions={saveProject:vi.fn(),saveProjectAs:vi.fn(),exportPng:vi.fn()};
  act(()=>root.render(<FileDocumentActionsBar
    view={{fileName:"图.png",subscribe:()=>()=>{},revisionState:()=>0} as never}
    actions={actions} status="未保存" {...props}/>));
  const button=(label:string)=>[...host.querySelectorAll("button")].find(node=>node.textContent?.startsWith(label));
  return {host,actions,button};
}

it("另存为要求文件名，补上 .pcraft 后走同一交付端口",()=>{
  const prompt=vi.fn(()=>"我的副本");
  vi.stubGlobal("prompt",prompt);
  const {actions,button}=setup();
  act(()=>button("另存为")!.click());
  expect(prompt).toHaveBeenCalledOnce();
  expect(actions.saveProjectAs).toHaveBeenCalledWith("我的副本.pcraft");
  // 已带扩展名时不重复追加。
  prompt.mockReturnValue("已有.PCRAFT");
  act(()=>button("另存为")!.click());
  expect(actions.saveProjectAs).toHaveBeenLastCalledWith("已有.PCRAFT");
  // 取消或空白不派发。
  prompt.mockReturnValue("   ");
  act(()=>button("另存为")!.click());
  expect(actions.saveProjectAs).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
  prompt.mockReturnValue(null as never);
  act(()=>button("另存为")!.click());
  expect(actions.saveProjectAs).toHaveBeenCalledTimes(2);
});

it("只读时不提供保存与另存为，导出 PNG 仍可用；缺少另存为端口时不显示该按钮",()=>{
  const readonly=setup({readonly:true});
  expect(readonly.button("保存工程")).toHaveProperty("disabled",true);
  expect(readonly.button("另存为")).toHaveProperty("disabled",true);
  expect(readonly.button("导出 PNG")).toHaveProperty("disabled",false);
  act(()=>readonly.button("导出 PNG")!.click());
  expect(readonly.actions.exportPng).toHaveBeenCalledOnce();
  expect(readonly.actions.saveProject).not.toHaveBeenCalled();

  const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  act(()=>root.render(<FileDocumentActionsBar view={{fileName:"图.png",subscribe:()=>()=>{},revisionState:()=>0} as never}
    actions={{saveProject:vi.fn(),exportPng:vi.fn()}} status={null}/>));
  expect([...host.querySelectorAll("button")].some(node=>node.textContent?.startsWith("另存为"))).toBe(false);
});
