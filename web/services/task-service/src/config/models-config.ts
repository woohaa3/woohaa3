/**
 * 模型配置文件（change: add-image-text-node-execution，design D12 / D13）。
 *
 * 为什么不是环境变量：模型清单是业务/能力数据，不是部署配置。provider 已经有一份注册表
 * （LiteLLM 来自网关发现，其余 Provider 在注册时声明），用环境变量再列一遍就是同一事实的第二份副本，
 * 而且漂移是隐性的 —— 写错 id 或放错类型会让模型静默从 catalog 消失。
 *
 * 语义（design D13）：
 * - `models` 省略或为空 → 启用注册表里全部文本/图片模型（**默认零配置可用**）；
 * - `models` 非空 → 白名单，只启用列出的（且未 `enabled: false` 的）；
 * - 注册表里没有的 id → **硬报错**（不允许静默跳过，运营必须能确信配置生效了）；
 * - 类型不写在配置里，由注册表决定（结构上消除"类型放错"）。
 *
 * 这里只做「解析 + 与注册表求交」两件纯事，读文件与 provider 交互在调用方。
 */
import { readFileSync } from "node:fs";
import { isModelInteractionDescriptor, type CanvasTaskModelType } from "@woohaa3/contracts";

/** 默认文件名；路径由调用方（各入口）拼成绝对路径后传入，不走环境变量。 */
export const DEFAULT_MODELS_CONFIG_FILENAME = "pptask.models.json";

/** 参考输入能力的运营覆盖：只接受完整 `bindings`（change: 2026-10-07-remove-residual-compatibility）。 */
export type ReferenceInputOverride = {
  bindings?: unknown;
};

export type ModelConfigEntry = {
  /** 稳定 opaque `modelKey`（catalog 内唯一）。 */
  id: string;
  /** `false` 表示临时下线（仍保留配置，便于随时恢复）。 */
  enabled?: boolean;
  /** 该模型类型的默认模型；每个类型至多一个。 */
  default?: boolean;
  /** 面板显示名覆盖。 */
  title?: string;
  /** 展示顺序（升序）；未指定的排在有指定之后，保持注册表顺序。 */
  order?: number;
  /** 任务级超时覆盖（毫秒）；缺省按模型类型取默认。 */
  taskTimeoutMs?: number;
  /** 受信任的模型交互 identity（change: add-pluggable-model-interactions，D2）。 */
  interaction?: { id: string; version: number };
  referenceInput?: ReferenceInputOverride;
};

export type ModelsConfig = {
  version: number;
  models: ModelConfigEntry[];
};

export type ModelsConfigResult =
  | { ok: true; config: ModelsConfig; source: string }
  | { ok: false; reason: string };

const ROOT_KEYS = new Set(["version", "models"]);
const ENTRY_KEYS = new Set([
  "id",
  "enabled",
  "default",
  "title",
  "order",
  "taskTimeoutMs",
  "interaction",
  "referenceInput"
]);
const REFERENCE_KEYS = new Set(["bindings"]);

/** 解析配置对象。`source` 只用于错误信息（文件名或 `<memory>`）。 */
export function parseModelsConfig(raw: unknown, source = "<memory>"): ModelsConfigResult {
  if (!isRecord(raw)) return fail(source, "配置根节点必须是 JSON 对象");

  const unknownRoot = Object.keys(raw).filter((key) => !ROOT_KEYS.has(key));
  if (unknownRoot.length > 0) {
    return fail(source, `配置含未知字段：${unknownRoot.join("、")}（只允许 version / models）`);
  }

  const version = raw.version === undefined ? 1 : raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return fail(source, "version 必须是 ≥1 的整数");
  }

  const rawModels = raw.models === undefined ? [] : raw.models;
  if (!Array.isArray(rawModels)) return fail(source, "models 必须是数组");

  const models: ModelConfigEntry[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of rawModels.entries()) {
    const parsed = parseEntry(entry, index, source);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.entry.id)) {
      return fail(source, `models[${index}] 的 id 重复：${parsed.entry.id}`);
    }
    seen.add(parsed.entry.id);
    models.push(parsed.entry);
  }

  return { ok: true, config: { version, models }, source };
}

