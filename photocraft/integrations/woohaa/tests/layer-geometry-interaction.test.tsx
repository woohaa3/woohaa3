/** @vitest-environment jsdom */
import {act} from "react";
import {expect,it} from "vitest";
import {setup,press,canvasPort} from "../src/test-support/photo-editor-harness.js";
const frame=[20,10,120,60];
function start(){const result=setup(false,{hasSelection:true,document:{layerTransformFrame:frame,transformFrame:[30,20,40,30],documentKey:"geometry-doc",revision:1}});result.snapshot.commands.set("edit.transform",{allowed:true,enabled:true} as never);result.render(false);return result;}
function setWidth(container:Element,value:string){const field=container.querySelector<HTMLInputElement>('[data-geometry-field="width"]')!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event("input",{bubbles:true}));});press(field,"Enter");return field;}
it("属性宽度使用整层边界及整层草稿，输入不发布，确认一事务且不切换工具",()=>{
 const {container,transform}=start();const field=container.querySelector<HTMLInputElement>('[data-geometry-field="width"]')!;expect(field.value).toBe("100");
 act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field,"200");field.dispatchEvent(new Event("input",{bubbles:true}));});expect(transform.beginMove).not.toHaveBeenCalled();press(field,"Enter");
 expect(transform.beginMove).toHaveBeenCalledWith({x:20,y:10,autoSelect:false,duplicate:false,wholeLayer:true});expect(transform.previewTransform).toHaveBeenCalledWith([2,0,0,2,-20,-10]);expect(transform.commitTransform).toHaveBeenCalledOnce();expect(container.querySelector('[data-canvas]')?.getAttribute("data-tool")).not.toBe("transform");
});
it("候选或提交失败取消隔离草稿，能力、只读、半手势和过期修订不写",()=>{
 const {container,transform,render,snapshot}=start();transform.previewTransform.mockReturnValue({ok:false,message:"超限"} as never);const field=setWidth(container,"200");expect(transform.commitTransform).not.toHaveBeenCalled();expect(transform.cancelTransform).toHaveBeenCalledOnce();
 transform.previewTransform.mockReturnValue({ok:true});transform.commitTransform.mockReturnValue({ok:false,message:"失效"} as never);press(field,"Enter");expect(transform.cancelTransform).toHaveBeenCalledTimes(2);
 const count=transform.beginMove.mock.calls.length;
 const original=snapshot.view;snapshot.view={...original,document:{...original.document!,revision:2}};press(field,"Enter");expect(transform.beginMove).toHaveBeenCalledTimes(count);snapshot.view=original;
 canvasPort.hasGesture.mockReturnValue(true);press(field,"Enter");expect(transform.beginMove).toHaveBeenCalledTimes(count);canvasPort.hasGesture.mockReturnValue(false);
 render(true);expect(container.querySelector<HTMLInputElement>('[data-geometry-field="width"]')!.disabled).toBe(true);press(field,"Enter");expect(transform.beginMove).toHaveBeenCalledTimes(count);
 render(false);snapshot.commands.set("edit.transform",{allowed:true,enabled:false} as never);render(false);expect(container.querySelector<HTMLInputElement>('[data-geometry-field="width"]')!.disabled).toBe(true);
 snapshot.commands.set("edit.transform",{allowed:false,enabled:true} as never);render(false);expect(container.querySelector<HTMLInputElement>('[data-geometry-field="width"]')!.disabled).toBe(true);
});
