/**
 * 租户模板 → 生成模型目录。
 *
 * 数据源与 sdppp demo 的 `createSupabaseTemplateFetcher` 同源：Supabase REST 的
 * `biz_tasks.tasks_template`，按租户与 `is_active` 过滤，`updated_at` 倒序。
 * 模型身份固定为 `providerModelId = templateId`；标题取中文名，缺失回退英文名与 id。
 */
import type { SdpppxModelType } from "../shared.js";
import type { SdpppxConfig } from "./config.js";
import type { SdpppxHttpOptions } from "./http.js";
import { requireSupabase, rowsOf, supabaseJson } from "./supabase.js";

export type SdpppxTemplate = {
  templateId: string;
  title: string;
  modelType: SdpppxModelType;
};

export type CatalogInput = {
  config: SdpppxConfig;
  accessToken: string;
} & SdpppxHttpOptions;

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function templateFromRow(
  row: Record<string, unknown>,
  modelTypes: Record<string, SdpppxModelType>
): SdpppxTemplate | null {
  const templateId = textOf(row.id);
  if (!templateId) return null;
  const title = textOf(row.name_zhcn) ?? textOf(row.name_en) ?? templateId;
  const modelType = modelTypes[templateId] === "video" ? "video" : "image";
  return { templateId, title, modelType };
}

export async function fetchSdpppxCatalog(input: CatalogInput): Promise<SdpppxTemplate[]> {
  const base = requireSupabase(input.config);
  const query =
    `tasks_template?tenant_id=eq.${encodeURIComponent(base.tenantId)}` +
    `&is_active=eq.true` +
    `&select=id,tenant_id,name_zhcn,name_en,is_active,updated_at` +
    `&order=updated_at.desc`;
  const payload = await supabaseJson(base, `/rest/v1/${query}`, {
    ...input,
    accessToken: input.accessToken,
    profile: "biz_tasks"
  });
  const templates: SdpppxTemplate[] = [];
  for (const row of rowsOf(payload)) {
    if (row.is_active === false) continue;
    const template = templateFromRow(row, input.config.templateModelTypes);
    if (template) templates.push(template);
  }
  return templates;
}
