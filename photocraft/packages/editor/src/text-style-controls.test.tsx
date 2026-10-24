/** @vitest-environment jsdom */
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {TextStyleControls,hasTextStyleFields} from "./text-style-controls.js";
import {decodeTextStyleDetail} from "./editor-view-model.js";
(globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root;
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML="";vi.restoreAllMocks();});

function setup(detail:Parameters<typeof TextStyleControls>[0]["style"]={}) {
  const host=document.createElement("div");document.body.append(host);root=createRoot(host);
  const onChange=vi.fn();
  const render=(props:Partial<Parameters<typeof TextStyleControls>[0]>={})=>act(()=>root.render(<TextStyleControls style={detail} size={20} disabled={false} onChange={onChange} {...props}/>));
  return {host,onChange,render};
}

it("行距在未设置时按字号显示自动值，输入提交对应原生字段",()=>{
  const {host,onChange,render}=setup();
  render();
  const leading=[...host.querySelectorAll("label")].find(node=>node.textContent?.startsWith("行距"))!.querySelector("input")!;
  expect(leading.value).toBe("24");
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(leading,"30");leading.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(onChange).toHaveBeenLastCalledWith({leading:30});
});

it("字距、基线、缩放与字重都只提交各自字段",()=>{
  const {host,onChange,render}=setup({tracking:120,baselineShift:2,horizontalScale:90,verticalScale:110,weight:700});
  render();
  const field=(label:string)=>[...host.querySelectorAll("label")].find(node=>node.textContent?.startsWith(label))!.querySelector("input")!;
  expect(field("字距").value).toBe("120");
  expect(field("水平缩放").value).toBe("90");
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field("字重"),"800");field("字重").dispatchEvent(new Event("input",{bubbles:true}));});
  expect(onChange).toHaveBeenLastCalledWith({weight:800});
  // 越界值不提交
  onChange.mockClear();
  act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(field("字重"),"1000");field("字重").dispatchEvent(new Event("input",{bubbles:true}));});
  expect(onChange).not.toHaveBeenCalled();
});

it("开关与字偶距下拉提交布尔与枚举，只读时不派发",()=>{
  const {host,onChange,render}=setup({underline:false,ligatures:true,kerning:"metrics"});
  render();
  const toggle=(label:string)=>[...host.querySelectorAll("label")].find(node=>node.textContent===label)!.querySelector("input")!;
  act(()=>toggle("下划线").click());
  expect(onChange).toHaveBeenLastCalledWith({underline:true});
  act(()=>toggle("连字").click());
  expect(onChange).toHaveBeenLastCalledWith({ligatures:false});
  const select=host.querySelector("select")!;
  act(()=>{Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value")!.set!.call(select,"optical");select.dispatchEvent(new Event("change",{bubbles:true}));});
  expect(onChange).toHaveBeenLastCalledWith({kerning:"optical"});
  onChange.mockClear();
  render({disabled:true});
  act(()=>[...host.querySelectorAll("label")].find(node=>node.textContent==="下划线")!.querySelector("input")!.click());
  expect(onChange).not.toHaveBeenCalled();
});

it("原生 character/paragraph 投影到可编辑字段，缺省字段保持未设置",()=>{
  const detail=decodeTextStyleDetail(
    {tracking:120,leading_pt:30,baseline_shift_pt:2,horizontal_scale:.9,vertical_scale:1.1,weight:700,italic:true,underline:true,strikethrough:false,faux_italic:true,ligatures:false,discretionary_ligatures:true,kerning:"optical"},
    {first_line_indent_pt:12,start_indent_pt:6,end_indent_pt:4,space_before_pt:3,space_after_pt:5,hyphenate:true}
  );
  expect(detail).toEqual({
    tracking:120,leading:30,baselineShift:2,horizontalScale:90,verticalScale:110,weight:700,
    italic:true,underline:true,strikethrough:false,fauxItalic:true,ligatures:false,discretionaryLigatures:true,kerning:"optical",
    firstLineIndent:12,startIndent:6,endIndent:4,spaceBefore:3,spaceAfter:5,hyphenate:true
  });
  // 空样式返回 null，界面不显示伪默认值。
  expect(decodeTextStyleDetail({},{})).toBeNull();
  expect(hasTextStyleFields(undefined)).toBe(false);
  expect(hasTextStyleFields({})).toBe(false);
  expect(hasTextStyleFields({tracking:0})).toBe(true);
});
