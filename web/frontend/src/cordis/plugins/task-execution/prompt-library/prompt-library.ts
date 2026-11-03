/**
 * 提示词库的数据面：远端预设 + 本地收藏。
 *
 * 预设来自官网那一份 JSON（与 PS 插件、浏览器插件同源），**由宿主后端代理**：
 * 上游不带 CORS 头，浏览器直连会被拦（见 `backend/src/api/prompt-library-api.ts`）。
 *
 * 收藏只存本地（`localStorage`），与 PS 插件的做法一致 —— 它也是「预设只读、收藏另存」。
 * 收藏键用预设的 `id`，所以收藏是「这条预设我收下了」，不是复制一份新提示词。
 */

const FAVORITES_KEY = "woohaa.prompt-library.favorites.v1";
const BASE_PATH = "/api/prompt-library";

/** 一条提示词。字段与后端 `PromptEntry` 一一对应。 */
export type PromptEntry = {
  id: string;
  title: string;
  text: string;
  category: string;
  tags: string[];
  imageUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type PromptLibrarySnapshot = {
  version: string;
  categories: string[];
  prompts: PromptEntry[];
  fetchedAt: number;
};

export type PromptLibraryResult =
  | { ok: true; snapshot: PromptLibrarySnapshot }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 逐条校验：一条坏数据不该让整个面板空掉（后端已经筛过一遍，这里是第二道）。 */
function decodeEntry(value: unknown): PromptEntry | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const text = typeof value.text === "string" ? value.text : "";
  if (id === "" || text.trim() === "") return null;
  const imageUrl = typeof value.imageUrl === "string" && value.imageUrl.startsWith("data:image/") ? value.imageUrl : "";
  return {
    id,
    title: typeof value.title === "string" && value.title.trim() !== "" ? value.title : text.slice(0, 24),
    text,
    category: typeof value.category === "string" && value.category.trim() !== "" ? value.category : "其他",
    tags: Array.isArray(value.tags) ? value.tags.filter((t): t is string => typeof t === "string") : [],
    ...(imageUrl !== "" ? { imageUrl } : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
}

export function decodeSnapshot(value: unknown): PromptLibrarySnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.prompts)) return null;
  const prompts: PromptEntry[] = [];
  for (const item of value.prompts) {
    const entry = decodeEntry(item);
    if (entry) prompts.push(entry);
  }
  const categories = Array.isArray(value.categories)
    ? value.categories.filter((c): c is string => typeof c === "string" && c.trim() !== "")
    : [];
  return {
    version: typeof value.version === "string" ? value.version : "",
    // 上游的分类表可能与条目对不上；以实际出现过的为准补全，否则筛选会漏分类。
    categories: [...new Set([...categories, ...prompts.map((p) => p.category)])],
    prompts,
    fetchedAt: typeof value.fetchedAt === "number" ? value.fetchedAt : Date.now()
  };
}

export async function fetchPromptLibrary(fetchImpl: typeof globalThis.fetch): Promise<PromptLibraryResult> {
  let response: Response;
  try {
    response = await fetchImpl(BASE_PATH, { credentials: "same-origin" });
  } catch {
    return { ok: false, error: "无法连接提示词库服务" };
  }
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // 后端把上游的根因写进了 `error`（DNS / 403 / 超时）。原样显示，别让用户面对一句「加载失败」。
    const message = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "";
    return { ok: false, error: message || `提示词库加载失败（HTTP ${response.status}）` };
  }
  const snapshot = decodeSnapshot(parsed);
  if (!snapshot) return { ok: false, error: "提示词库返回的数据无法识别" };
  return { ok: true, snapshot };
}

// ---------------------------------------------------------------- 本地收藏

/**
 * 读收藏 id 集合。
 *
 * 存储不可用（隐私模式 / 配额满）时**返回空集而不是抛错**：收藏是便利功能，
 * 不能因为它坏掉就打不开面板。
 */
export function readFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/** 写收藏；失败返回 false（调用方据此提示，但不回滚界面上的心形）。 */
export function writeFavorites(ids: ReadonlySet<string>): boolean {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...ids]));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把提示词写进草稿。
 *
 * 草稿非空时**追加在换行之后**，不覆盖用户已经写的内容 —— 点一下「使用」就清掉
 * 自己刚打的半句话，是最容易让人骂人的那种交互。
 */
export function mergePromptText(current: string, incoming: string): string {
  const base = current.trimEnd();
  const addition = incoming.trim();
  if (addition === "") return current;
  return base === "" ? addition : `${base}\n${addition}`;
}

// ---------------------------------------------------------------- 过滤

/**
 * 按关键词与分类筛提示词。
 *
 * 关键词同时匹配标题、正文与标签 —— 用户记得住的往往是正文里的一句话，
 * 只搜标题会让「3D操作轴测图」这类条目看起来搜不到。
 */
export function filterPrompts(
  prompts: readonly PromptEntry[],
  options: { keyword?: string; category?: string } = {}
): PromptEntry[] {
  const keyword = (options.keyword ?? "").trim().toLowerCase();
  const category = options.category ?? "";
  return prompts.filter((entry) => {
    if (category !== "" && entry.category !== category) return false;
    if (keyword === "") return true;
    return (
      entry.title.toLowerCase().includes(keyword) ||
      entry.text.toLowerCase().includes(keyword) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(keyword))
    );
  });
}
