/**
 * 改写模型的扩展自有配置存储（change: prompt-skill-config-in-plugin）。
 *
 * 站点插件的后端定义没有 `ctx.settings` 注册面，`site.configSchema` 只是设置页元数据；
 * 通过控制面写进 `woohaa.config.yml` 的扩展值不会被 `host.config.values()` 读到。这里改用
 * 宿主提供的 owner-scoped `documents` 存储：以固定的 `config` 文档保存模型，带 revision
 * 做 CAS，扩展卸载/升级不丢。
 */
import type { ExtensionDocumentStore } from "@woohaa3/contracts";

const CONFIG_KEY = "config";
const MAX_MODEL_CHARS = 200;

export type PromptSkillsConfig = { model: string; revision: number | null };

export type ReadConfigResult =
  | { ok: true; config: PromptSkillsConfig }
  | { ok: false; code: "unavailable"; message: string };

export type WriteConfigResult =
  | { ok: true; revision: number }
  | { ok: false; code: "conflict" | "invalid" | "unavailable"; message: string; currentRevision?: number };

export async function readPromptSkillsConfig(
  store: ExtensionDocumentStore | undefined
): Promise<ReadConfigResult> {
  if (!store) return { ok: false, code: "unavailable", message: "宿主未提供扩展存储，无法读取改写模型" };
  const read = await store.get<{ model?: string }>(CONFIG_KEY);
  if (!read.found) return { ok: true, config: { model: "", revision: null } };
  const model = typeof read.document.value.model === "string" ? read.document.value.model.trim() : "";
  return { ok: true, config: { model, revision: read.document.revision } };
}

export async function writePromptSkillsConfig(
  store: ExtensionDocumentStore | undefined,
  input: { model: unknown; expectedRevision: unknown }
): Promise<WriteConfigResult> {
  if (!store) return { ok: false, code: "unavailable", message: "宿主未提供扩展存储，无法保存改写模型" };
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (model === "" || model.length > MAX_MODEL_CHARS) {
    return { ok: false, code: "invalid", message: "请选择一个有效的语言模型" };
  }
  const expectedRevision = input.expectedRevision;
  if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || (expectedRevision as number) < 0)) {
    return { ok: false, code: "invalid", message: "expectedRevision 必须是非负整数或 null" };
  }
  const result = await store.batch([
    { op: "set", key: CONFIG_KEY, value: { model }, expectedRevision: expectedRevision as number | null }
  ]);
  if (!result.ok) {
    if (result.code === "revision-conflict") {
      return {
        ok: false,
        code: "conflict",
        message: "配置已被其它窗口修改，请刷新后重试",
        ...(result.currentRevision !== null ? { currentRevision: result.currentRevision } : {})
      };
    }
    return { ok: false, code: "invalid", message: result.message };
  }
  return { ok: true, revision: result.revisions[CONFIG_KEY] ?? 0 };
}
