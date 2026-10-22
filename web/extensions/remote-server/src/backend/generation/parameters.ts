/**
 * 远端托管生成的**参数收敛**（只在这里做一次，不散落在 provider 与解码里）。
 *
 * 为什么需要它：参数面板把「用户看到的东西」和「要提交的值」放在同一个 map 里
 * （`parameters.model` 是模型身份、被隐藏的字段仍留在 map 里、输入框清空后留下空串）。
 * 这些都不是上游要的生成参数，直接透传会让服务端把一个空串或一个面板占位值当成真实参数。
 * 所以提交前统一过一遍：
 *
 * 1. **默认值合并**：`defaultInput` → schema 的 `default` → 用户显式值（后者优先）。
 *    面板已经做过同样的合并，这里再做一次是因为 `prepareInput` 也可能来自批处理/重跑，
 *    那时没有面板参与，缺默认值就等于把「模型自己的默认」丢给上游去猜。
 * 2. **脏值清洗**：丢弃 undefined / null / 空串 / NaN / Infinity / 空数组 / 空对象；
 *    字符串统一 trim（面板的输入框可能带前后空格）。
 * 3. **只按 schema 归一，不按白名单裁剪**：schema 声明了某个键，就按它的类型与 enum 收敛
 *    （见 `coerceDeclaredValue`）；schema 没声明的键**原样保留**——远端服务端可能接受
 *    schema 之外的参数，收得太紧会把本来能用的能力砍掉。只剔除两类显式控制键
 *    （`model` / `prompt`）：它们在协议里是同级字段，混进 parameters 会把别的东西覆盖掉。
 *
 * 老服务端兼容：schema 还是裸 `{"size": {"type": "string"}}` 时上面每一步都退化成
 * 「照原样保留」，不会因为缺少语义字段（resolution / aspectRatio）报错或多造参数。
 */
import {
  PPTASK_PARAMETER_ADAPTIVE,
  PPTASK_PARAMETER_CONTROL,
  isAdaptiveParameterValue,
  isAspectRatioValue,
  isPptaskParameterControl
} from "@woohaa3/contracts";

/** schema 里单个属性节点的形状（JSON Schema 子集 + `x-pptask-*` 扩展键）。 */
type PropertySchema = Record<string, unknown>;

/**
 * 由面板或协议承载、**不属于**生成参数的键。
 *
 * - `model`：面板把它写进 parameters 表示「用哪个模型」；协议里模型身份是独立字段
 *   （`modelKey`/`modelType`），把它当参数发给上游没有意义。
 * - `prompt`：协议里的独立字段；混进 parameters 会在服务端 merge 时覆盖真正的提示词。
 */
const NON_PARAMETER_KEYS = new Set(["model", "prompt"]);

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 取某个参数在 schema 里的声明节点。
 *
 * 只认顶层 `properties`；`$ref`/`allOf` 等组合关键字在 catalog 里没有出现（各 Provider
 * 都是自描述的字面 schema），为它们写解析器只会增加出错的面积。
 */
export function readPropertySchema(
  inputSchema: Record<string, unknown> | undefined,
  key: string
): PropertySchema | undefined {
  const properties = readRecord(inputSchema?.properties);
  return properties === null ? undefined : (readRecord(properties[key]) ?? undefined);
}

/** enum 里的一项取可选值：支持裸值与 `{ value, label }` 两种（与面板投影同口径）。 */
function enumValueOf(entry: unknown): unknown {
  if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") return entry;
  const record = readRecord(entry);
  return record === null ? undefined : record.value;
}

/**
 * 按 schema 的类型/枚举收敛**一个已声明的**参数值；无法收敛时返回 `undefined`（= 丢弃该键）。
 *
 * 为什么不直接把非法值发出去：服务端是参数的最后一道关，但它给的是笼统的「服务端拒绝了这次
 * 请求」；把一个已经失效的枚举（例如切换模型后残留的 `hd`）在本地转成默认值，用户拿到的是
 * 一次成功的生成，而不是一个看不懂的失败。
 *
 * 对自适应/比例的**额外保护**：语义字段上任何非空字符串都保留（服务端可能追加了新的档位
 * 而客户端 catalog 还没刷新）；只有「形状明显不是比例」的值在声明了 enum 时才回落到默认值。
 */