/** 从文件读取并解析；文件不存在/不可读时给出带路径的原因（不静默降级）。 */
export function loadModelsConfigFile(
  path: string,
  readFile: (path: string) => string = (target) => readFileSync(target, "utf8")
): ModelsConfigResult {
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    return { ok: false, reason: `读取模型配置失败：${path}（${errorMessage(error)}）` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `模型配置不是合法 JSON：${path}（${errorMessage(error)}）` };
  }
  return parseModelsConfig(parsed, path);
}

/** provider 注册表条目（由 `TaskProvider.listModels()` 提供）。 */
export type ProviderModelEntry = {
  modelKey: string;
  providerId: string;
  providerModelId: string;
  modelType: CanvasTaskModelType;
};

export type ResolvedModel = {
  modelKey: string;
  providerId: string;
  providerModelId: string;
  modelType: CanvasTaskModelType;
  title?: string;
  order: number;
  isDefault: boolean;
  taskTimeoutMs?: number;
  /** 受信任的交互 identity（缺省由 catalog builder 落到 generic）。 */
  interaction?: { id: string; version: number };
  referenceInput?: ReferenceInputOverride;
};

export type ResolveModelsResult =
  | {
      ok: true;
      models: ResolvedModel[];
      /** 显式声明的默认模型；未声明的类型由面板回落到该类型第一个模型。 */
      defaults: Partial<Record<CanvasTaskModelType, string>>;
    }
  | { ok: false; reason: string };

/**
 * 把配置与 provider 注册表求交，得到最终启用集合。
 *
 * 空 `models` 是「全开」而不是「全关」：零配置就能跑起来，运营只在需要收窄时写清单。
 */
export function resolveEnabledModels(
  config: ModelsConfig,
  registry: readonly ProviderModelEntry[]
): ResolveModelsResult {
  if (registry.length === 0) {
    return { ok: false, reason: "provider 注册表为空，没有可用模型" };
  }

  const registryByIndex = new Map(registry.map((entry, index) => [entry.modelKey, { entry, index }]));

  if (config.models.length === 0) {
    const models = registry.map((entry, index) => ({
      modelKey: entry.modelKey,
      providerId: entry.providerId,
      providerModelId: entry.providerModelId,
      modelType: entry.modelType,
      order: index,
      isDefault: false
    }));
    return { ok: true, models, defaults: {} };
  }

  const unknown = config.models.map((entry) => entry.id).filter((id) => !registryByIndex.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `模型配置里有 provider 不认识的 id：${unknown.join("、")}（可用：${registry
        .map((entry) => entry.modelKey)
        .join("、")}）`
    };
  }

  const models: ResolvedModel[] = [];
  const defaults: Partial<Record<CanvasTaskModelType, string>> = {};
  for (const entry of config.models) {
    const registered = registryByIndex.get(entry.id);
    if (!registered) continue; // 上面已整体拦截，这里只为类型收窄
    const { modelType } = registered.entry;

    if (entry.enabled === false) {
      if (entry.default === true) {
        return { ok: false, reason: `${entry.id} 已停用，不能同时声明为默认模型` };
      }
      continue;
    }
    if (entry.default === true) {
      const existing = defaults[modelType];
      if (existing) {
        return {
          ok: false,
          reason: `${modelType} 模型只能有一个默认：${existing} 与 ${entry.id} 冲突`
        };
      }
      defaults[modelType] = entry.id;
    }

    models.push({
      modelKey: entry.id,
      providerId: registered.entry.providerId,
      providerModelId: registered.entry.providerModelId,
      modelType,
      title: entry.title,
      order: entry.order ?? Number.MAX_SAFE_INTEGER,
      isDefault: entry.default === true,
      taskTimeoutMs: entry.taskTimeoutMs,
      ...(entry.interaction ? { interaction: entry.interaction } : {}),
      referenceInput: entry.referenceInput
    });
  }

  if (models.length === 0) {
    return { ok: false, reason: "模型配置里没有任何启用的模型" };
  }

  // 稳定排序：先按 order，再按注册表顺序，保证 catalog 顺序可预测。
  models.sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return (registryByIndex.get(left.modelKey)?.index ?? 0) - (registryByIndex.get(right.modelKey)?.index ?? 0);
  });

  return { ok: true, models, defaults };
}

