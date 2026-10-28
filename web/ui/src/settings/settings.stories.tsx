import { useState } from "react";
import type { StoryDefault } from "@ladle/react";
import { SettingsSection, SettingsFeedback } from "./index.js";
import { Button } from "../primitives/index.js";
import { ComponentStage } from "../test-support/story-stage.js";
export default { title: "公共 UI/设置展示" } satisfies StoryDefault;

/** 分区 + 动作 + 四种反馈语气，含长错误文案。 */
export function Feedback() {
  const [saved, save] = useState(false);
  return <ComponentStage>{record => <SettingsSection title="工作区" description="保存和校验由调用方持有" action={<Button onClick={() => { save(!saved); record("保存"); }}>保存</Button>}>
    <SettingsFeedback>{saved ? "已保存" : "尚未修改"}</SettingsFeedback>
    <SettingsFeedback tone="success">配置已保存</SettingsFeedback>
    <SettingsFeedback tone="warning">连接尚未验证</SettingsFeedback>
    <SettingsFeedback tone="danger">{"请求失败，请检查当前配置后重试。".repeat(20)}</SettingsFeedback>
  </SettingsSection>}</ComponentStage>;
}

/** 语气矩阵：neutral/success/warning/danger 与长错误、动作组合。 */
export function Tones() {
  const [retry, setRetry] = useState(0);
  return <ComponentStage>{record => <SettingsSection title="反馈语气" description="语气只表达状态，不承担保存或重试语义">
    {(["neutral", "success", "warning", "danger"] as const).map(tone => <SettingsFeedback key={tone} tone={tone}>
      {tone === "danger" ? `${tone}：上游不可达，请检查凭据后重试。${"补充诊断。".repeat(30)}` : `${tone}：状态说明`}
    </SettingsFeedback>)}
    <Button onClick={() => { setRetry(v => v + 1); record(`重试 ${retry + 1}`); }}>重试（{retry}）</Button>
  </SettingsSection>}</ComponentStage>;
}

/** 分区组合：仅标题、标题+说明、带 action 与嵌套内容。 */
export function SectionComposition() {
  return <ComponentStage>{record => <>
    <SettingsSection title="只有标题"><p>最小内容</p></SettingsSection>
    <SettingsSection title="标题与说明" description="说明由调用方提供，组件不读取配置"><p>内容</p></SettingsSection>
    <SettingsSection
      title="带动作"
      description="动作插槽在右上角"
      action={<Button size="sm" onClick={() => record("打开设置")}>打开设置</Button>}
    >
      <SettingsFeedback tone="neutral">等待操作</SettingsFeedback>
    </SettingsSection>
  </>}</ComponentStage>;
}
