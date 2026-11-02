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
  /** 运营分类（`image` / `image-g` / `image-s` / 视频类…），来自模板表。 */
  category?: string;
  /** 单价（积分）。来自 `cost_coins`，**下单前**给用户看。 */
  cost?: number;
  /** 模板表的 `display_meta` 原样保留（图标、成功率等）。 */
  displayMeta?: Record<string, unknown>;
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

/** 遮罩类上传字段：它是蒙版而不是参考图，画布上的普通图片不能连进来。 */
function isMaskField(key: string, field: Record<string, any>): boolean {
  if (/mask/i.test(key)) return true;
  const title = typeof field.title === "string" ? field.title : "";
  return /遮罩|蒙版|mask/i.test(title);
}

/**
 * 主图字段的识别：RunningHub 表单用 `variant: deferred` + `sourceHints.content: canvas`
 * 表示「这是一张用来改的底图」，其余图片上传字段才是参考图。
 *
 * 只用来补标题，不改变角色（见 `tagReferenceImageField` 的说明）。
 */
function isSourceImageField(field: Record<string, any>): boolean {
  const props = isRecord(field["x-component-props"]) ? field["x-component-props"] : {};
  if (props.variant === "deferred") return true;
  const hints = props.sourceHints;
  return isRecord(hints) && hints.content === "canvas";
}

/**
 * 给「接受图片的上传字段」补上宿主认的 `x-pptask-semantic: reference-image`。
 *
 * 服务端表单（RunningHub 风格）只声明 `x-component: Upload` + `accept: image/*`，没有语义标记。
 * 宿主推导输入绑定只认语义标记，没有就当「该模型不接受参考图」，于是画布上任何图片都被
 * 参考图选择器拒绝（「当前模型不接受该媒体类型」）。
 *
 * 只补不改：已有语义的字段不动；遮罩字段不补；`maxCount` 带成 `maxItems` 供宿主夹上限。
 * 返回新对象，不修改入参。
 */
function tagReferenceImageField(schema: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!schema || !isRecord(schema.properties)) return schema;
  const properties: Record<string, any> = {};
  for (const [key, field] of Object.entries(schema.properties as Record<string, unknown>)) {
    if (!isRecord(field) || field["x-component"] !== "Upload" || "x-pptask-semantic" in field || isMaskField(key, field)) {
      properties[key] = field;
      continue;
    }
    const props = isRecord(field["x-component-props"]) ? field["x-component-props"] : {};
    const accept = typeof props.accept === "string" ? props.accept : "";
    // 只认明确接受图片的字段；没写 accept 的不猜（视频/音频上传也是 Upload）。
    if (!/(^|,)\s*image\//i.test(accept)) {
      properties[key] = field;
      continue;
    }
    const maxCount = typeof props.maxCount === "number" && props.maxCount > 0 ? props.maxCount : undefined;
    // 角色保持 `reference_image`：画布连线推出来的角色就是它，这里另起一个 role 会让主图字段
    // 永远匹配不上（分配直接失败）。主图与参考图的区别用**标题**表达，界面按它显示标签。
    const sourceImage = isSourceImageField(field);
    properties[key] = {
      ...field,
      "x-pptask-semantic": "reference-image",
      ...(sourceImage && !field.title ? { title: "主图像" } : {}),
      ...(maxCount !== undefined && field.maxItems === undefined ? { maxItems: maxCount } : {})
    };
  }
  return { ...schema, properties };
}

export function interpretDescribe(payload: unknown): DescribedTemplate {
  const record = isRecord(payload) ? payload : {};
  const kindRaw = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
  const kind: PpserverKind | undefined =
    kindRaw === "image" ? "image" : kindRaw === "video" ? "video" : undefined;

  const schema = tagReferenceImageField(
    isRecord(record.formSchema)
      ? record.formSchema
      : isRecord(record.inputSchema)
        ? record.inputSchema
        : undefined
  );
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
