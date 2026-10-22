/**
 * Panel fullscreen 宿主
 * （change: 2026-09-28-align-execution-reference-and-expansion，task 4.3 / design D5）。
 *
 * expanded 执行面板由宿主（Canvas Shell / Showcase）用它包一层 fullscreen 容器；它**不是**
 * Dialog：不进入 modal stack、不声明 `role="dialog"`/`aria-modal`，只提供稳定容器与可访问名称。
 * 背后的输入隔离由 Canvas Shell 的 input scope 负责。
 */
import type { ReactNode } from "react";

export type FullscreenPanelHostProps = {
  children: ReactNode;
  ariaLabel: string;
  className?: string;
};

export function FullscreenPanelHost({ children, ariaLabel, className }: FullscreenPanelHostProps) {
  return (
    <div className="fullscreen-panel-host" data-presentation="expanded" role="region" aria-label={ariaLabel}>
      <div className={`fullscreen-panel-host__panel${className ? ` ${className}` : ""}`}>{children}</div>
    </div>
  );
}
