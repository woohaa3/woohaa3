/**
 * 设置弹窗的面包屑：设置 / 插件配置 / 插件名 / 子页。
 *
 * 层级导航（2026-10-28）：左栏是右栏的父级，点击面包屑可以直接跨级回跳（没有中间帧）；
 * 最后一段是当前页，不可点。一级分区不显示面包屑——那里已经有页面标题。
 */
import { ChevronRightIcon } from "@woohaa3/ui/icons";

export type SettingsCrumb = {
  label: string;
  /** 省略表示当前页（不可点）。 */
  onClick?: () => void;
};

export function SettingsBreadcrumb({ crumbs, testId }: { crumbs: readonly SettingsCrumb[]; testId?: string }) {
  return (
    <nav className="settings-crumbs" aria-label="位置" {...(testId ? { "data-testid": testId } : {})}>
      {crumbs.map((crumb, position) => {
        const last = position === crumbs.length - 1;
        return (
          <span className="settings-crumbs__item" key={`${position}:${crumb.label}`}>
            {position > 0 ? <ChevronRightIcon size={12} className="settings-crumbs__sep" /> : null}
            {crumb.onClick && !last ? (
              <button type="button" className="settings-crumbs__link" onClick={crumb.onClick} data-testid={`settings-crumb-${position}`}>
                {crumb.label}
              </button>
            ) : (
              <span className={last ? "settings-crumbs__current" : "settings-crumbs__label"} aria-current={last ? "page" : undefined}>
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
