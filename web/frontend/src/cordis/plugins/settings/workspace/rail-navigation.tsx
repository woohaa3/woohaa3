/**
 * 设置弹窗左栏的三级形态：分区导航 → 插件列表 → 插件子页。
 *
 * 交互模型（画布设置-扩展层级导航，2026-10-28）：左栏永远是右栏内容的父级。
 * - L1：设置分区（核心服务 / 插件配置 / …），右栏是该分区的正文；
 * - L2：进入某个插件后，左栏换成插件列表（就是一级页那份列表的紧凑形态），右栏是插件概览；
 * - L3：从概览进入子页后，左栏换成该插件的子页导航（概览 / 配置 / 模型 / 管理），
 *   子页之间切换只换右栏，不再整体平移。
 *
 * 左栏在插件层级加宽到 224px（分区层级仍是 200px），只放扫描所需的最小信息：
 * 图标、名称、真实状态点；说明与操作留在右栏。
 */
import { useState, type ReactNode } from "react";
import { PluginIconMark } from "../plugin-icons.js";
import type { PluginViewIndex } from "../plugin-groups.js";
import { pluginMatchesQuery, pluginRowStatus, sectionizePluginGroups } from "../plugin-browser.js";
import type { PluginPageDescriptor, PluginPageId } from "../plugin-pages.js";
import {
  BackIcon,
  ChevronRightIcon,
  ConfigIcon,
  LayoutGridIcon,
  SearchIcon,
  SparklesIcon,
  ToolsIcon
} from "@woohaa3/ui/icons";

export type SettingsSectionNavEntry = { id: string; label: string; icon: ReactNode };

/** L1：设置分区导航（固定左栏）。 */
export function SectionRailNav({
  entries,
  activeId,
  pluginCount,
  onSelect
}: {
  entries: readonly SettingsSectionNavEntry[];
  activeId: string;
  pluginCount?: number | null;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="settings-workbench__nav" aria-label="设置分区">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={entry.id === activeId ? "settings-workbench__nav-item is-active" : "settings-workbench__nav-item"}
          onClick={() => onSelect(entry.id)}
          data-testid={`settings-nav-${entry.id}`}
        >
          {entry.icon}
          <span>{entry.label}</span>
          {entry.id === "plugins" && pluginCount !== null && pluginCount !== undefined ? (
            <span className="settings-workbench__nav-count">{pluginCount}</span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}

/**
 * L2：插件列表（父级）。
 *
 * 与一级页同一份索引与状态推导，只做紧凑呈现；搜索在这里也保留，插件变多时不用先退回一级页。
 * 点当前项不重复导航（`onSelect` 由工作区把「同一插件」判为无操作）。
 */
export function PluginListRail({
  index,
  activeId,
  onSelect,
  onBack
}: {
  index: PluginViewIndex;
  activeId?: string;
  onSelect: (pluginId: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const sections = sectionizePluginGroups(index.groups.filter((group) => pluginMatchesQuery(group, normalized)));
  return (
    <div className="settings-rail__level-body">
      <button type="button" className="settings-rail__back" onClick={onBack} data-testid="plugin-rail-back">
        <BackIcon size={14} />
        <span>插件配置</span>
      </button>
      <label className="settings-rail__search">
        <SearchIcon size={13} />
        <input
          type="search"
          value={query}
          placeholder="搜索插件"
          aria-label="搜索插件"
          onChange={(event) => setQuery(event.currentTarget.value)}
          data-testid="plugin-rail-search"
        />
      </label>
      <nav className="settings-rail__list" aria-label="插件列表" data-testid="plugin-rail-list">
        {sections.map((section) => (
          <div className="settings-rail__group" key={section.title}>
            <span className="settings-rail__group-title">{section.title}</span>
            {section.groups.map((group) => {
              const status = pluginRowStatus(index, group);
              const active = group.id === activeId;
              return (
                <button
                  key={group.id}
                  type="button"
                  className={active ? "settings-rail__item is-active" : "settings-rail__item"}
                  onClick={() => onSelect(group.id)}
                  title={`${group.label} · ${status.label}`}
                  data-plugin-layer={group.layer}
                  data-testid={`plugin-rail-${group.id}`}
                >
                  <PluginIconMark icon={group.icon} size={16} testId={`plugin-rail-icon-${group.id}`} />
                  <span className="settings-rail__item-label">{group.label}</span>
                  <span className="settings-rail__item-dot" data-tone={status.tone} title={status.label} />
                </button>
              );
            })}
          </div>
        ))}
        {sections.length === 0 ? <p className="settings-rail__empty">没有匹配的插件</p> : null}
      </nav>
    </div>
  );
}

const PAGE_ICONS: Record<PluginPageId, ReactNode> = {
  overview: <LayoutGridIcon size={16} />,
  config: <ConfigIcon size={16} />,
  models: <SparklesIcon size={16} />,
  manage: <ToolsIcon size={16} />
};

/**
 * L3：插件子页导航。
 *
 * 顶部的返回回插件列表（L2），不是关闭设置；子页之间只是同级切换。
 * 层级说明用插件自己的层（内置 / 扩展 / 站点），避免与左栏列表的标签重复。
 */
export function PluginPageRail({
  pluginId,
  label,
  pages,
  activeId,
  onSelect,
  onBack
}: {
  pluginId: string;
  label: string;
  pages: readonly PluginPageDescriptor[];
  activeId: PluginPageId;
  onSelect: (page: PluginPageId) => void;
  onBack: () => void;
}) {
  return (
    <div className="settings-rail__level-body">
      <button type="button" className="settings-rail__back" onClick={onBack} data-testid="plugin-page-back">
        <BackIcon size={14} />
        <span className="settings-rail__back-label">{label}</span>
      </button>
      <nav className="settings-workbench__nav" aria-label={`${label} 的设置页`} data-testid={`plugin-page-nav-${pluginId}`}>
        {pages.map((page) => {
          const active = page.id === activeId;
          return (
            <button
              key={page.id}
              type="button"
              className={active ? "settings-workbench__nav-item is-active" : "settings-workbench__nav-item"}
              onClick={() => onSelect(page.id)}
              data-testid={`plugin-page-${page.id}`}
            >
              {PAGE_ICONS[page.id]}
              <span>{page.label}</span>
              {page.count !== undefined ? <span className="settings-workbench__nav-count">{page.count}</span> : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/** 概览页的「进入下一级」入口行（对应设计稿里的 权限 / 高级配置 卡片）。 */
export function PluginPageEntry({
  page,
  onOpen
}: {
  page: PluginPageDescriptor;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="plugin-entry" onClick={onOpen} data-testid={`plugin-entry-${page.id}`}>
      <span className="plugin-entry__icon">{PAGE_ICONS[page.id]}</span>
      <span className="plugin-entry__main">
        <span className="plugin-entry__title">
          {page.label}
          {page.count !== undefined ? <span className="plugin-entry__count">{page.count}</span> : null}
        </span>
        <span className="plugin-entry__hint">{page.hint}</span>
      </span>
      <ChevronRightIcon size={15} className="plugin-entry__chevron" />
    </button>
  );
}
