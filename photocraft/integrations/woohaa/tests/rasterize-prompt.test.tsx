/** @vitest-environment jsdom */
import {act} from "react";
import {it,expect} from "vitest";
import {DialogService} from "@woohaa3/frontend/plugin-api";
import {setup,canvasPort} from "../src/test-support/photo-editor-harness.js";

function prepare(extra:Record<string,unknown>={}) {
  const dialogs=new DialogService();
  const app=setup(false,{dialogs,document:{editTarget:"pixels",revision:1,layers:[{id:1,name:"文字",kind:"text",hasMask:true,visible:true,opacity:1,blend:"Normal"}],...extra}});
  app.snapshot.commands.set("layer.rasterize.type",{allowed:true,enabled:true} as never);
  const button=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>("button")].find(node=>node.textContent===name)!;
  act(()=>app.container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="画笔"]')!.click());
  const start=()=>{let accepted:boolean|void;act(()=>{accepted=canvasPort.props!.onStrokeStart?.({x:17,y:23,pressure:.4});});return accepted!;};
  return {...app,dialogs,button,start};
}
it("文字像素绘画先确认，取消不写；确认只恢复原点一次，迟到的抬笔不再提交",()=>{
  const {start,dialogs,button,dispatch,strokePort}=prepare();
  expect(start()).toBe(false);expect(dialogs.isModalActive()).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();expect(strokePort.beginStroke).not.toHaveBeenCalled();
  act(()=>button("取消").click());expect(dispatch).not.toHaveBeenCalled();
  start();act(()=>button("栅格化并绘制").click());
  expect(dialogs.isModalActive()).toBe(false);
  expect(dispatch.mock.calls).toEqual([["layer.rasterize.type",{layer:1}]]);
  expect(strokePort.beginStroke).toHaveBeenCalledTimes(1);expect(strokePort.commitStroke).toHaveBeenCalledTimes(1);
  const params=strokePort.beginStroke.mock.calls[0][0] as {points:number[][]};expect(params.points).toEqual([[17,23,.4]]);
  act(()=>canvasPort.props!.onStroke?.([{x:90,y:80}]));expect(strokePort.commitStroke).toHaveBeenCalledTimes(1);
});
it("确认时拒绝旧修订，关闭后重试；栅格化失败不绘画",()=>{
  const {start,button,snapshot,dispatch,strokePort}=prepare();start();
  snapshot.view.document!.revision++;
  act(()=>button("栅格化并绘制").click());expect(dispatch).not.toHaveBeenCalled();
  act(()=>button("取消").click());start();
  dispatch.mockReturnValueOnce({ok:false,message:"预算不足"} as never);
  act(()=>button("栅格化并绘制").click());expect(dispatch).toHaveBeenCalledTimes(1);expect(strokePort.beginStroke).not.toHaveBeenCalled();
});
it("蒙版绘画不栅格化文字；只读中止已停放的点击",()=>{
  const {start,button,dialogs,strokePort,snapshot,render,dispatch}=prepare({editTarget:"mask"});
  expect(start()).toBe(true);expect(dialogs.isModalActive()).toBe(false);expect(strokePort.beginStroke).toHaveBeenCalledTimes(1);
  act(()=>canvasPort.props!.onStrokeCancel?.());snapshot.view.document!.editTarget="pixels";
  render(false);start();expect(dialogs.isModalActive()).toBe(true);
  const confirm=button("栅格化并绘制");render(true);expect(dialogs.isModalActive()).toBe(false);
  act(()=>confirm.click());expect(dispatch).not.toHaveBeenCalled();expect(strokePort.beginStroke).toHaveBeenCalledTimes(1);
});
it("油漆桶冻结原点击与设置；像素锁保持原生拒绝路径，不弹栅格化",()=>{
  const {container,button,dispatch,dialogs,snapshot,render,start,strokePort}=prepare();
  act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="油漆桶"]')!.click());
  act(()=>canvasPort.props!.onBucket?.({x:31,y:42}));expect(dialogs.isModalActive()).toBe(true);expect(dispatch).not.toHaveBeenCalled();
  act(()=>button("栅格化并绘制").click());expect(dispatch.mock.calls[0]).toEqual(["layer.rasterize.type",{layer:1}]);
  expect(dispatch.mock.calls[1][0]).toBe("paint.bucket");expect(dispatch.mock.calls[1][1]).toMatchObject({x:31,y:42});
  snapshot.view.document!.layers[0].effectiveLocks.pixels=true;render(false);
  act(()=>container.querySelector<HTMLButtonElement>('.photo-editor__toolrail [aria-label="画笔"]')!.click());
  start();expect(dialogs.isModalActive()).toBe(false);expect(strokePort.beginStroke).toHaveBeenCalledOnce();
});