function parseEntry(
  input: unknown,
  index: number,
  source: string
): { ok: true; entry: ModelConfigEntry } | { ok: false; reason: string } {
  if (!isRecord(input)) return fail(source, `models[${index}] 必须是对象`);

  const unknownKeys = Object.keys(input).filter((key) => !ENTRY_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return fail(source, `models[${index}] 含未知字段：${unknownKeys.join("、")}`);
  }

  const id = input.id;
  if (typeof id !== "string" || id.trim() === "") {
    return fail(source, `models[${index}] 缺少非空 id`);
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    return fail(source, `models[${index}].enabled 必须是布尔值`);
  }
  if (input.default !== undefined && typeof input.default !== "boolean") {
    return fail(source, `models[${index}].default 必须是布尔值`);
  }
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.trim() === "")) {
    return fail(source, `models[${index}].title 必须是非空字符串`);
  }
  if (input.order !== undefined && (typeof input.order !== "number" || !Number.isFinite(input.order))) {
    return fail(source, `models[${index}].order 必须是有限数字`);
  }
  if (
    input.taskTimeoutMs !== undefined &&
    (typeof input.taskTimeoutMs !== "number" ||
      !Number.isInteger(input.taskTimeoutMs) ||
      input.taskTimeoutMs <= 0)
  ) {
    return fail(source, `models[${index}].taskTimeoutMs 必须是正整数字符数（毫秒）`);
  }

  let referenceInput: ReferenceInputOverride | undefined;
  if (input.referenceInput !== undefined) {
    const parsed = parseReferenceInput(input.referenceInput, index, source);
    if (!parsed.ok) return parsed;
    referenceInput = parsed.value;
  }

  let interaction: { id: string; version: number } | undefined;
  if (input.interaction !== undefined) {
    if (!isModelInteractionDescriptor(input.interaction)) {
      return fail(source, `models[${index}].interaction 必须是合法的 { id, version }（拒绝 module URL/组件路径等可执行字段）`);
    }
    interaction = { id: input.interaction.id, version: input.interaction.version };
  }

  return {
    ok: true,
    entry: {
      id: id.trim(),
      enabled: input.enabled as boolean | undefined,
      default: input.default as boolean | undefined,
      title: input.title as string | undefined,
      order: input.order as number | undefined,
      taskTimeoutMs: input.taskTimeoutMs as number | undefined,
      interaction,
      referenceInput
    }
  };
}

function parseReferenceInput(
  input: unknown,
  index: number,
  source: string
): { ok: true; value: ReferenceInputOverride } | { ok: false; reason: string } {
  if (!isRecord(input)) return fail(source, `models[${index}].referenceInput 必须是对象`);
  const unknownKeys = Object.keys(input).filter((key) => !REFERENCE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return fail(source, `models[${index}].referenceInput 含未知字段：${unknownKeys.join("、")}`);
  }
  if (input.bindings !== undefined && !Array.isArray(input.bindings)) {
    return fail(source, `models[${index}].referenceInput.bindings 必须是数组`);
  }
  return { ok: true, value: { bindings: input.bindings } };
}

function fail(source: string, message: string): { ok: false; reason: string } {
  return { ok: false, reason: `${source}：${message}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
