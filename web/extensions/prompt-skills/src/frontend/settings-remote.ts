/**
 * 插件设置页的数据出口。
 *
 * 模型列表来自宿主的任务目录（`GET /api/pptask/catalog`），当前模型与 revision 来自扩展自己的
 * `GET /api/prompt-skills/config`；保存用带 CAS 的 `POST /api/prompt-skills/config`。
 * 扩展不直接 fetch、不接触控制面管理权限，也不把模型塞进执行请求。
 */
import type { ApplicationRemoteTransport } from "@woohaa3/frontend/extension-api";
import {
  PROMPT_SKILLS_PUBLIC_BASE_PATH,
  type PromptSkillConfigResponse
} from "../shared.js";

export type PromptSkillsModelOption = { id: string; label: string };

export type PromptSkillsSettingsSnapshot = {
  models: PromptSkillsModelOption[];
  /** 当前配置的模型；空串表示尚未配置。 */
  model: string;
  /** 配置文档 revision；保存时作为 CAS 前置条件，`null` 表示尚未写入。 */
  revision: number | null;
};

export type PromptSkillsSettingsRemote = {
  load(): Promise<{ ok: true; snapshot: PromptSkillsSettingsSnapshot } | { ok: false; error: string }>;
  save(input: { model: string; expectedRevision: number | null }): Promise<{ ok: true; revision: number } | { ok: false; error: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModels(data: unknown): PromptSkillsModelOption[] {
  if (!isRecord(data) || !Array.isArray(data.models)) return [];
  const seen = new Set<string>();
  const models: PromptSkillsModelOption[] = [];
  for (const entry of data.models) {
    if (!isRecord(entry) || entry.modelType !== "language") continue;
    const id = entry.modelKey;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    const title = typeof entry.title === "string" && entry.title.trim() !== "" ? entry.title : id;
    models.push({ id, label: title });
  }
  return models.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function readConfig(data: unknown): PromptSkillConfigResponse | null {
  if (!isRecord(data)) return null;
  if (data.ok === true && typeof data.model === "string"
      && (typeof data.revision === "number" || data.revision === null)) {
    return { ok: true, model: data.model, revision: data.revision };
  }
  if (data.ok === false && typeof data.error === "string") return { ok: false, error: data.error };
  return null;
}

/** 传输层把 409 映射成 conflict；优先透出服务端的可操作中文消息。 */
function readTransportError(result: { error: string; body?: unknown }): string {
  if (isRecord(result.body) && typeof result.body.error === "string" && result.body.error.trim() !== "") {
    return result.body.error;
  }
  return result.error.trim() !== "" ? result.error : "保存失败";
}

export function createPromptSkillsSettingsRemote(options: {
  transport: ApplicationRemoteTransport;
  basePath?: string;
}): PromptSkillsSettingsRemote {
  const basePath = (options.basePath ?? PROMPT_SKILLS_PUBLIC_BASE_PATH).replace(/\/$/, "");

  return {
    async load() {
      const [catalog, config] = await Promise.all([
        options.transport.request({ path: "/api/pptask/catalog", method: "GET" }),
        options.transport.request({ path: `${basePath}/config`, method: "GET" })
      ]);
      if (!catalog.ok) return { ok: false, error: catalog.error.trim() !== "" ? catalog.error : "无法读取模型目录" };
      if (!config.ok) return { ok: false, error: config.error.trim() !== "" ? config.error : "无法读取插件配置" };
      const decoded = readConfig(config.data);
      if (decoded === null) return { ok: false, error: "插件配置响应无法识别" };
      if (!decoded.ok) return { ok: false, error: decoded.error };
      return {
        ok: true,
        snapshot: {
          models: readModels(catalog.data),
          model: decoded.model.trim(),
          revision: decoded.revision
        }
      };
    },

    async save(input) {
      const response = await options.transport.request({
        path: `${basePath}/config`,
        method: "POST",
        body: { model: input.model, expectedRevision: input.expectedRevision }
      });
      if (response.ok) {
        const decoded = readConfig(response.data);
        if (decoded === null) return { ok: false, error: "保存响应无法识别" };
        if (!decoded.ok) return { ok: false, error: decoded.error };
        if (decoded.revision === null) return { ok: false, error: "保存响应缺少 revision" };
        return { ok: true, revision: decoded.revision };
      }
      return { ok: false, error: readTransportError(response) };
    }
  };
}
