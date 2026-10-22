/**
 * DeepSeek Harness 的 `cordis.patch.yml` 插件实例读写。
 *
 * DSH 把该文件当作「顶层 loader patch 数组」：每个 patch 可以带 `insert` 列表，
 * 实例就写在某个 patch 的 `insert` 里（见 `@deepseek-ai/dsh-app-boot` 的 applyEntryPatches）。
 * 为兼容按旧设计文档写出的 `insert:` 映射形态，读取与更新也接受顶层映射。
 */
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import { InstallationError } from "./errors.js";
import type { EntryState } from "./config-format.js";
import { SERVER_NAME } from "./clients/types.js";

export const DSH_PLUGIN = "@deepseek-ai/dsh-mcp-client";
export const DSH_TRANSPORT = "streamable-http";

const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const formatError = () => new InstallationError("客户端配置格式有误，请修复后重试；原文件未修改。");

/** 解析 patch 文件；空文件按空数组处理。 */
export function parsePluginPatch(text: string): unknown {
  if (!text.trim()) return [];
  const doc = parseDocument(text);
  if (doc.errors.length) throw formatError();
  return doc.toJS() ?? [];
}

/** 所有 patch 的 `insert` 项（顶层数组形态）或顶层 `insert` 项（映射形态）。 */
function inserted(root: unknown): unknown[] {
  if (Array.isArray(root)) return root.flatMap(patch => record(patch) && Array.isArray(patch.insert) ? patch.insert : []);
  if (record(root) && root.insert !== undefined) {
    if (!Array.isArray(root.insert)) throw formatError();
    return root.insert;
  }
  return [];
}

const instance = (item: unknown) => record(item) && record(item.config) ? item.config : null;

/** 同名项不是 streamable-http（例如 stdio）时报冲突，不覆盖。 */
export function pluginPatchState(root: unknown, url: string): EntryState {
  if (root !== null && typeof root === "object" && !Array.isArray(root) && !record(root)) return "conflict";
  const items = inserted(root);
  const found = items.find(item => instance(item)?.serverName === SERVER_NAME);
  if (found === undefined) return "missing";
  const config = instance(found)!;
  if (config.transport !== DSH_TRANSPORT) return "conflict";
  return config.url === url ? "configured" : "update";
}

function instanceNode(doc: ReturnType<typeof parseDocument>, serverName: string): YAMLMap | undefined {
  const visits: YAMLSeq[] = [];
  const root = doc.contents;
  if (isSeq(root)) {
    for (const patch of root.items) if (isMap(patch) && isSeq(patch.get("insert"))) visits.push(patch.get("insert") as YAMLSeq);
  } else if (isMap(root) && isSeq(root.get("insert"))) visits.push(root.get("insert") as YAMLSeq);
  for (const seq of visits) {
    const found = seq.items.find(item => isMap(item) && isMap(item.get("config")) && (item.get("config") as YAMLMap).get("serverName") === serverName) as YAMLMap | undefined;
    if (found) return found;
  }
  return undefined;
}

/** 保留其余 patch 项与注释；已存在则只更新地址字段。 */
export function applyPluginPatch(text: string, url: string, plugin = DSH_PLUGIN): string {
  const doc = parseDocument(text.trim() ? text : "[]\n");
  if (doc.errors.length) throw formatError();
  const existing = doc.contents == null ? undefined : instanceNode(doc, SERVER_NAME);
  if (existing) {
    (existing.get("config") as YAMLMap).set("url", url);
    return doc.toString();
  }
  const entry = doc.createNode({
    id: SERVER_NAME,
    name: plugin,
    config: { serverName: SERVER_NAME, transport: DSH_TRANSPORT, url }
  });
  const root = doc.contents;
  if (isMap(root) && root.has("insert")) {
    const insert = root.get("insert");
    if (!isSeq(insert)) throw formatError();
    (insert as YAMLSeq).add(entry);
  } else if (isMap(root) && root.items.length > 0) {
    throw formatError();
  } else {
    if (!isSeq(root)) doc.contents = doc.createNode([]) as never;
    const seq = doc.contents as YAMLSeq;
    // 与 DSH 自己的配置编辑器一致：追加后按块状风格输出，空文件 `[]` 也会展开。
    seq.flow = false;
    // 优先追加到已有 patch 的 insert，保持文件里的分层结构不被拆散。
    const holder = seq.items.find(item => isMap(item) && isSeq(item.get("insert"))) as YAMLMap | undefined;
    if (holder) (holder.get("insert") as YAMLSeq).add(entry);
    else seq.add(doc.createNode({ insert: [entry] }));
  }
  return doc.toString();
}
