/**
 * Showcase 自有壳层的导航契约
 * （change: 2026-09-29-refresh-showcase-shell，design D8）。
 *
 * Ladle 继续负责 story 发现 / 构建 / `mode=preview` 下渲染单个 story；侧栏导航由
 * `web/ui/showcase` 自己渲染。这里只定义与 Ladle 无关的稳定类型，导航数据来自 Ladle 的
 * `/meta.json`（dev 与 build 都有），story 切换经 Ladle 官方 `useLink()`。
 */
import { STORY_ORDER } from "./story-order.mjs";

export type StoryMetaEntry = {
  /** Ladle story id（`title--storyName`）。 */
  id: string;
  /** 叶子显示名（Ladle `meta.name`）。 */
  name: string;
  /** 分组层级（Ladle `meta.levels`；已含根分组）。 */
  levels: string[];
};

export type StoryTreeNode = {
  /** 稳定 id：叶子为 story id，分组为 `group:<路径>`。 */
  id: string;
  name: string;
  /** 叶子为 story id；分组为 null。 */
  storyId: string | null;
  children: StoryTreeNode[];
};

/** `/meta.json` 的最小形状（忽略 loc/source 等无关字段）。 */
type MetaJson = {
  stories?: Record<string, { name?: unknown; levels?: unknown } | undefined>;
};

/**
 * 按 Showcase 排序表给 story id 排序（与 Ladle `storyOrder` 同语义：前缀通配）。
 *
 * 同一前缀内的 id 按字母序排列，保证不依赖 `/meta.json` 的键顺序。
 * 与 Ladle 的差别：未被任何 `前缀*` 命中的 story **保留在末尾**，而不是被丢弃，
 * 因此新增 story 不会从侧栏消失。
 */
export function orderStoryIds(
  ids: readonly string[],
  order: readonly string[] = STORY_ORDER
): string[] {
  const remaining = new Set(ids);
  const byName = (a: string, b: string) => a.localeCompare(b);
  const ordered: string[] = [];
  for (const pattern of order) {
    const prefix = pattern.split("*")[0] ?? pattern;
    const matched = [...remaining].filter((id) => id.startsWith(prefix)).sort(byName);
    for (const id of matched) {
      ordered.push(id);
      remaining.delete(id);
    }
  }
  return [...ordered, ...[...remaining].sort(byName)];
}

/** 把 Ladle `/meta.json` 解析成稳定、已排序的 story 条目列表；非法输入返回空数组。 */
export function parseStoryMeta(json: unknown): StoryMetaEntry[] {
  const stories = (json as MetaJson | null)?.stories;
  if (!stories || typeof stories !== "object") return [];
  const byId = new Map<string, StoryMetaEntry>();
  for (const [id, value] of Object.entries(stories)) {
    if (!value || typeof value !== "object") continue;
    const name = typeof value.name === "string" ? value.name : id;
    const levels =
      Array.isArray(value.levels) && value.levels.every((level) => typeof level === "string")
        ? (value.levels as string[])
        : id.split("--");
    byId.set(id, { id, name, levels });
  }
  return orderStoryIds([...byId.keys()]).map((id) => byId.get(id)!);
}

/**
 * 把（已排序的）story 条目构造成导航树；分组与叶子顺序沿用 `entries` 顺序。
 *
 * Ladle 的 `levels` 是 story **title** 的层级（全是分组），叶子显示名是 `name`。
 * 因此先按下 `levels` 建分组，再把 `name` 作为叶子挂在最深一层下面。
 */
export function buildStoryTree(entries: readonly StoryMetaEntry[]): StoryTreeNode[] {
  const roots: StoryTreeNode[] = [];
  const index = new Map<string, StoryTreeNode>();

  const ensureGroup = (container: StoryTreeNode[], path: string[], name: string): StoryTreeNode[] => {
    const fullPath = [...path, name].join("/");
    const nodeId = `group:${fullPath}`;
    let node = index.get(nodeId);
    if (!node) {
      node = { id: nodeId, name, storyId: null, children: [] };
      index.set(nodeId, node);
      container.push(node);
    }
    return node.children;
  };

  for (const entry of entries) {
    const levels = entry.levels.length > 0 ? entry.levels : ["未分组"];
    let container = roots;
    const path: string[] = [];
    for (const level of levels) {
      container = ensureGroup(container, path, level);
      path.push(level);
    }
    container.push({ id: entry.id, name: entry.name, storyId: entry.id, children: [] });
  }

  return roots;
}

/** 从任意 URL（含 `?story=`）解析当前 story id；缺省返回 null。 */
export function storyFromSearch(search: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const part of query.split("&")) {
    const [rawKey, ...rest] = part.split("=");
    if (rawKey !== "story") continue;
    const rawValue = rest.join("=");
    try {
      const decoded = decodeURIComponent(rawValue.replace(/\+/g, " "));
      if (decoded) return decoded;
    } catch {
      return null;
    }
  }
  return null;
}
