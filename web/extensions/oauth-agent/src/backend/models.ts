/**
 * 个人账户模型目录
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.4 / design D4）。
 *
 * 使用**本用户** access token 查询账户可用模型，使用服务端返回的 `slug`/`display_name`。
 * 不并入站点共享 catalog；目录可列出不代表当前回合必有权限，实际调用失败必须显示。
 */
import type { ChatGptModelView } from "@woohaa3/contracts";

export const CHATGPT_MODELS_URL = "https://api.openai.com/v1/models";

/**
 * 允许在本应用内选择的模型稳定 allowlist。
 *
 * 账户目录会返回多个 `visibility:list` 的 slug（gpt-6.1-sol / gpt-6-astra / gpt-6-sol /
 * gpt-6-luna / gpt-5.6-* 等），但本应用只开放其中经过验证可用的两个。该集合是静态可信边界，
 * 目录投影与生成请求都据此收窄；用户配置不能扩张。
 */
export const CHATGPT_ALLOWED_MODEL_IDS: readonly string[] = ["gpt-6.1-sol", "gpt-6-astra"];

/** 是否为可用模型（allowlist 判定）。 */
export function isAllowedChatGptModel(id: string): boolean {
  return CHATGPT_ALLOWED_MODEL_IDS.includes(id);
}

export type ChatGptModelsResult =
  | { ok: true; models: ChatGptModelView[] }
  | { ok: false; message: string };

type RawModel = { id?: unknown; slug?: unknown; display_name?: unknown; visibility?: unknown };

/**
 * 过滤 `visibility: list` 与 `CHATGPT_ALLOWED_MODEL_IDS`，优先 `slug`，回落 `id`；
 * 显示名优先 `display_name`。结果按 allowlist 顺序稳定排序（默认模型即首个）。
 *
 * ChatGPT-plan token 的 `/v1/models` 返回 `{ models: [...] }`（参考 demo `src/models.js`）；
 * 标准 OpenAI 形态为 `{ data: [...] }`。两者都接受，避免因载荷形状差异静默得到空目录。
 */
export function parseAccountModels(payload: unknown): ChatGptModelView[] {
  const container = payload as { models?: unknown; data?: unknown } | null;
  const list = Array.isArray(container?.models) ? container!.models : Array.isArray(container?.data) ? container!.data : null;
  if (!list) return [];
  const seen = new Map<string, ChatGptModelView>();
  for (const raw of list as RawModel[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.visibility !== undefined && raw.visibility !== "list") continue;
    const id = typeof raw.slug === "string" && raw.slug !== "" ? raw.slug : typeof raw.id === "string" ? raw.id : "";
    if (id === "" || seen.has(id) || !isAllowedChatGptModel(id)) continue;
    const label = typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : id;
    seen.set(id, { id, label });
  }
  // 按 allowlist 顺序输出，使默认模型（首个）稳定。
  return CHATGPT_ALLOWED_MODEL_IDS.filter((id) => seen.has(id)).map((id) => seen.get(id)!);
}

export function createChatGptModelCatalog(options: {
  fetchImpl?: typeof globalThis.fetch;
  url?: string;
}): {
  list: (accessToken: string) => Promise<ChatGptModelsResult>;
} {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = options.url ?? CHATGPT_MODELS_URL;
  return {
    async list(accessToken) {
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
          signal: AbortSignal.timeout(20_000)
        });
        if (!response.ok) return { ok: false, message: `读取账户模型失败（HTTP ${response.status}）` };
        const payload = (await response.json()) as unknown;
        return { ok: true, models: parseAccountModels(payload) };
      } catch (error) {
        return { ok: false, message: `读取账户模型失败：${error instanceof Error ? error.message : String(error)}` };
      }
    }
  };
}
