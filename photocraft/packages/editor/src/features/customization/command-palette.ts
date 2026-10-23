/**
 * 命令搜索索引（U78）
 * （change: 2026-10-22-add-photocraft-workspace-customization，design D1/D2）。
 *
 * 搜索只索引**运行时已接通**的动作：内核命令表里 `allowed` 的记录。未开放命令既不显示也不执行；
 * 执行仍走调用方的同一命令门，搜索本身不是第二条写入口。
 *
 * 显示名优先用界面菜单的中文标签：内核命令表自报的是英文（`Undo`/`Redo`），直接拿来做标题会
 * 让中文用户「撤销」搜不到、结果里也全是英文。英文标签仍然保留为关键字，两种输入都能命中。
 *
 * 条目类型保留 `preference` 只是为了让调用方区分「本域纯界面动作」与内核命令（当前搜索结果全部
 * 来自命令表，因此实际只产生 `command` 条目）；新增偏好类动作时复用同一排序与最近使用逻辑。
 */
import type { PhotocraftCommand } from "@woohaa3/photocraft-protocol";

export type PaletteEntryKind = "command" | "preference";
export type PaletteEntry = {
  id: string;
  label: string;
  /** 命令的分组路径（内核自报 `menu`），便于同名命令区分。 */
  menu: string;
  kind: PaletteEntryKind;
  enabled: boolean;
  reason: string | null;
  shortcut: string | null;
  keywords: readonly string[];
};

export type PaletteHit = PaletteEntry & { score: number };

/** 大小写不敏感的子序列匹配；连续命中和词首命中得分更高（沿用固定上游算法的评分口径）。 */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const target = [...text.toLowerCase()];
  let score = 0;
  let index = 0;
  let last = -2;
  for (const character of query.toLowerCase()) {
    let found = false;
    while (index < target.length) {
      if (target[index] === character) {
        score += index === last + 1 ? 8 : 1;
        if (index === 0 || target[index - 1] === " " || target[index - 1] === "·") score += 5;
        last = index;
        index += 1;
        found = true;
        break;
      }
      index += 1;
    }
    if (!found) return null;
  }
  return score - Math.floor(target.length / 8);
}

/** 名称与查询完全一致（忽略省略号）时优先，避免「保存」排在「另存为」之后。 */
function exactBonus(query: string, names: readonly string[]): number {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return 0;
  return names.some((name) => name.replace(/…$/, "").trim().toLowerCase() === trimmed) ? 1000 : 0;
}

/**
 * 命令表 → 搜索条目。
 *
 * `allowed === false` 的记录直接丢弃：它们尚未接通，不能靠搜索绕过命令门。
 *
 * `labelFor` 让调用方把内核自报的英文名换成界面菜单的中文标签（命令 id 是两边的共同键）。
 * `shortcutFor` 让调用方用**当前生效**的组合替换内核自报的出厂提示（自定义键位后搜索里仍显示
 * 出厂组合会误导用户）；返回 `null` 表示该动作已被解绑，此时不显示提示。
 */
export function paletteEntries(
  commands: ReadonlyMap<string, PhotocraftCommand>,
  options: {
    shortcutFor?: (id: string, fallback: string | null) => string | null;
    labelFor?: (id: string, fallback: string) => string;
  } = {}
): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const command of commands.values()) {
    if (!command.allowed) continue;
    const fallback = command.shortcut ?? null;
    const label = options.labelFor ? options.labelFor(command.id, command.label) : command.label;
    // 内核自报的英文名保留为关键字，中文标签与英文输入都能命中同一条命令。
    const keywords = [...(command.keywords ?? [])];
    if (label !== command.label) keywords.push(command.label);
    entries.push({
      id: command.id,
      label,
      menu: command.menu.join(" ▸ "),
      kind: "command",
      enabled: command.enabled,
      reason: command.disabledReason,
      shortcut: options.shortcutFor ? options.shortcutFor(command.id, fallback) : fallback,
      keywords
    });
  }
  return entries;
}

export type SearchOptions = {
  /** 最近执行的命令 id（最新在前），空查询时作为默认结果。 */
  recentIds?: readonly string[];
  limit?: number;
};

/**
 * 排序搜索结果。
 *
 * 评分顺序：名称/关键字命中的模糊分 + 完全同名加成 + 最近使用小加权；禁用条目仍然显示，
 * 但排在可用条目之后，并由调用方渲染禁用原因。
 */
export function searchPalette(entries: readonly PaletteEntry[], query: string, options: SearchOptions = {}): PaletteHit[] {
  const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
  const trimmed = query.trim();
  const recent = options.recentIds ?? [];
  const recentIndex = new Map(recent.map((id, index) => [id, index]));
  const hits: PaletteHit[] = [];
  for (const entry of entries) {
    const names = [entry.label, ...entry.keywords];
    let best: number | null = null;
    for (const name of names) {
      const score = fuzzyScore(trimmed, name);
      if (score === null) continue;
      best = best === null ? score : Math.max(best, score);
    }
    if (best === null) continue;
    const idBonus = recentIndex.has(entry.id) ? Math.max(0, 40 - 5 * recentIndex.get(entry.id)!) : 0;
    hits.push({ ...entry, score: best + exactBonus(trimmed, [entry.label]) + idBonus });
  }
  hits.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.label.localeCompare(b.label, "zh-Hans-CN");
  });
  return hits.slice(0, limit);
}

/** 空查询时按最近使用列出（已不可用的命令跳过）；没有记忆时回退到可用命令前若干条。 */
export function defaultPaletteHits(entries: readonly PaletteEntry[], recentIds: readonly string[], limit = 12): PaletteEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const hits: PaletteEntry[] = [];
  for (const id of recentIds) {
    const entry = byId.get(id);
    if (entry) hits.push(entry);
    if (hits.length >= limit) return hits;
  }
  for (const entry of entries) {
    if (hits.length >= limit) break;
    if (!hits.some((hit) => hit.id === entry.id)) hits.push(entry);
  }
  return hits;
}

/** 记忆最近执行：去重、最新在前、有界。 */
export function pushRecent(recent: readonly string[], id: string, cap = 8): string[] {
  return [id, ...recent.filter((entry) => entry !== id)].slice(0, cap);
}
