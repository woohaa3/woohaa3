/**
 * 插件详情的三级页签（概览 / 配置 / 模型 / 管理）。
 *
 * 层级导航（2026-10-28 交互设计）：L2 展示插件概览，进入任一子页才发生一次层级平移；
 * 子页之间切换只换右栏，不再整体平移。页签集合按插件实际有什么推导：
 * 没有配置项的插件不出现「配置」，没有模型的插件不出现「模型」，未受管扩展不出现「管理」。
 * 只有一个子页时也不造一个单选项导航——上层只保留 L2。
 */
import { modelsOf, type PluginSettingsGroup, type PluginViewIndex } from "./plugin-groups.js";

export type PluginPageId = "overview" | "config" | "models" | "manage";

export type PluginPageDescriptor = {
  id: PluginPageId;
  label: string;
  /** 右栏或左栏的说明（已带真实数量）。 */
  hint: string;
  /** 徽标数字：配置项数 / 模型数；概览与管理不带。 */
  count?: number;
};

/** 该插件可用的子页（含概览，顺序固定）。 */
export function pluginPages(
  index: PluginViewIndex,
  group: PluginSettingsGroup,
  panelIds: ReadonlySet<string>
): PluginPageDescriptor[] {
  const pages: PluginPageDescriptor[] = [
    { id: "overview", label: "概览", hint: "启停、说明与这个插件的规模。" }
  ];
  const hasPanel = panelIds.has(group.id);
  if (group.entries.length > 0 || hasPanel) {
    pages.push({
      id: "config",
      label: "配置",
      ...(group.entries.length > 0 ? { count: group.entries.length } : {}),
      hint: hasPanel
        ? "扩展自带的设置面板与声明式配置项都在这里，按项保存。"
        : "这个插件声明的配置项，按项保存，写进本机配置文件。"
    });
  }
  const models = modelsOf(index, group);
  if (models.length > 0 || group.modelRefresh) {
    pages.push({
      id: "models",
      label: "模型",
      ...(models.length > 0 ? { count: models.length } : {}),
      hint: "这个插件提供给大家使用的模型；启停是站点级，立即生效。"
    });
  }
  if (group.installed?.managed) {
    pages.push({ id: "manage", label: "管理", hint: "安装来源、签名、版本与卸载 / 回滚。" });
  }
  return pages;
}

/** 目标子页不可用（例如模型页随插件停用消失）时回落到概览，不停在半截视图。 */
export function resolvePluginPage(
  pages: readonly PluginPageDescriptor[],
  wanted: PluginPageId
): PluginPageDescriptor {
  return pages.find((page) => page.id === wanted) ?? pages[0]!;
}

/** 除概览外的子页：概览页把它们渲染成「进入下一级」的入口行。 */
export function pluginSubPages(pages: readonly PluginPageDescriptor[]): PluginPageDescriptor[] {
  return pages.filter((page) => page.id !== "overview");
}
