/**
 * 属性列的 SQL 读取口径（change: 2026-10-25-enhance-telemetry-performance-collection，design D5）。
 *
 * 属性以 JSON 存在单列里（不列化成表列）：键集合会随事件名扩展，列化每次都要迁移表结构；
 * 而键集合本身是封闭枚举，基数和长度都有界，所以「JSON 提取 + 表达式索引」是这里的常规做法。
 *
 * 三条口径：
 * - **值一律按文本比较**：数值属性按十进制文本、布尔按 `"true"`/`"false"`。这样筛选与分组
 *   只有一种比较语义，界面上的 `?mode=dev` 与 `?fps=59.5` 走同一条语句；
 * - **坏行不炸整页**：`json_valid` 不成立时表达式求值为 `NULL`，坏行既不匹配筛选也不进分组；
 * - **索引是部分索引**：只索引真正带该键的行。全量索引会给每条空属性行也建 22 个条目，
 *   写放大在本机 flusher 上不值得（实测 2 万行插入 20ms → 210ms）；部分索引只多约 5 倍。
 *
 * 为什么查询里还要多写一个 `IS NOT NULL`：SQLite 只在 WHERE 蕴含索引谓词时才会用部分索引，
 * `expr = ?` 不足以让它相信 `expr IS NOT NULL`，必须显式写出。多这一个条件不改变结果
 * （`NULL = ?` 本来就为假），只让计划器选到索引。
 */
import { TELEMETRY_ATTRIBUTE_KEYS, type TelemetryAttributeKey } from "@woohaa3/contracts";

const ATTRIBUTE_KEY_SET: ReadonlySet<string> = new Set(TELEMETRY_ATTRIBUTE_KEYS);

/**
 * 一个属性键在 SQL 里的文本取值表达式。
 *
 * `json_type` 分支而不是直接 `CAST(json_extract(...))`：SQLite 的 `CAST(1 AS TEXT)` 会给出
 * `"1"`，与 `normalizeAttributeValue` 写入的数字文本一致；但布尔值在 JSON 里是 `true`/`false`，
 * 必须单独映射，否则 `CAST` 会把它们变成 `"1"`/`"0"`，与界面上的 `true` 对不上。
 */
export function attributeValueSql(key: TelemetryAttributeKey): string {
  assertAttributeKey(key);
  const path = `'$.${key}'`;
  return (
    `(CASE WHEN json_valid(attributes) THEN CASE json_type(attributes, ${path}) ` +
    `WHEN 'text' THEN json_extract(attributes, ${path}) ` +
    `WHEN 'integer' THEN CAST(json_extract(attributes, ${path}) AS TEXT) ` +
    `WHEN 'real' THEN CAST(json_extract(attributes, ${path}) AS TEXT) ` +
    `WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' END END)`
  );
}

/** 属性键存在性谓词（部分索引的谓词，也用于让计划器选到索引）。 */
export function attributePresentSql(key: TelemetryAttributeKey): string {
  return `${attributeValueSql(key)} IS NOT NULL`;
}

/** 一个属性键的表达式索引 DDL；同一个库上重复执行是 no-op（`IF NOT EXISTS`）。 */
export function attributeIndexSql(table: string, key: TelemetryAttributeKey): string {
  return `CREATE INDEX IF NOT EXISTS idx_cte_attr_${key} ON ${table} ${attributeValueSql(key)} WHERE ${attributePresentSql(key)};`;
}

/**
 * 属性列的读写。
 *
 * 落库内容由本包写入，理论上总是合法；但文件可能被手工改坏，一条坏行不该让整页查询失败，
 * 所以解析失败按「没有属性」处理（与 SQL 侧的 `json_valid` 守卫一致）。
 */
export function serializeAttributes(
  attributes: Readonly<Record<string, string | number | boolean>> | undefined
): string {
  return attributes === undefined || Object.keys(attributes).length === 0 ? "{}" : JSON.stringify(attributes);
}

export function parseAttributes(raw: string): Record<string, string | number | boolean> | undefined {
  if (raw === "" || raw === "{}") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean"
    );
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

/** 键名会拼进 SQL：即使调用方已按契约校验，这里再拒一次未知键（拼错的键比查询慢可怕得多）。 */
function assertAttributeKey(key: string): void {
  if (!ATTRIBUTE_KEY_SET.has(key)) throw new Error(`未知的遥测属性键：${key}`);
}
