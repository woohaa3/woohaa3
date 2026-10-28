import type { Story, StoryDefault } from "@ladle/react";
import { resolveNodeDisplayName } from "@woohaa3/contracts";

export default {
  title: "画布组件/作品名称",
} satisfies StoryDefault;

/**
 * 作品名称展示（change: 2026-10-09-improve-canvas-workflow，任务 2.4）。
 *
 * 复用生产 `resolveNodeDisplayName`：显式名称优先、其次已提交提示词摘要、最后中文默认名。
 * 卡片主标题为主、类型退居次要标记；长名称省略显示、全文可读取。
 */
function NameCard({
  type,
  explicitName,
  prompt,
  note
}: {
  type: string;
  explicitName?: string;
  prompt?: string;
  note: string;
}) {
  const resolved = resolveNodeDisplayName({ type, explicitName, prompt });
  return (
    <div className="showcase__name-card" data-name-source={resolved.nameSource} title={resolved.displayName}>
      <div className="showcase__name-card-title">{resolved.displayName}</div>
      <div className="showcase__name-card-type">{resolved.contentTypeLabel}</div>
      <div className="showcase__name-card-note">{note} · 来源：{resolved.nameSource}</div>
    </div>
  );
}

export const Naming: Story = () => (
  <div className="showcase__stage">
    <div className="showcase__caption">
      <code>resolveNodeDisplayName</code> · 显式名 / 提示词摘要 / 中文默认名
    </div>
    <div className="showcase__name-grid">
      <NameCard type="image" explicitName="海边日落" note="显式名称" />
      <NameCard type="image" explicitName="产品主图" note="显式名称" />
      <NameCard type="video" prompt="开场镜头：晨雾中的城市天际线，缓慢推近，光线柔和" note="提交提示词摘要（≤32 字）" />
      <NameCard type="audio" note="未命名（中文默认名）" />
      <NameCard type="model3d" explicitName="超长作品名称用于验证省略显示与全文可读性的一整句中文标题" note="长名称省略、title 可读全文" />
      <NameCard type="group" explicitName="场景组" note="分组名称" />
    </div>
  </div>
);
Naming.storyName = "名称层级";

export const NamingNarrow: Story = () => (
  <div className="showcase__stage">
    <div className="showcase__caption">
      <code>resolveNodeDisplayName</code> · 390px 窄屏
    </div>
    <div className="showcase__frame showcase__frame--narrow">
      <div className="showcase__name-grid showcase__name-grid--narrow">
        <NameCard type="image" explicitName="海边日落与超长名称的窄屏省略验证" note="窄屏省略" />
        <NameCard type="video" prompt="开场镜头" note="提示词摘要" />
      </div>
    </div>
  </div>
);
NamingNarrow.storyName = "窄屏 390";
