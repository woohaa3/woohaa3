/**
 * 画布菜单 section/order 公共契约
 * （change: 2026-10-10-add-game-furnace-extension，任务 2.3 / design D1）。
 *
 * 「基础素材 / 创作工具 / 其他操作」是菜单 **section identity**。菜单贡献者只声明 section 与
 * 组内 order；宿主合并后统一规范化顺序与分隔线，不依赖插件注册先后偶然排出顺序，也不允许
 * 空 section 或重复分割线。这里只做纯计算，不读写 DOM / store，浏览器与插件共用。
 */
export const CANVAS_MENU_SECTION = {
  basicMaterial: "basic-material",
  creationTools: "creation-tools",
  other: "other"
} as const;

export type CanvasMenuSection = (typeof CANVAS_MENU_SECTION)[keyof typeof CANVAS_MENU_SECTION];

/** section 展示顺序；未声明 section 的项归入 `other`。 */
export const CANVAS_MENU_SECTION_ORDER: readonly CanvasMenuSection[] = [
  CANVAS_MENU_SECTION.basicMaterial,
  CANVAS_MENU_SECTION.creationTools,
  CANVAS_MENU_SECTION.other
];

export type CanvasMenuItemSpec = {
  id: string;
  label: string;
  section?: string;
  /** section 内顺序；未声明时保持贡献顺序。 */
  order?: number;
  disabled?: boolean;
  danger?: boolean;
  /** 贡献者显式声明的分隔线（规范化时保留）。 */
  separatorBefore?: boolean;
};

function sectionIndex(section: string | undefined): number {
  const normalized = section ?? CANVAS_MENU_SECTION.other;
  const index = CANVAS_MENU_SECTION_ORDER.indexOf(normalized as CanvasMenuSection);
  return index < 0 ? CANVAS_MENU_SECTION_ORDER.length : index;
}

/**
 * 规范化菜单项：按 section 顺序、组内 order、稳定原序排序，并在**实际存在的 section 边界**
 * 插入分隔线。空 section 不产生分割线；首项不产生前置分割线。
 */
export function normalizeCanvasMenuSections<T extends CanvasMenuItemSpec>(items: readonly T[]): T[] {
  const decorated = items.map((item, index) => ({ item, index, section: sectionIndex(item.section) }));
  decorated.sort((a, b) => {
    if (a.section !== b.section) return a.section - b.section;
    const orderA = a.item.order ?? Number.POSITIVE_INFINITY;
    const orderB = b.item.order ?? Number.POSITIVE_INFINITY;
    if (orderA !== orderB) return orderA - orderB;
    return a.index - b.index;
  });
  const result: T[] = [];
  for (let i = 0; i < decorated.length; i += 1) {
    const current = decorated[i]!;
    const previous = decorated[i - 1];
    const boundary = previous ? previous.section !== current.section : false;
    const separatorBefore = boundary || current.item.separatorBefore === true;
    result.push(separatorBefore ? { ...current.item, separatorBefore: true } : { ...current.item });
  }
  return result;
}
