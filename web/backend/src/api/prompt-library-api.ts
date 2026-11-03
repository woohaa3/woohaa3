/**
 * 提示词库 HTTP 面：`/api/prompt-library`。
 *
 * 只做一件事：把四喜官网上的提示词预设包（PS 插件与浏览器插件共用的那份 JSON）搬进同源接口。
 *
 * **为什么必须由后端代理**：上游 `sixiai.com.cn` 不返回任何 CORS 头（`OPTIONS` 直接 405），
 * 浏览器里的 `fetch` 会被拦；PS 插件跑在 UXP 里不受这条约束，所以它才敢直连。
 * 前端要是照抄那个 `fetch`，表现是一句笼统的「加载失败」，看着像断网。
 *
 * 路由：
 * - `GET /api/prompt-library` → `{ version, categories, prompts, fetchedAt }`
 *
 * 数据是**只读的公开内容**，不做鉴权：和 `GET /api/library` 一样，读不出用户数据。
 * 地址写死在这里，不接受调用方传 URL —— 那等于给本机开了一个任意出站代理。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export const PROMPT_LIBRARY_BASE_PATH = "/api/prompt-library";

/** 上游预设包。与 PS 插件 `prompt-tool/store.ts` 的 `PRESET_FETCH_URL` 是同一个地址。 */
export const PROMPT_LIBRARY_SOURCE_URL = "https://sixiai.com.cn/gonggao/prompts/default-prompts.json";

/** 缓存时长：预设包一天更新一两次，五分钟足够新，也避免每次开面板都下 2 MB。 */
const CACHE_TTL_MS = 5 * 60_000;
/** 上游超时。2 MB 正文，给足时间但不至于把面板卡死。 */
const FETCH_TIMEOUT_MS = 20_000;
/** 正文上限：预设包现在约 2 MB，留出增长余量后仍然挡住畸形响应。 */
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TITLE = 200;
const MAX_TEXT = 20_000;

/** 一条提示词。字段与上游一一对应，只做截断，不改语义。 */
export type PromptEntry = {
  id: string;
  title: string;
  text: string;
  category: string;
  tags: string[];
  /** 缩略图：上游给的是 `data:image/jpeg;base64,…`。 */
  imageUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type PromptLibrarySnapshot = {
  version: string;
  categories: string[];
  prompts: PromptEntry[];
  /** 本次快照的取得时间（毫秒）。面板据此说明「多久之前拉的」。 */
  fetchedAt: number;
};

export type PromptLibraryApiOptions = {
  /** 覆盖上游地址（测试注入本地服务）。 */
  sourceUrl?: string;
  /** 覆盖取数实现（测试注入，不联网）。 */
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  logger?: (event: Record<string, unknown>) => void;
};

export function createPromptLibraryApi(options: PromptLibraryApiOptions = {}) {
  const sourceUrl = options.sourceUrl ?? PROMPT_LIBRARY_SOURCE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  /** 进程内缓存。并发请求共用一个在途 Promise，避免同时开两个面板就下两份 2 MB。 */
  let cache: { at: number; snapshot: PromptLibrarySnapshot } | null = null;
  let inflight: Promise<PromptLibrarySnapshot> | null = null;

  async function load(): Promise<PromptLibrarySnapshot> {
    if (cache && now() - cache.at < CACHE_TTL_MS) return cache.snapshot;
    if (inflight) return inflight;
    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(sourceUrl, {
          signal: controller.signal,
          // 上游响应头已经带 no-store；这里也不让中间层缓存，换版本要立刻能看到。
          headers: { accept: "application/json" }
        });
        if (!response.ok) throw new Error(`上游返回 HTTP ${response.status}`);
        const raw = await readLimited(response);
        const snapshot = parseSnapshot(raw, now());
        cache = { at: now(), snapshot };
        return snapshot;
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== PROMPT_LIBRARY_BASE_PATH && !pathname.startsWith(`${PROMPT_LIBRARY_BASE_PATH}/`)) {
      return false;
    }
    if (pathname !== PROMPT_LIBRARY_BASE_PATH) {
      writeJson(res, 404, { error: "没有这个接口" });
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeJson(res, 405, { error: "方法不允许" });
      return true;
    }
    try {
      const snapshot = await load();
      writeJson(res, 200, snapshot);
    } catch (error) {
      // 根因（DNS / 403 / 超时）原样带上：面板上只剩一句「加载失败」时没法排查。
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.({ event: "prompt-library-fetch-failed", message });
      writeJson(res, 502, { error: `提示词库加载失败：${message}` });
    }
    return true;
  };
}

/**
 * 解析上游响应。
 *
 * 兼容两种形态（PS 插件也是这么判的）：顶层数组，或 `{ prompts: [...] }`。
 * **逐条校验，坏条目跳过**：一条畸形数据不该让整个面板空掉。
 */
export function parseSnapshot(raw: unknown, fetchedAt: number): PromptLibrarySnapshot {
  const container = raw as { prompts?: unknown; categories?: unknown; version?: unknown } | null;
  const list = Array.isArray(raw) ? raw : Array.isArray(container?.prompts) ? container!.prompts : [];
  const prompts: PromptEntry[] = [];
  const seen = new Set<string>();
  for (const item of list as unknown[]) {
    const entry = parseEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    prompts.push(entry);
  }
  const declared = Array.isArray(container?.categories)
    ? (container!.categories as unknown[]).filter((c): c is string => typeof c === "string" && c.trim() !== "")
    : [];
  // 上游 `categories` 与条目里的 `category` 不一定同步；以条目里出现过的为准补全，
  // 否则面板上的分类筛选会漏掉实际存在的分类。
  const categories = [...new Set([...declared, ...prompts.map((p) => p.category)])];
  return {
    version: typeof container?.version === "string" ? container.version : "",
    categories,
    prompts,
    fetchedAt
  };
}

function parseEntry(value: unknown): PromptEntry | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const text = typeof item.text === "string" ? item.text.trim() : "";
  // 正文为空就等于没有这条提示词；标题可以退回正文首行。
  if (id === "" || text === "") return null;
  const title = typeof item.title === "string" && item.title.trim() !== "" ? item.title.trim() : text.slice(0, 24);
  const imageUrl = typeof item.imageUrl === "string" && item.imageUrl.startsWith("data:image/") ? item.imageUrl : "";
  return {
    id,
    title: title.slice(0, MAX_TITLE),
    text: text.slice(0, MAX_TEXT),
    category: typeof item.category === "string" && item.category.trim() !== "" ? item.category.trim() : "其他",
    tags: Array.isArray(item.tags)
      ? (item.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "").slice(0, 20)
      : [],
    ...(imageUrl !== "" ? { imageUrl } : {}),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : ""
  };
}

async function readLimited(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("上游响应过大");
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("上游响应过大");
  return JSON.parse(text);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    // 后端自己已经缓存；再让浏览器缓存一份，切页面回来是瞬开。
    "Cache-Control": status === 200 ? "private, max-age=60" : "no-store"
  });
  res.end(payload);
}
