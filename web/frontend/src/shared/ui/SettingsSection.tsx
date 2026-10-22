/** 设置表面的纯展示组件；数据、请求和状态文案由调用方持有。 */
import type { ReactNode } from "react";
import "./settings-section.css";

export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div>
          <h3>{title}</h3>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function SettingsFeedback({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "danger" | "warning";
  children: ReactNode;
}) {
  return (
    <div className="settings-section__feedback" data-tone={tone}>
      {children}
    </div>
  );
}
