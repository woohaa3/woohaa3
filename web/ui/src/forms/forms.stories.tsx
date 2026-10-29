import { useState } from "react";
import type { StoryDefault } from "@ladle/react";
import { TextInput, TextArea, SelectInput, Listbox } from "./index.js";
import { ComponentStage } from "../test-support/story-stage.js";
export default { title: "公共 UI/表单" } satisfies StoryDefault;

/** 全量组合：空值/有值、禁用、只读、长值、空列表与受控回流。 */
export function Controlled() {
  const [text, setText] = useState(""); const [selected, select] = useState("a");
  const options = [{ value: "a", label: "默认选项" }, { value: "long", label: "长名称的工作区与模型选项".repeat(5) }, { value: "disabled", label: "不可用", disabled: true }];
  return <ComponentStage>{record => <>
    <TextInput placeholder="输入内容" value={text} onChange={e => { setText(e.target.value); record("输入"); }} />
    <TextArea value={text} onChange={e => setText(e.target.value)} rows={4} />
    <TextInput disabled value="禁用" /><TextInput readOnly value={"长内容".repeat(40)} />
    <SelectInput label="选择" value={selected} options={options} onValueChange={v => { select(v); record(v); }} />
    <SelectInput label="空列表" value="" options={[]} onValueChange={select} />
    <SelectInput label="禁用选择" value={selected} options={options} disabled onValueChange={select} />
    <Listbox label="列表" value={selected} options={options} onValueChange={v => { select(v); record(v); }} />
    <Listbox label="空列表" value="" options={[]} empty="暂无可选项" onValueChange={select} />
    <output>{text} / {selected}</output>
  </>}</ComponentStage>;
}

/** 空值与禁用：无值与不可编辑控件不产生回调，空列表给出占位说明。 */
export function EmptyAndDisabled() {
  const [value, setValue] = useState("");
  return <ComponentStage>{record => <>
    <TextInput placeholder="空输入" value={value} onChange={e => { setValue(e.target.value); record("空输入"); }} />
    <TextInput placeholder="禁用输入" disabled value="" />
    <TextInput placeholder="只读输入" readOnly value="" />
    <TextArea placeholder="空多行" value="" rows={3} onChange={() => record("不应触发")} />
    <SelectInput label="空选择" value="" options={[]} onValueChange={() => record("不应触发")} />
    <Listbox label="空列表" value="" options={[]} empty="暂无可选项" onValueChange={() => record("不应触发")} />
    <output>当前值：{value || "（空）"}</output>
  </>}</ComponentStage>;
}

/** 长值与长列表：长文本、超长选项与禁用项可读取且不触发选择。 */
export function LongValues() {
  const [selected, select] = useState("opt-0");
  const many = Array.from({ length: 40 }, (_, index) => ({ value: `opt-${index}`, label: `选项 ${index + 1} · ${"长名称".repeat(6)}`, disabled: index === 3 }));
  return <ComponentStage>{record => <>
    <TextInput value={"很长的已填写值".repeat(30)} onChange={() => record("长值输入")} />
    <TextArea value={"多行长内容\n".repeat(20)} rows={5} onChange={() => record("长多行输入")} />
    <SelectInput label="长选项" value={selected} options={many} onValueChange={v => { select(v); record(v); }} />
    <Listbox label="长列表" value={selected} options={many} onValueChange={v => { select(v); record(v); }} />
    <output>当前选择：{selected}（第 4 项禁用）</output>
  </>}</ComponentStage>;
}
