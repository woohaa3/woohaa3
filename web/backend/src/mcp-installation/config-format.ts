/** 客户端配置的解析、条目形状判定与按格式合并；三种执行器共用。 */
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Document, isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import { InstallationError } from "./errors.js";
import { SERVER_NAME, type McpConfigFormat, type RemoteEntryShape } from "./clients/types.js";

export const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);

const formatError = () => new InstallationError("客户端配置格式有误，请修复后重试；原文件未修改。");

export function parseConfig(text: string, format: McpConfigFormat): Record<string, any> {
  if (!text.trim()) return {};
  try {
    if (format === "toml") {
      const data = parseToml(text);
      if (!record(data)) throw new Error();
      return data;
    }
    if (format === "yaml") {
      const doc = parseDocument(text);
      if (doc.errors.length) throw new Error();
      const data = doc.toJS() ?? {};
      if (!record(data)) throw new Error();
      return data;
    }
    const errors: ParseError[] = [];
    const data = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length || !record(data)) throw new Error();
    return data;
  } catch {
    throw formatError();
  }
}

/** 沿容器键路径取出容器，缺失时返回 undefined；容器形状不对时视为配置损坏。 */
export function containerOf(data: Record<string, any>, shape: RemoteEntryShape): unknown {
  let node: unknown = data;
  for (const key of shape.container) {
    if (!record(node)) throw formatError();
    node = node[key];
    if (node === undefined || node === null) return undefined;
  }
  return node;
}

/** 容器里本应用的同名条目；数组容器按 `name` 字段定位。 */
export function entryOf(data: Record<string, any>, shape: RemoteEntryShape): unknown {
  const container = containerOf(data, shape);
  if (container === undefined) return undefined;
  if (shape.array) {
    if (!Array.isArray(container)) throw formatError();
    return container.find(item => record(item) && item.name === SERVER_NAME);
  }
  if (!record(container)) throw formatError();
  return container[SERVER_NAME];
}

export type EntryState = "missing" | "configured" | "update" | "conflict";

/** 已安装判定与写前冲突判定共用同一份形状，避免读写不一致。 */
export function entryState(data: Record<string, any>, shape: RemoteEntryShape, url: string): EntryState {
  const entry = entryOf(data, shape);
  if (entry === undefined) return "missing";
  if (!record(entry)) return "conflict";
  // 同名本地进程服务（stdio）不得被远程条目覆盖。
  if (entry.command !== undefined || entry.args !== undefined) return "conflict";
  if (shape.remoteMarker && !shape.remoteMarker.values.includes(entry[shape.remoteMarker.field])) return "conflict";
  if (shape.enabledField && entry[shape.enabledField] === false) return "update";
  if (entry[shape.urlField] !== url) return "update";
  return "configured";
}

/** 把本应用条目合并进配置文本，返回新文本；调用方负责原子替换。 */
export function applyEntry(text: string, format: McpConfigFormat, shape: RemoteEntryShape, url: string): string {
  const fields = shape.fields(url);
  if (format === "json" || format === "jsonc") return applyJson(text, shape, fields);
  if (format === "toml") return applyToml(text, shape, fields);
  return applyYaml(text, shape, fields);
}

function applyJson(text: string, shape: RemoteEntryShape, fields: Record<string, unknown>): string {
  let next = text.trim() ? text : "{}\n";
  const data = parseConfig(next, "jsonc");
  const existing = entryOf(data, shape);
  if (shape.array) {
    const container = containerOf(data, shape);
    if (container !== undefined && !Array.isArray(container)) throw formatError();
    const items = (container ?? []) as unknown[];
    const index = items.findIndex(item => record(item) && item.name === SERVER_NAME);
    if (index < 0) return setJson(next, [...shape.container, items.length], { name: SERVER_NAME, ...fields });
    for (const [key, value] of Object.entries(fields)) next = setJson(next, [...shape.container, index, key], value);
    return next;
  }
  if (containerOf(data, shape) !== undefined && !record(containerOf(data, shape)) && existing !== undefined) throw formatError();
  for (const [key, value] of Object.entries(fields)) next = setJson(next, [...shape.container, SERVER_NAME, key], value);
  return next;
}

function setJson(text: string, path: (string | number)[], value: unknown): string {
  return applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
}

function assignContainer(data: Record<string, any>, container: readonly string[], value: unknown) {
  let node: Record<string, any> = data;
  for (const key of container.slice(0, -1)) {
    if (!record(node[key])) node[key] = {};
    node = node[key] as Record<string, any>;
  }
  node[container.at(-1)!] = value;
}

function applyToml(text: string, shape: RemoteEntryShape, fields: Record<string, unknown>): string {
  const data = parseConfig(text, "toml");
  const existing = entryOf(data, shape);
  if (shape.array) {
    const container = containerOf(data, shape);
    if (container !== undefined && !Array.isArray(container)) throw formatError();
    const items = (container ?? []) as Record<string, unknown>[];
    const item = items.find(candidate => record(candidate) && candidate.name === SERVER_NAME);
    if (item) Object.assign(item, fields);
    else {
      items.push({ name: SERVER_NAME, ...fields });
      assignContainer(data, shape.container, items);
    }
  } else {
    const container = containerOf(data, shape);
    if (container !== undefined && !record(container)) throw formatError();
    if (record(existing)) Object.assign(existing, fields);
    else {
      const next = (container as Record<string, unknown> | undefined) ?? {};
      next[SERVER_NAME] = { ...fields };
      if (container === undefined) assignContainer(data, shape.container, next);
    }
  }
  return `${stringifyToml(data)}\n`;
}

function applyYaml(text: string, shape: RemoteEntryShape, fields: Record<string, unknown>): string {
  const doc = text.trim() ? parseDocument(text) : new Document({});
  if (doc.errors.length) throw formatError();
  if (doc.contents == null) doc.contents = doc.createNode({}) as never;
  let node: unknown = doc.contents;
  for (const key of shape.container) {
    if (!isMap(node)) throw formatError();
    let next = node.get(key);
    if (next == null) {
      next = doc.createNode({});
      node.set(key, next);
    }
    node = next;
  }
  if (shape.array) {
    if (!isSeq(node)) throw formatError();
    const seq = node as YAMLSeq;
    let item = seq.items.find(candidate => isMap(candidate) && candidate.get("name") === SERVER_NAME) as YAMLMap | undefined;
    if (!item) {
      item = doc.createNode({ name: SERVER_NAME }) as YAMLMap;
      seq.add(item);
    }
    for (const [key, value] of Object.entries(fields)) item.set(key, value);
  } else {
    if (!isMap(node)) throw formatError();
    let item = node.get(SERVER_NAME);
    if (item == null) {
      item = doc.createNode({});
      node.set(SERVER_NAME, item);
    }
    if (!isMap(item)) throw formatError();
    for (const [key, value] of Object.entries(fields)) item.set(key, value);
  }
  return doc.toString();
}
