/**
 * 受限 JSON Schema 校验
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 3.4 / design D4）。
 *
 * 校验模型参数对照 catalog 声明的 `inputSchema`：required、enum、type、数值/字符串边界、数组上限。
 * 只支持受控子集；未知关键字忽略，运行时控制字段（providerOptions/endpoint/凭据）不得由浏览器提供。
 *
 * 纯函数、无副作用、不依赖任何 SDK。
 */

export type RestrictedSchema = Record<string, unknown>;

export type SchemaValidationError = {
  path: string;
  message: string;
};

export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; errors: SchemaValidationError[] };

/** 浏览器不得提供的运行时控制字段。 */
const RESERVED_KEYS = new Set(["providerOptions", "providerMetadata", "endpoint", "baseURL", "apiKey", "secretRef", "secretRefs"]);

/**
 * 校验 `value` 是否符合受限 schema。
 *
 * - `type`：string/number/integer/boolean/array/object；
 * - `required`（object）：必填字段；
 * - `enum`：取值枚举；
 * - `minimum`/`maximum`：数值边界；
 * - `minLength`/`maxLength`：字符串长度；
 * - `maxItems`：数组上限；
 * - 顶层对象拒绝保留字段。
 */
export function validateAgainstSchema(
  value: unknown,
  schema: RestrictedSchema | undefined
): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  if (schema && typeof schema === "object") {
    validateNode(value, schema, "", errors);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateNode(value: unknown, schema: RestrictedSchema, path: string, errors: SchemaValidationError[]): void {
  const type = schema.type;
  if (typeof type === "string" && !matchesType(value, type)) {
    errors.push({ path: path || "(root)", message: `期望类型 ${type}` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => enumMatches(candidate, value))) {
    errors.push({ path: path || "(root)", message: "不在允许的枚举内" });
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `小于最小值 ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `大于最大值 ${schema.maximum}` });
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({ path, message: `长度小于 ${schema.minLength}` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push({ path, message: `长度大于 ${schema.maxLength}` });
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push({ path, message: `数组超过上限 ${schema.maxItems}` });
    }
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      value.forEach((entry, index) =>
        validateNode(entry, items as RestrictedSchema, `${path}[${index}]`, errors)
      );
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
    for (const key of required) {
      if (value[key] === undefined) errors.push({ path: key, message: "缺少必填字段" });
    }
    for (const [key, nested] of Object.entries(value)) {
      if (path === "" && RESERVED_KEYS.has(key)) {
        errors.push({ path: key, message: "不允许的运行时控制字段" });
        continue;
      }
      const nestedSchema = properties[key];
      if (nestedSchema && typeof nestedSchema === "object" && !Array.isArray(nestedSchema)) {
        validateNode(nested, nestedSchema as RestrictedSchema, path ? `${path}.${key}` : key, errors);
      }
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 枚举项匹配：支持裸值与 `{ value, label }` 形式。 */
function enumMatches(candidate: unknown, value: unknown): boolean {
  if (deepEqual(candidate, value)) return true;
  if (isObject(candidate) && "value" in candidate) return deepEqual(candidate.value, value);
  return false;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}