export function coerceDeclaredValue(schema: PropertySchema, value: unknown): unknown {
  // 带 enum 的字段：只接受 enum 里的取值，其余一律视为「没选」。
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allowed = new Set<unknown>(schema.enum.map(enumValueOf).filter((entry) => entry !== undefined));
    if (allowed.has(value)) return value;
    // 数字被输入框存成字符串时按数值再比一次（面板的 number 字段有这条历史形态）。
    if (typeof value === "string" && value.trim() !== "") {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber) && allowed.has(asNumber)) return asNumber;
    }
    // 旧枚举的残留值：由调用方回落到 defaultInput/schema.default。
    return undefined;
  }

  const type = schema.type;
  if (type === "string") return typeof value === "string" ? value : undefined;
  if (type === "integer") {
    const asNumber = typeof value === "number" ? value : Number(value);
    return typeof value === "number" || typeof value === "string" ? (Number.isInteger(asNumber) ? asNumber : undefined) : undefined;
  }
  if (type === "number") {
    const asNumber = typeof value === "number" ? value : Number(value);
    return typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? (Number.isFinite(asNumber) ? asNumber : undefined) : undefined;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }
  if (type === "array") return Array.isArray(value) ? value : undefined;
  if (type === "object") return readRecord(value) ?? undefined;
  // 没声明 type 的字段：形状由调用方（清洗阶段）保证，这里不再加约束。
  return value;
}

/**
 * 单个值的最终清洗（默认值合并之后、发送之前）。
 *
 * 与 `coerceDeclaredValue` 分开的原因：schema 的 `default` 也可能是 `null` 或空串，
 * 那些同样不该发到上游；而「用户清空了字段」与「默认值本身为空」需要的结论一样——不发。
 */
export function normalizeParameterValue(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (Array.isArray(value)) {
    const cleaned = value.map(normalizeParameterValue).filter((entry) => entry !== undefined);
    return cleaned.length === 0 ? undefined : cleaned;
  }
  const record = readRecord(value);
  if (record !== null) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      const normalized = normalizeParameterValue(entry);
      if (normalized !== undefined) cleaned[key] = normalized;
    }
    return Object.keys(cleaned).length === 0 ? undefined : cleaned;
  }
  return value;
}

/** 某个键的默认值：`defaultInput` 优先，schema 的 `default` 只补前者没声明的键。 */
function defaultOf(
  key: string,
  defaultInput: Record<string, unknown> | undefined,
  schema: PropertySchema | undefined
): unknown {
  if (defaultInput !== undefined && Object.hasOwn(defaultInput, key) && defaultInput[key] !== undefined) {
    return defaultInput[key];
  }
  return schema?.default;
}

/** 候选键的顺序：先 `defaultInput`，再 schema 的 `properties`（后者补齐前者没写的键）。 */
function candidateKeys(
  defaultInput: Record<string, unknown> | undefined,
  inputSchema: Record<string, unknown> | undefined,
  parameters: Record<string, unknown>
): string[] {
  const keys = new Set<string>();
  for (const key of Object.keys(defaultInput ?? {})) keys.add(key);
  for (const key of Object.keys(readRecord(inputSchema?.properties) ?? {})) keys.add(key);
  for (const key of Object.keys(parameters)) keys.add(key);
  return [...keys];
}

export type ConvergeGenerationParametersOptions = {
  inputSchema?: Record<string, unknown>;
  defaultInput?: Record<string, unknown>;
  /** 面板/批处理给来的参数（可能含空串、隐藏字段、模型身份）。 */
  parameters?: Record<string, unknown> | null;
};

/**
 * 收敛出最终要发给服务端的 `parameters`。
 *
 * 结果保证：
 * - 不含 `model` / `prompt`、不含 undefined/null/空串/NaN；
 * - 已声明且带 enum 的字段一定是 enum 里的合法值（否则回落到默认值，再不行就省略）；
 * - 语义字段（`x-pptask-control`）的「自适应」取值原样保留，不翻译成像素尺寸——那是
 *   服务端按模型家族的解释权。
 * - schema 未声明的键原样保留（清洗后），不丢服务端可能认识的真实参数。
 */
