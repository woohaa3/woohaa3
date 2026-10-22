/**
 * 生成模型管理 remote adapter
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.1 / design D2）。
 *
 * 浏览器访问生成模型策略的**唯一**出口：公开 snapshot 与管理员写入。不持有服务令牌。
 */
import type { GenerationModelsSnapshot, GenerationModelsWriteRequest } from "@woohaa3/contracts";
import { getAppPublicFetch } from "./app-base-path.js";
import { GENERATION_MODELS_BASE_PATH } from "./paths.js";

export type GenerationModelsRemote = {
  fetchSnapshot: () => Promise<{ ok: true; snapshot: GenerationModelsSnapshot } | { ok: false; error: string }>;
  writeConfig: (input: GenerationModelsWriteRequest) => Promise<
    | { ok: true; revision: number; snapshot: GenerationModelsSnapshot }
    | { ok: false; code: string; error: string; currentRevision?: number }
  >;
};

export type GenerationModelsRemoteOptions = {
  basePath?: string;
  fetchImpl?: typeof globalThis.fetch;
};

export function createGenerationModelsRemote(options: GenerationModelsRemoteOptions = {}): GenerationModelsRemote {
  const basePath = (options.basePath ?? GENERATION_MODELS_BASE_PATH).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();

  return {
    async fetchSnapshot() {
      try {
        const response = await fetchImpl(basePath, { method: "GET" });
        const body = await response.json().catch(() => null);
        if (!response.ok) return { ok: false, error: readMessage(body, "无法读取生成模型状态") };
        if (!isSnapshot(body)) return { ok: false, error: "生成模型状态响应无法识别" };
        return { ok: true, snapshot: body };
      } catch {
        return { ok: false, error: "无法连接生成模型服务" };
      }
    },
    async writeConfig(input) {
      try {
        const response = await fetchImpl(`${basePath}/config`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          return {
            ok: false,
            code: readCode(body) ?? "unavailable",
            error: readMessage(body, "生成模型配置保存失败"),
            ...(readCurrentRevision(body) !== undefined ? { currentRevision: readCurrentRevision(body) as number } : {})
          };
        }
        if (!isRecord(body) || typeof body.revision !== "number" || !isSnapshot(body.snapshot)) {
          return { ok: false, code: "malformed", error: "生成模型配置响应无法识别" };
        }
        return { ok: true, revision: body.revision, snapshot: body.snapshot };
      } catch {
        return { ok: false, code: "unavailable", error: "无法连接生成模型服务" };
      }
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSnapshot(value: unknown): value is GenerationModelsSnapshot {
  return isRecord(value) && typeof value.revision === "number" && Array.isArray(value.models);
}
function readMessage(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.message === "string" && body.message !== "" ? body.message : fallback;
}
function readCode(body: unknown): string | undefined {
  return isRecord(body) && typeof body.code === "string" ? body.code : undefined;
}
function readCurrentRevision(body: unknown): number | undefined {
  return isRecord(body) && typeof body.currentRevision === "number" ? body.currentRevision : undefined;
}
