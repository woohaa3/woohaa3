/**
 * 画布内「同一模型上一次参数」偏好（浏览器本地，随画布隔离）。
 *
 * 问题：草稿分区是 `{nodeId, modelKey}`（见 `drafts.ts`）。新建节点或换到另一个图片 / 视频
 * 节点时该分区为空，`parametersOnOpen` 只能回落到模型 schema 默认值，于是同一模型在每张
 * 卡片上都回到默认画幅、分辨率、时长。用户期望的是「同一模型用上一次的参数」。
 *
 * 规则（刻意保持窄）：
 * - 只在**提交被受理成功**后写一次，记录用户真正用过的值，不是面板里的临时调整；
 * - 键包含数据空间与 canvasId，所以偏好跟着画布走，不跨画布、不跨账号主体；
 * - 打开面板时的优先级是「本节点该模型草稿 > 画布内该模型上次参数 > schema 默认」，
 *   草稿永远优先，不覆盖用户正在改的值；
 * - 只存浏览器本地（localStorage，失败退回本页内存），写不进 Y.Doc，也不进任务历史；
 * - 回放前按**当前**模型 schema 重新校验：模型下线、枚举变了、字段改名、隐藏联动都不再套用
 *   旧值，绝不把旧枚举塞给新 schema（那会被提交门禁拦下）。
 */
import { validPresentedParameter, type CanvasTaskCatalogModel } from "@woohaa3/contracts";
import { projectParameterDefaults, projectParameterFields } from "./parameter-projection.js";

export const CANVAS_MODEL_PARAMETERS_PREFIX = "woohaa3.canvas-model-parameters.v1";

/** 每张画布最多记住多少个模型；超出按最近使用淘汰。 */
const MAX_MODELS_PER_CANVAS = 24;

/** 不属于「生成参数」的身份字段：模型由面板选择，来源由连接选择持有。 */
const NON_PARAMETER_KEYS = new Set(["model", "serviceConnectionId"]);

export type CanvasModelParameterStorage = Pick<Storage, "getItem" | "setItem">;

type CanvasModels = Record<string, Record<string, unknown>>;

/** 偏好键：数据空间 + 画布，与草稿的 target 身份同形。 */
export function canvasModelParametersKey(space: string, canvasId: string): string {
  return `${CANVAS_MODEL_PARAMETERS_PREFIX}:${JSON.stringify([space, canvasId])}`;
}

function browserStorage(): CanvasModelParameterStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只保留可 JSON 往返的值；函数、undefined、NaN 这类值不进偏好。 */
function sanitizeParameters(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (NON_PARAMETER_KEYS.has(key)) continue;
    if (entry === undefined || entry === null) continue;
    if (typeof entry === "number" && !Number.isFinite(entry)) continue;
    if (typeof entry === "function" || typeof entry === "symbol") continue;
    try {
      if (JSON.stringify(entry) === undefined) continue;
    } catch {
      continue;
    }
    result[key] = entry;
  }
  return result;
}

function sanitizeCanvasModels(value: unknown): CanvasModels {
  if (!isRecord(value)) return {};
  const result: CanvasModels = {};
  for (const [modelKey, parameters] of Object.entries(value)) {
    if (modelKey === "") continue;
    const sanitized = sanitizeParameters(parameters);
    if (Object.keys(sanitized).length > 0) result[modelKey] = sanitized;
  }
  return result;
}

export class CanvasModelParameterStore {
  private readonly memory = new Map<string, CanvasModels>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly storage: () => CanvasModelParameterStorage | null = browserStorage) {}

  /** 偏好版本号（每次记录/清空推进）；订阅方据此重算，不依赖对象引用。 */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** 读整桶（内存优先，其次 localStorage）；损坏内容按空桶处理，不阻塞面板。 */
  read(canvasKey: string): CanvasModels {
    const cached = this.memory.get(canvasKey);
    try {
      const raw = this.storage()?.getItem(canvasKey);
      if (raw === null || raw === undefined) return cached ?? {};
      const parsed = sanitizeCanvasModels(JSON.parse(raw) as unknown);
      this.memory.set(canvasKey, parsed);
      return parsed;
    } catch {
      // 存储不可用或内容损坏：保留本页内存里已写入的值。
      return cached ?? {};
    }
  }

  /** 某个模型在该画布上的上次参数；没有记录返回 undefined。 */
  get(canvasKey: string, modelKey: string): Record<string, unknown> | undefined {
    if (modelKey === "") return undefined;
    const entry = this.read(canvasKey)[modelKey];
    return entry ? { ...entry } : undefined;
  }

  /** 记录一次已被受理的提交参数。 */
  record(canvasKey: string, modelKey: string, parameters: Record<string, unknown>): void {
    if (modelKey === "") return;
    const sanitized = sanitizeParameters(parameters);
    if (Object.keys(sanitized).length === 0) return;
    const models = { ...this.read(canvasKey) };
    // 先删再写：保证最近使用的模型排在对象末尾，淘汰时从头部开始。
    delete models[modelKey];
    models[modelKey] = sanitized;
    const keys = Object.keys(models);
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_MODELS_PER_CANVAS))) delete models[stale];
    this.memory.set(canvasKey, models);
    try {
      this.storage()?.setItem(canvasKey, JSON.stringify(models));
    } catch {
      // 写失败只影响下次打开时的默认值，本次会话内仍按内存生效。
    }
    this.emit();
  }

  /** 画布被删除或偏好显式重置时清空该桶。 */
  clear(canvasKey: string): void {
    this.memory.delete(canvasKey);
    try {
      this.storage()?.setItem(canvasKey, "{}");
    } catch {
      // 忽略。
    }
    this.emit();
  }
}

/** 页面级单例。 */
export const canvasModelParameterStore = new CanvasModelParameterStore();

/**
 * 把画布内的上次参数投影成「当前模型可用的参数」。
 *
 * 返回 `undefined` 表示这份记录对当前 schema 已经没有可用值（模型改了、字段全没了），
 * 调用方应回落到模型默认值 —— 不要用一份空的默认值对象冒充「有偏好」。
 */
export function rememberedModelParameters(
  model: CanvasTaskCatalogModel | null,
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!model || !stored) return undefined;
  const fields = projectParameterFields(model);
  if (fields.length === 0) return undefined;
  const candidate: Record<string, unknown> = { ...projectParameterDefaults(model) };
  let matched = false;
  for (const field of fields) {
    const value = stored[field.key];
    if (value === undefined || value === null) continue;
    if (!validPresentedParameter(field, value)) continue;
    candidate[field.key] = value;
    matched = true;
  }
  if (!matched) return undefined;
  // 与模型切换的迁移口径一致：被选中的值可能带出结构上的必填联动（例：透明背景要求 PNG）。
  for (const field of fields) {
    const requirement = field.requiresByValue?.[String(candidate[field.key] ?? "")];
    if (requirement) Object.assign(candidate, requirement);
  }
  // 隐藏字段既不展示也不提交，不保留上次值。
  for (const field of fields) {
    if (field.hiddenWhen?.some((rule) => candidate[rule.field] === rule.equals)) delete candidate[field.key];
  }
  return candidate;
}