export function convergeGenerationParameters(
  options: ConvergeGenerationParametersOptions
): Record<string, unknown> {
  const inputSchema = readRecord(options.inputSchema) ?? undefined;
  const defaultInput = readRecord(options.defaultInput) ?? undefined;
  const parameters = readRecord(options.parameters) ?? {};

  const out: Record<string, unknown> = {};
  for (const key of candidateKeys(defaultInput, inputSchema, parameters)) {
    if (NON_PARAMETER_KEYS.has(key)) continue;
    const schema = readPropertySchema(inputSchema, key);
    const fallback = defaultOf(key, defaultInput, schema);

    const userValue = Object.hasOwn(parameters, key) ? normalizeParameterValue(parameters[key]) : undefined;
    // 用户清空了字段（空串/空数组）时不能直接用默认值把它「填回来」：那会让「不选」变成
    // 「选了默认」，与面板显示不一致。只有**非法**值（enum 残留）才回落到默认值。
    const userCleared = Object.hasOwn(parameters, key) && userValue === undefined;

    let chosen: unknown;
    if (userValue !== undefined && schema !== undefined) {
      chosen = coerceDeclaredValue(schema, userValue);
      // 用户给了一个「非空但非法」的值（切换模型后残留的旧枚举）：落到默认值，而不是
      // 静默丢弃。丢弃会让上游用模型自己的默认，与面板显示不一致；而「清空」是另一回事，
      // 那表示用户主动不要这个参数，见 userCleared。
      if (chosen === undefined && !userCleared) {
        chosen = normalizeParameterValue(
          fallback !== undefined ? coerceDeclaredValue(schema, fallback) : fallback
        );
      }
    } else if (userValue !== undefined) {
      chosen = userValue;
    } else if (!userCleared) {
      // schema.default 先过一遍类型收敛再清洗：默认值本身也可能是空串/非法枚举。
      chosen = normalizeParameterValue(
        schema !== undefined && fallback !== undefined ? coerceDeclaredValue(schema, fallback) : fallback
      );
    }
    if (chosen !== undefined) out[key] = chosen;
  }
  return out;
}

export type ParameterNormalizeResult = {
  /** 收敛后的参数（永远不含空值）。 */
  parameters: Record<string, unknown>;
  /** 被丢弃的键（诊断用，不含取值；便于回答「为什么这个参数没生效」）。 */
  droppedKeys: string[];
};

/** 同 `convergeGenerationParameters`，额外报告丢弃了哪些键（供日志/测试断言）。 */
export function convergeGenerationParametersWithReport(
  options: ConvergeGenerationParametersOptions
): ParameterNormalizeResult {
  const parameters = convergeGenerationParameters(options);
  const sampled = readRecord(options.parameters) ?? {};
  const inputSchema = readRecord(options.inputSchema) ?? undefined;
  const defaultInput = readRecord(options.defaultInput) ?? undefined;
  const droppedKeys = candidateKeys(defaultInput, inputSchema, sampled).filter(
    (key) => !NON_PARAMETER_KEYS.has(key) && !Object.hasOwn(parameters, key)
  );
  return { parameters, droppedKeys };
}

/**
 * 读取一个语义字段的声明（`x-pptask-control`）。
 *
 * 只给测试与诊断用：真正的渲染在浏览器侧（`web/frontend`），这里不重复实现 UI 语义。
 * 之所以仍导出：单测要证明「服务端下发的语义字段经过解码后仍然可识别」，否则前端拿到的是
 * 一堆普通字符串，参数面板会退回成裸输入框。
 */
export function describeSemanticField(
  inputSchema: Record<string, unknown> | undefined,
  key: string
): { control: string; options: Array<{ value: unknown; adaptive: boolean }>; hiddenWhen: unknown } | undefined {
  const schema = readPropertySchema(inputSchema, key);
  if (schema === undefined) return undefined;
  const control = isPptaskParameterControl(schema[PPTASK_PARAMETER_CONTROL])
    ? (schema[PPTASK_PARAMETER_CONTROL] as string)
    : "plain";
  const options = Array.isArray(schema.enum)
    ? schema.enum.map((entry) => ({
        value: enumValueOf(entry),
        adaptive: readRecord(entry)?.[PPTASK_PARAMETER_ADAPTIVE] === true
      }))
    : [];
  return { control, options, hiddenWhen: schema["x-hidden-when"] };
}

/**
 * 值是否是「自适应」的自适应表达（`x-pptask-adaptive` 标记项或 auto/adaptive 字面量）。
 *
 * 存在的意义是**保留**它：自适应必须原样交给服务端，由服务端决定按参考图/比例算像素尺寸；
 * 客户端自己算一个 `1024x1024` 会把「自适应」悄悄降级成「固定方形」。
 */
export function isAdaptiveParameterValueFor(schema: PropertySchema, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (Array.isArray(schema.enum)) {
    for (const entry of schema.enum) {
      const record = readRecord(entry);
      if (record?.[PPTASK_PARAMETER_ADAPTIVE] === true && record.value === value) return true;
    }
  }
  return isAdaptiveParameterValue(value);
}

/** 比例字段的取值是否有意义（供诊断；非法时仍按 enum/default 收敛，不在这里改写）。 */
export function isAspectRatioParameterValue(value: unknown): boolean {
  return typeof value === "string" && isAspectRatioValue(value);
}
