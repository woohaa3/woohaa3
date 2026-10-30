/**
 * 从 ppserver 的 `/tasks/describe` 发现模板能做什么。
 *
 * 模板是服务端的运行时事实（谁启用的、参数改没改），所以**不把模型表写死在插件里**：
 * 配置只给模板 ID，刷新时逐个 `describe` 拿 `formSchema` / `formValues` / `metadata`。
 *
 * `describe` 不需要鉴权即可回答「这个模板存不存在」，所以刷新失败不会把插件拖挂，
 * 只是目录为空 —— 设置页仍然能看到插件并提示原因。
 *
 * 类型（image / video）优先取 describe 自报的 `kind`；没有时取配置里 `id:kind` 的后缀，
 * 最后按 image 兜底。**不靠猜**：模型类型决定宿主把它放进哪个面板，猜错比缺省更糟。
 */
import type { GenerationModelDefinition } from "@woohaa3/contracts";
import { PPSERVER_PROVIDER_ID, isTemplateId, templateIdFromLocator } from "./shared.js";

export type PpserverKind = "image" | "video";

export type PpserverTemplate = {
  /** 宿主侧模型 id：直接用模板 UUID，一眼能对上服务端的 `tasks_template.id`。 */
  modelId: string;
  templateId: string;
  kind: PpserverKind;
  title: string;
  /** describe 原样返回的参数表单与默认值，交给 catalog 做参数面板。 */
  inputSchema?: Record<string, unknown>;
  defaultInput?: Record<string, unknown>;
  /** 参考图要传到哪个 provider（`recommendUploadProvider`）。 */
  uploadProvider?: string;
};

export type DiscoveryResult =
  | { ok: true; templates: PpserverTemplate[]; message?: string }
  | { ok: false; message: string };

const DESCRIBE_TIMEOUT_MS = 15_000;

/** 配置里的一条：`<uuid>` 或 `<uuid>:image|video`。 */
export type TemplateSpec = { templateId: string; kind?: PpserverKind };

export function parseTemplateSpecs(value: string | undefined, max = 64): { ok: true; specs: TemplateSpec[] } | { ok: false; message: string } {
  const specs: TemplateSpec[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const part of (value ?? "").split(/[\s,]+/)) {
    if (!part.trim()) continue;
    const [rawId, rawKind] = part.trim().split(":");
    const templateId = templateIdFromLocator(rawId ?? "");
    if (!templateId || seen.has(templateId.toLowerCase())) continue;
    if (!isTemplateId(templateId)) {
      invalid.push(templateId);
      continue;
    }
    const kind = rawKind === "video" ? "video" : rawKind === "image" ? "image" : undefined;
    if (rawKind && !kind) {
      invalid.push(part.trim());
      continue;
    }
    seen.add(templateId.toLowerCase());
    specs.push({ templateId: templateId.toLowerCase(), ...(kind ? { kind } : {}) });
  }
  if (invalid.length > 0) {
    return { ok: false, message: `模板写法不对（应为 UUID 或 UUID:image|video）：${invalid.slice(0, 3).join("、")}` };
  }
  if (specs.length > max) return { ok: false, message: `一次最多接入 ${max} 个模板` };
  return { ok: true, specs };
}

/** describe 的返回解读：只取宿主用得上的字段，其余原样留在 inputSchema 里。 */
export type DescribedTemplate = {
  kind?: PpserverKind;
  title?: string;
  inputSchema?: Record<string, unknown>;
  defaultInput?: Record<string, unknown>;
  uploadProvider?: string;
};

export function interpretDescribe(payload: unknown): DescribedTemplate {
  const record = isRecord(payload) ? payload : {};
  const kindRaw = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
  const kind: PpserverKind | undefined =
    kindRaw === "image" ? "image" : kindRaw === "video" ? "video" : undefined;

  const schema = isRecord(record.formSchema)
    ? record.formSchema
    : isRecord(record.inputSchema)
      ? record.inputSchema
      : undefined;
  const values = isRecord(record.formValues)
    ? record.formValues
    : isRecord(record.defaultInput)
      ? record.defaultInput
      : undefined;

  const title = [record.name_zhcn, record.name, record.label, record.title]
    .find((value): value is string => typeof value === "string" && value.trim() !== "")
    ?.trim();

  const uploadProvider =
    typeof record.recommendUploadProvider === "string" && record.recommendUploadProvider.trim()
      ? record.recommendUploadProvider.trim()
      : undefined;

  return {
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(schema ? { inputSchema: schema } : {}),
    ...(values ? { defaultInput: values } : {}),
    ...(uploadProvider ? { uploadProvider } : {})
  };
}

export async function discoverTemplates(options: {
  baseUrl: string;
  specs: readonly TemplateSpec[];
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<DiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const origin = options.baseUrl.trim().replace(/\/+$/, "");
  const templates: PpserverTemplate[] = [];
  const failures: string[] = [];

  for (const spec of options.specs) {
    const url = `${origin}/tasks/describe?templateId=${encodeURIComponent(spec.templateId)}`;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? DESCRIBE_TIMEOUT_MS)
      });
      if (!response.ok) {
        failures.push(`${spec.templateId.slice(0, 8)}…（HTTP ${response.status}）`);
        continue;
      }
      const described = interpretDescribe((await response.json()) as unknown);
      const kind = described.kind ?? spec.kind ?? "image";
      templates.push({
        modelId: spec.templateId,
        templateId: spec.templateId,
        kind,
        title: described.title ?? spec.templateId,
        ...(described.inputSchema ? { inputSchema: described.inputSchema } : {}),
        ...(described.defaultInput ? { defaultInput: described.defaultInput } : {}),
        ...(described.uploadProvider ? { uploadProvider: described.uploadProvider } : {})
      });
    } catch (error) {
      failures.push(`${spec.templateId.slice(0, 8)}…（${error instanceof Error ? error.message : String(error)}）`);
    }
  }

  if (templates.length === 0) {
    return {
      ok: false,
      message: failures.length > 0 ? `没有可用的模板：${failures.join("、")}` : "还没有配置模板 ID"
    };
  }
  return {
    ok: true,
    templates,
    ...(failures.length > 0 ? { message: `部分模板不可用：${failures.join("、")}` } : {})
  };
}

export function ppserverModelDefinitions(templates: readonly PpserverTemplate[]): GenerationModelDefinition[] {
  return templates.map((template) => ({
    providerId: PPSERVER_PROVIDER_ID,
    providerModelId: template.modelId,
    modelType: template.kind,
    title: template.title,
    promptRequirement: "required" as const,
    ...(template.inputSchema ? { inputSchema: template.inputSchema } : {}),
    ...(template.defaultInput ? { defaultInput: template.defaultInput } : {})
  }));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
