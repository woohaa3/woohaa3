/**
 * 从 Supabase 读模板目录（`biz_tasks.tasks_template`）。
 *
 * 为什么读表而不是只调 `/tasks/describe`：表里有**运营信息**，而 describe 只回答
 * 「这个模板要什么参数」——
 *
 * | 列 | 用途 |
 * | --- | --- |
 * | `id` | 模板 UUID，就是 ppserver 要的 `templateId` |
 * | `name_zhcn` / `name_en` | 模型选择器里的名字 |
 * | `category` | 决定是图片还是视频（`image` / `image-g` / `image-s` 是图片，其余是视频） |
 * | `cost_coins` | **价格**，下单前给用户看 |
 * | `is_active` | 停用的模板不进目录 |
 * | `display_meta` | 图标、成功率等展示字段；`cost_coins` 独立列优先 |
 * | `tenant_id` | 按租户筛选 |
 *
 * 这与 PS 插件（`sdpppx-services/src/templates.ts`）读的是同一张表、同一组列，
 * 所以两边的模型列表永远一致。
 *
 * **鉴权**：Supabase 的 REST 接口要两个头 —— `apikey`（项目 anon key，公开）与
 * `Authorization`（用户 JWT）。只带前者时 RLS 会把它当成匿名请求，返回空数组而不是报错
 * （踩过：看起来像「没有模板」，其实是没登录）。所以这里把「空结果是匿名」和
 * 「真的没有模板」分开报。
 */
import type { PpserverKind, PpserverTemplate } from "./discovery.js";

const DEFAULT_SCHEMA = "biz_tasks";
const DEFAULT_TABLE = "tasks_template";
const REQUEST_TIMEOUT_MS = 15_000;
/** 一次刷新最多取多少条，避免大租户把整个目录拉下来。 */
const MAX_ROWS = 200;

const SELECT_COLUMNS = "id,tenant_id,name_zhcn,name_en,category,cost_coins,is_active,display_meta,updated_at";

export type CatalogRow = {
  id: string;
  name_zhcn?: string | null;
  name_en?: string | null;
  category?: string | null;
  cost_coins?: number | null;
  display_meta?: Record<string, unknown> | null;
};

export type CatalogResult =
  | { ok: true; templates: PpserverTemplate[]; message?: string }
  | { ok: false; message: string };

/**
 * 分类 → 模型类型。
 *
 * 线上分类是**带后缀的族**，不是几个固定值。2026-10-30 从 `tasks_template` 实际取到的全集：
 *
 * ```
 * image / image-2 / image-21 / image-g / image-g25 / image-k / image-s / image-y / image-z
 * video-h / video-h3 / video-k / video-m / video-s / video-s25 / video-v / video-w
 * ```
 *
 * 所以按**前缀**判断，不能照 PS 插件 UI 那样只认 `image` / `image-g` / `image-s` 三个精确值 ——
 * 那样 `image-21`、`image-g25` 会被误判成视频，模型跑进错误的面板（踩过）。
 *
 * 既不是 `image` 也不是 `video` 开头的按图片处理：丢掉会让用户在界面上找不到刚上线的模板，
 * 而放错面板的错误比分类不准更轻微。
 */
export function templateKindFromCategory(category: string | null | undefined): PpserverKind {
  const value = (category ?? "").trim().toLowerCase();
  if (value.startsWith("video")) return "video";
  return "image";
}

export function normalizeCatalogRow(row: unknown): PpserverTemplate | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const record = row as Record<string, unknown>;
  const templateId = typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
  if (!templateId) return undefined;

  const zh = typeof record.name_zhcn === "string" ? record.name_zhcn.trim() : "";
  const en = typeof record.name_en === "string" ? record.name_en.trim() : "";
  const displayMeta = record.display_meta && typeof record.display_meta === "object" && !Array.isArray(record.display_meta)
    ? (record.display_meta as Record<string, unknown>)
    : undefined;

  // `cost_coins` 独立列优先，覆盖 display_meta 里的旧值 —— 与 PS 插件一致。
  const columnCost = typeof record.cost_coins === "number" && Number.isFinite(record.cost_coins)
    ? record.cost_coins
    : undefined;
  const metaCost = typeof displayMeta?.cost_coins === "number" && Number.isFinite(displayMeta.cost_coins)
    ? (displayMeta.cost_coins as number)
    : undefined;

  const category = typeof record.category === "string" ? record.category.trim() : "";

  return {
    modelId: templateId,
    templateId,
    kind: templateKindFromCategory(category),
    title: zh || en || templateId,
    ...(category ? { category } : {}),
    ...(columnCost ?? metaCost) !== undefined ? { cost: (columnCost ?? metaCost) as number } : {},
    ...(displayMeta ? { displayMeta } : {})
  };
}

/**
 * 读目录。
 *
 * `tenantId` 只影响筛选条件，不影响授权 —— 授权始终由 JWT 决定（RLS）。
 * 空数组时给一句能区分原因的话：没配令牌 / 令牌被 RLS 过滤 / 租户下确实没有。
 */
export async function fetchTemplateCatalog(options: {
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
  tenantId?: string;
  schema?: string;
  table?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<CatalogResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = options.supabaseUrl.trim().replace(/\/+$/, "");
  if (!base) return { ok: false, message: "没有配置 Supabase 地址，无法读取模板目录" };
  if (!options.anonKey.trim()) return { ok: false, message: "没有配置 Supabase anon key" };
  if (!options.accessToken.trim()) return { ok: false, message: "没有配置访问令牌，读取模板目录需要用户 JWT" };

  const url = new URL(`${base}/rest/v1/${options.table ?? DEFAULT_TABLE}`);
  url.searchParams.set("select", SELECT_COLUMNS);
  url.searchParams.set("is_active", "eq.true");
  url.searchParams.set("order", "updated_at.desc");
  url.searchParams.set("limit", String(MAX_ROWS));
  if (options.tenantId) url.searchParams.set("tenant_id", `eq.${options.tenantId}`);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        apikey: options.anonKey,
        // **两个头都要**：只有 apikey 时 RLS 按匿名处理，回空数组。
        authorization: `Bearer ${options.accessToken}`,
        accept: "application/json",
        // 表在非 public schema，必须声明。
        "accept-profile": options.schema ?? DEFAULT_SCHEMA,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `读取模板目录被拒绝（HTTP ${response.status}）：令牌无效或已过期` };
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      return { ok: false, message: `读取模板目录失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}` };
    }

    const rows = (await response.json()) as unknown;
    if (!Array.isArray(rows)) return { ok: false, message: "模板目录返回的不是数组" };

    const templates = rows
      .map(normalizeCatalogRow)
      .filter((entry): entry is PpserverTemplate => entry !== undefined);

    if (templates.length === 0) {
      return {
        ok: false,
        message: options.tenantId
          ? `租户 ${options.tenantId.slice(0, 8)}… 下没有启用的模板（也可能是令牌被行级权限过滤）`
          : "没有启用的模板（也可能是令牌被行级权限过滤）",
      };
    }
    return { ok: true, templates };
  } catch (error) {
    return {
      ok: false,
      message: `读取模板目录失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: unknown; hint?: unknown };
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    return message.slice(0, 200);
  } catch {
    return "";
  }
}
