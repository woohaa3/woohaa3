/**
 * 角色输入/上下文的最小 JSON schema 校验（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 项目已有 `task/schema-validation` 与画布 schema 工具，但角色定义使用的是**插件可序列化
 * schema**（`Record<string, unknown>`），这里只实现角色准备需要的子集：type/properties/
 * required/additionalProperties/items/enum/const/min/max 与字符串长度。未识别的关键字被忽略
 * （宽松于未知关键字，严格于实际值），避免角色插件被迫依赖某个验证框架。
 */
import { isJsonObject } from "../../validation.js";
import type { AgentRoleJsonSchema } from "./agent-role.js";

export type AgentRoleSchemaViolation = { path: string; message: string };

const SUPPORTED_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object": return isJsonObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

function join(path: string, key: string | number): string {
  return typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;
}

/**
 * 校验值符合 schema；返回第一条违规（不累加全部错误，错误信息保持有界）。
 *
 * `strictTypes` 为 true 时，schema 里出现不支持的 `type` 会直接失败，避免角色声明看似严格
 * 实际被静默忽略。
 */
export function validateAgentRoleValue(
  schema: AgentRoleJsonSchema,
  value: unknown,
  options: { path?: string; strictTypes?: boolean } = {}
): AgentRoleSchemaViolation | null {
  return validate(schema, value, options.path ?? "", options.strictTypes ?? true);
}

function validate(schema: AgentRoleJsonSchema, value: unknown, path: string, strictTypes: boolean): AgentRoleSchemaViolation | null {
  const at = path === "" ? "(root)" : path;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    return { path: at, message: `必须是固定值 ${JSON.stringify(schema.const)}` };
  }
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
      return { path: at, message: `必须是 ${allowed.map((entry) => JSON.stringify(entry)).join(" / ")} 之一` };
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.every((entry) => typeof entry === "string")) return { path: at, message: "schema type 非法" };
    if (strictTypes && types.some((entry) => !SUPPORTED_TYPES.has(entry as string))) {
      return { path: at, message: `不支持的 schema 类型：${String(types.find((entry) => !SUPPORTED_TYPES.has(entry as string)))}` };
    }
    if (!types.some((entry) => typeMatches(entry as string, value))) {
      return { path: at, message: `必须是 ${types.join(" | ")}` };
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((entry) => isJsonObject(entry) && validate(entry as AgentRoleJsonSchema, value, path, strictTypes) === null);
    if (!matched) return { path: at, message: "不满足任一允许形态" };
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return { path: at, message: `长度不能少于 ${schema.minLength}` };
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return { path: at, message: `长度不能超过 ${schema.maxLength}` };
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) return { path: at, message: `不匹配 ${schema.pattern}` };
      } catch {
        return { path: at, message: "schema pattern 非法" };
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return { path: at, message: `不能小于 ${schema.minimum}` };
    if (typeof schema.maximum === "number" && value > schema.maximum) return { path: at, message: `不能大于 ${schema.maximum}` };
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return { path: at, message: `至少 ${schema.minItems} 项` };
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return { path: at, message: `最多 ${schema.maxItems} 项` };
    if (isJsonObject(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const violation = validate(schema.items as AgentRoleJsonSchema, value[index], join(path, index), strictTypes);
        if (violation) return violation;
      }
    }
  }
  if (isJsonObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) return { path: join(path, key), message: "缺少必需字段" };
    }
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      if (!isJsonObject(child)) return { path: join(path, key), message: "schema properties 项非法" };
      const violation = validate(child as AgentRoleJsonSchema, value[key], join(path, key), strictTypes);
      if (violation) return violation;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (extra) return { path: join(path, extra), message: "不允许的额外字段" };
    }
  }
  return null;
}
