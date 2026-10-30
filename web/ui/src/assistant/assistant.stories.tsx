import { useState } from "react";
import type { StoryDefault } from "@ladle/react";
import { AssistantComposer, AssistantToolbar, AssistantConnectionSelector, AssistantListSelector, AssistantModelSelector } from "./index.js";
import { Button, Switch } from "../primitives/index.js";
import { ComponentStage } from "../test-support/story-stage.js";
export default { title: "公共 UI/助手" } satisfies StoryDefault;
export function ComposerAndSelectors() {
  const [text, change] = useState(""); const [disabled, disable] = useState(false); const [loading, load] = useState(false);
  const [model, select] = useState("default"); const [variant, choose] = useState(""); const [connectionOpen, openConnection] = useState(false);
  const [modelOpen, openModel] = useState(false); const [listOpen, openList] = useState(false);
  const options = [{ value: "default", label: "默认模型" }, { value: "long", label: "长名称连接与助手模型".repeat(10) }, { value: "invalid", label: "连接失效", detail: "当前不可用", disabled: true }];
  return <ComponentStage>{record => <>
    <label>禁用 <Switch checked={disabled} onCheckedChange={disable} /></label>
    <label>加载 <Switch checked={loading} onCheckedChange={load} /></label>
    <AssistantComposer value={text} onChange={change} onSubmit={() => record("Enter 提交")} disabled={disabled} placeholder="Enter 提交，Shift+Enter 换行" />
    <AssistantToolbar disabled={disabled} refreshing={loading} onRefresh={() => { load(!loading); record("刷新"); }} onManage={() => record("管理")}
      assistant={<AssistantConnectionSelector empty={false} loading={loading} options={options} model={model} disabled={disabled} open={connectionOpen} onOpenChange={openConnection} onChange={v => { select(v); record(v); }} />}
      parameters={<AssistantModelSelector model={model} options={options} open={modelOpen} onOpenChange={openModel} disabled={disabled}
        onChange={v => { select(v); record(v); }} variant={{ value: variant, options: [{ value: "", label: "默认 Variant" }, { value: "high", label: "深入" }, { value: "unavailable", label: "不可用", disabled: true }], onChange: v => { choose(v); record(`Variant:${v}`); } }} />}
      beforeSubmit={<span>动作插槽</span>} submit={<Button disabled={disabled || loading} onClick={() => record("提交")}>生成</Button>} />
    <AssistantConnectionSelector empty loading={loading} model="" options={[]} open={false} onOpenChange={openConnection} onChange={select} onManage={() => record("配置助手")} />
    <AssistantListSelector model={model} options={options} open={listOpen} onOpenChange={openList} onChange={v => { select(v); record(v); }} />
    <output>{model} / Variant「{variant}」/ {text}</output>
  </>}</ComponentStage>;
}

/** 输入框：空值、长文本、禁用；Enter 提交，Shift+Enter 换行（输入法组合期间不提交）。 */
export function ComposerStates() {
  const [text, change] = useState("");
  const [disabled, disable] = useState(false);
  return <ComponentStage>{record => <>
    <label className="showcase__row"><Switch checked={disabled} onCheckedChange={value => { disable(value); record(value ? "禁用" : "启用"); }} /> 禁用输入</label>
    <AssistantComposer value={text} onChange={change} onSubmit={() => record("Enter 提交")} disabled={disabled} placeholder="Enter 提交；Shift+Enter 换行；组合输入期间不提交" />
    <Button size="sm" onClick={() => change("已填充的长文本。".repeat(60))}>填入长文本</Button>
    <Button size="sm" onClick={() => change("")}>清空</Button>
    <output>字符数：{text.length}</output>
  </>}</ComponentStage>;
}

/** 选择器：空目录、加载、禁用、长名称与不可用项；Variant 允许空串表示默认。 */
export function SelectorStates() {
  const [model, select] = useState("default");
  const [variant, choose] = useState("");
  const [open, setOpen] = useState(false);
  const [disabled, disable] = useState(false);
  const options = [
    { value: "default", label: "默认模型" },
    { value: "long", label: "超长连接与模型名称".repeat(12), detail: "提供方：本地" },
    { value: "offline", label: "已下线模型", detail: "不可用", disabled: true }
  ];
  return <ComponentStage>{record => <>
    <label className="showcase__row"><Switch checked={disabled} onCheckedChange={value => { disable(value); record(value ? "禁用选择器" : "启用选择器"); }} /> 禁用选择器</label>
    <AssistantConnectionSelector empty={false} loading={false} options={options} model={model} disabled={disabled} open={open} onOpenChange={setOpen} onChange={value => { select(value); record(value); }} onManage={() => record("管理助手")} />
    <AssistantModelSelector model={model} options={options} open={open} onOpenChange={setOpen} disabled={disabled} onChange={value => { select(value); record(value); }}
      variant={{ value: variant, options: [{ value: "", label: "默认 Variant" }, { value: "high", label: "深入" }, { value: "off", label: "不可用", disabled: true }], onChange: value => { choose(value); record(`Variant:${value || "默认"}`); } }} />
    <AssistantConnectionSelector empty loading={false} model="" options={[]} open={false} onOpenChange={() => record("空目录不应打开")} onChange={() => record("空目录不应选择")} onManage={() => record("配置助手")} />
    <output>模型：{model}；Variant：{variant || "（默认）"}</output>
  </>}</ComponentStage>;
}

/** 长模型目录：超过 8 个模型时出现即时搜索，按模型名或 provider 过滤。 */
export function LongModelCatalog() {
  const [model, select] = useState("opencode/模型 1");
  const [open, setOpen] = useState(false);
  const providers = ["opencode", "aihubmix", "openrouter"];
  const options = Array.from({ length: 24 }, (_, index) => ({
    value: `${providers[index % providers.length]}/模型 ${index + 1}`,
    label: `模型 ${index + 1} (${providers[index % providers.length]})`,
  }));
  return <ComponentStage>{record => <>
    <AssistantModelSelector label="选择助手模型" model={model} options={options} open={open} onOpenChange={setOpen} onChange={value => { select(value); record(value); }} />
    <output>模型：{model}</output>
  </>}</ComponentStage>;
}

/** 工具栏：完整插槽、全缺省占位、disabled 与 refreshing。 */
export function ToolbarStates() {
  const [refreshing, refresh] = useState(false);
  const [disabled, disable] = useState(false);
  return <ComponentStage>{record => <>
    <div className="showcase__row">
      <label className="showcase__row"><Switch checked={disabled} onCheckedChange={value => { disable(value); record(value ? "禁用" : "启用"); }} /> disabled</label>
      <label className="showcase__row"><Switch checked={refreshing} onCheckedChange={value => { refresh(value); record(value ? "刷新中" : "刷新结束"); }} /> refreshing</label>
    </div>
    <AssistantToolbar />
    <AssistantToolbar disabled={disabled} refreshing={refreshing} onRefresh={() => record("刷新")} onManage={() => record("管理")}
      assistant={<span>助手：默认</span>} parameters={<span>参数：默认</span>} beforeSubmit={<span>动作</span>} submit={<Button disabled={disabled} onClick={() => record("提交")}>生成</Button>} />
  </>}</ComponentStage>;
}
