/**
 * 后端统一配置服务：读 YAML 配置文件与密钥文件，监听变化并热重载。
 *
 * - 启动时配置非法直接失败；运行中重载非法则保留上一份生效值并记录日志。
 * - `reload: "hot"` 的项变化后立即生效并通知订阅者；`reload: "restart"` 的项保持启动时的值，
 *   新值记入 `pendingRestart`，重启后生效。
 * - 写回时保留文件里的注释与顺序；密钥文件以 0600 权限写入。
 * - 插件用 `register` 声明自己的配置段；还没有插件认领的键先记为未知，不让启动失败。
 *
 * 旧环境变量层只为过渡兼容（见 `@woohaa3/contracts` 的 settings 模块），配置文件才是事实来源。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseDocument, type Document } from "yaml";
import {
  SETTING_DEFINITIONS,
  describeSettings,
  diffSettings,
  legacyEnvInUse,
  providerIdFromConfigPrefix,
  resolveSettings,
  type HostConfigFields,
  type PluginIcon,
  type ResolvedSettings,
  type SettingDefinition,
  type SettingDescription,
  type SettingPluginLayer,
  type SettingPluginView,
  type SettingPrimitive,
  type SettingsIssue,
  type SettingsListener,
  type SettingsReader,
  type SettingsValues
} from "@woohaa3/contracts";

export const CONFIG_FILE_ENV = "WOOHAA3_CONFIG_FILE";
export const SECRETS_FILE_ENV = "WOOHAA3_SECRETS_FILE";

export type SettingsServiceOptions = {
  configFile: string;
  secretsFile: string;
  env?: Record<string, string | undefined>;
  /** 监听文件变化自动重载；默认开启。 */
  watch?: boolean;
  debounceMs?: number;
  logger?: (event: Record<string, unknown>) => void;
};

export type SettingsPatch = Record<string, string | number | boolean | null>;

export type SettingsUpdateResult = { ok: true; changed: string[] } | { ok: false; issues: SettingsIssue[] };

export type SettingsSection = Record<string, SettingPrimitive>;

/** 登记一个插件：设置页「插件配置」据此列出宿主插件树里的每个插件。 */
export type SettingsPluginRegistration = {
  /** 宿主扫描到的插件绝对目录，仅用于展示。 */
  directory?: string;
  id: string;
  label: string;
  description?: string;
  layer: SettingPluginLayer;
  /** 设置页插件卡片上的图标：语义图形名或品牌图形路径；缺省显示通用插件图标。 */
  icon?: PluginIcon;
  /** 声明配置段的键前缀（`providers.ark`、`storage.local`）；没有可配置项的插件缺省。 */
  configPrefix?: string;
  /** 站点插件：可由站点插件服务启停。 */
  siteManaged?: boolean;
  /** 插件声明的模型目录刷新入口（路径由插件自己注册）；设置面只透传。 */
  modelRefresh?: { path: string; hint: string };
};

export type SettingsService = SettingsReader & {
  readonly configFile: string;
  readonly secretsFile: string;
  /** 设置面用：每项的来源、锁定状态与是否等待重启（敏感项不回显）。 */
  describe(): Array<SettingDescription & { pendingRestart: boolean }>;
  /** 登记一个插件（设置页「插件配置」的清单来源）：宿主三层插件树与扩展都走这里。返回注销函数。 */
  registerPlugin(plugin: SettingsPluginRegistration): () => void;
  /** 当前插件树；`settingCount` 按已登记的定义表统计，「插件配置」据此显示每个插件有几项可配置。 */
  plugins(): SettingPluginView[];
  pendingRestart(): string[];
  /** 配置文件里没有任何定义认领的键。 */
  unknownKeys(): string[];
  /**
   * 声明一段配置：`fields` 的键挂在 `prefix.` 下，`group` 是设置页分组名，
   * `ownerExtensionId` 是声明这段配置的扩展（设置面据此把启停放到配置旁边）。
   * 现有值不合法时抛错且不登记；返回注销函数。
   */
  register(prefix: string, fields: HostConfigFields, group: string, ownerExtensionId?: string): () => void;
  /** 某段配置的生效值，键去掉 `prefix.`。 */
  section(prefix: string): SettingsSection;
  reload(): Promise<SettingsUpdateResult>;
  /** 写配置项（普通项写配置文件、敏感项写密钥文件）；`null` 表示删除该项。 */
  update(patch: SettingsPatch): Promise<SettingsUpdateResult>;
  close(): void;
};

/** 配置文件位置：显式环境变量优先，否则放在 `web/` 下（已被 .gitignore 忽略）。 */
export function resolveSettingsFiles(env: Record<string, string | undefined>, cwd = process.cwd()): { configFile: string; secretsFile: string } {
  return {
    configFile: path.resolve(cwd, env[CONFIG_FILE_ENV] || "web/woohaa.config.yml"),
    secretsFile: path.resolve(cwd, env[SECRETS_FILE_ENV] || "web/woohaa.secrets.yml")
  };
}

type RawLayers = { file: unknown; secrets: unknown };

export async function createSettingsService(options: SettingsServiceOptions): Promise<SettingsService> {
  const log = options.logger ?? (() => undefined);
  const env = options.env ?? {};
  const listeners = new Set<{ keys: readonly string[]; listener: SettingsListener }>();
  const definitions: Record<string, SettingDefinition> = { ...SETTING_DEFINITIONS };
  /** 插件清单：按登记顺序排列（设置页「插件配置」的展示顺序）。 */
  const pluginRegistry = new Map<string, SettingsPluginRegistration>();

  const resolve = (layers: RawLayers): ResolvedSettings =>
    resolveSettings({ ...layers, env }, { definitions, unknownKeys: "collect" });

  const readLayers = async (): Promise<{ layers: RawLayers; resolved: ResolvedSettings } | { issues: SettingsIssue[] }> => {
    const file = await readYaml(options.configFile, "file");
    if ("issues" in file) return file;
    const secrets = await readYaml(options.secretsFile, "secrets");
    if ("issues" in secrets) return secrets;
    const layers = { file: file.value, secrets: secrets.value };
    const resolved = resolve(layers);
    return resolved.issues.length > 0 ? { issues: resolved.issues } : { layers, resolved };
  };

  const warnLegacyEnv = (resolved: ResolvedSettings, table: Readonly<Record<string, SettingDefinition>>) => {
    for (const { key, env: name } of legacyEnvInUse(resolved, table)) {
      log({ event: "settings-legacy-env", key, env: name, message: `${name} 仅为过渡兼容，请迁移到配置文件的 ${key}` });
    }
  };

  const initial = await readLayers();
  if ("issues" in initial) {
    throw new Error(`配置无效：${formatIssues(initial.issues)}`);
  }
  warnLegacyEnv(initial.resolved, definitions);

  let layers: RawLayers = initial.layers;
  /** 进程实际在用的值：hot 项随重载更新，restart 项保持启动时（或插件登记时）的值。 */
  let active: SettingsValues = { ...initial.resolved.values };
  let latest: ResolvedSettings = initial.resolved;

  const apply = (next: ResolvedSettings): { changed: string[]; settled: Promise<unknown> } => {
    latest = next;
    const merged: Record<string, unknown> = { ...active };
    for (const [key, definition] of Object.entries(definitions)) {
      if (definition.reload === "hot") merged[key] = next.values[key];
    }
    const changed = diffSettings(active, merged as SettingsValues);
    active = merged as SettingsValues;
    if (changed.length > 0) log({ event: "settings-reloaded", changed });
    const pending = pendingRestart();
    if (pending.length > 0) log({ event: "settings-pending-restart", keys: pending });
    const failed = (keys: readonly string[]) => (error: unknown) =>
      log({ event: "settings-listener-failed", keys, message: error instanceof Error ? error.message : String(error) });
    const running: Promise<void>[] = [];
    for (const entry of [...listeners]) {
      const relevant = changed.filter((key) => entry.keys.includes(key));
      if (relevant.length === 0) continue;
      try {
        const result = entry.listener(relevant);
        if (result) running.push(result.catch(failed(relevant)));
      } catch (error) {
        failed(relevant)(error);
      }
    }
    return { changed, settled: Promise.all(running) };
  };

  const pendingRestart = (): string[] =>
    Object.entries(definitions)
      .filter(([key, definition]) => definition.reload === "restart" && latest.values[key] !== active[key])
      .map(([key]) => key);

  const register: SettingsService["register"] = (prefix, fields, group, ownerExtensionId) => {
    const keys = Object.keys(fields).map((field) => `${prefix}.${field}`);
    const taken = keys.filter((key) => key in definitions);
    if (taken.length > 0) throw new Error(`配置项已被声明：${taken.join("、")}`);
    const added: Record<string, SettingDefinition> = {};
    for (const [field, definition] of Object.entries(fields)) {
      added[`${prefix}.${field}`] = {
        ...definition,
        group,
        ...(ownerExtensionId ? { ownerExtensionId } : {})
      } as SettingDefinition;
    }
    Object.assign(definitions, added);
    const next = resolve(layers);
    const own = next.issues.filter((issue) => keys.includes(issue.key));
    if (own.length > 0) {
      for (const key of keys) delete definitions[key];
      throw new Error(`${group} 配置无效：${formatIssues(own)}`);
    }
    warnLegacyEnv(next, added);
    latest = next;
    const values: Record<string, unknown> = { ...active };
    for (const key of keys) values[key] = next.values[key];
    active = values as SettingsValues;
    return () => {
      for (const key of keys) delete definitions[key];
      const remaining: Record<string, unknown> = { ...active };
      for (const key of keys) delete remaining[key];
      active = remaining as SettingsValues;
      latest = resolve(layers);
    };
  };

  const registerPlugin: SettingsService["registerPlugin"] = (plugin) => {
    pluginRegistry.set(plugin.id, plugin);
    return () => {
      // 扩展重启会重新登记；只有当前登记的还是自己时才注销，免得误删后来者。
      if (pluginRegistry.get(plugin.id) === plugin) pluginRegistry.delete(plugin.id);
    };
  };

  const plugins = (): SettingPluginView[] =>
    [...pluginRegistry.values()].map((plugin) => {
      const prefix = plugin.configPrefix;
      const count = prefix ? Object.keys(definitions).filter((key) => key === prefix || key.startsWith(`${prefix}.`)).length : 0;
      return {
        id: plugin.id,
        label: plugin.label,
        description: plugin.description ?? "",
        layer: plugin.layer,
        ...(plugin.directory ? { directory: plugin.directory } : {}),
        ...(plugin.icon ? { icon: plugin.icon } : {}),
        ...(prefix ? { configPrefix: prefix } : {}),
        settingCount: count,
        siteManaged: plugin.siteManaged ?? false,
        provider: providerIdFromConfigPrefix(prefix) !== null,
        ...(plugin.modelRefresh ? { modelRefresh: plugin.modelRefresh } : {})
      };
    });

  const section = (prefix: string): SettingsSection => {
    const result: SettingsSection = {};
    const head = `${prefix}.`;
    for (const key of Object.keys(definitions)) {
      const value = active[key];
      if (key.startsWith(head) && value !== undefined) result[key.slice(head.length)] = value;
    }
    return result;
  };

  const reload = async (): Promise<SettingsUpdateResult> => {
    const next = await readLayers();
    if ("issues" in next) {
      log({ event: "settings-reload-rejected", message: formatIssues(next.issues) });
      return { ok: false, issues: next.issues };
    }
    layers = next.layers;
    const { changed, settled } = apply(next.resolved);
    await settled;
    return { ok: true, changed };
  };

  // 写入与重载串行，避免监听回调读到写了一半的文件。
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  };

  const update = async (patch: SettingsPatch): Promise<SettingsUpdateResult> => {
    const issues: SettingsIssue[] = [];
    const byLayer: Record<"file" | "secrets", Array<[string, string | number | boolean | null]>> = { file: [], secrets: [] };
    for (const [key, value] of Object.entries(patch)) {
      const definition = definitions[key];
      if (!definition) {
        issues.push({ key, layer: "file", message: "未知配置项" });
        continue;
      }
      const layer = definition.secret ? "secrets" : "file";
      if (latest.sources[key] === "env") {
        issues.push({ key, layer, message: `由环境变量 ${definition.legacyEnv} 锁定，先移除该环境变量` });
        continue;
      }
      byLayer[layer].push([key, value === undefined ? null : value]);
    }
    if (issues.length > 0) return { ok: false, issues };

    const docs: Partial<Record<"file" | "secrets", Document>> = {};
    for (const layer of ["file", "secrets"] as const) {
      if (byLayer[layer].length === 0) continue;
      const target = layer === "file" ? options.configFile : options.secretsFile;
      const doc = parseDocument(await readText(target));
      if (doc.errors.length > 0) return { ok: false, issues: [{ key: "", layer, message: doc.errors[0]!.message }] };
      for (const [key, value] of byLayer[layer]) {
        if (value === null) doc.deleteIn(key.split("."));
        else doc.setIn(key.split("."), value);
      }
      docs[layer] = doc;
    }
    const nextLayers: RawLayers = {
      file: docs.file ? docs.file.toJS() : (await readYaml(options.configFile, "file") as { value?: unknown }).value,
      secrets: docs.secrets ? docs.secrets.toJS() : (await readYaml(options.secretsFile, "secrets") as { value?: unknown }).value
    };
    const candidate = resolve(nextLayers);
    if (candidate.issues.length > 0) return { ok: false, issues: candidate.issues };

    if (docs.file) await writeAtomic(options.configFile, docs.file.toString(), 0o644);
    if (docs.secrets) await writeAtomic(options.secretsFile, docs.secrets.toString(), 0o600);
    layers = nextLayers;
    const { changed, settled } = apply(candidate);
    await settled;
    return { ok: true, changed };
  };

  let watchers: fs.FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | null = null;
  if (options.watch ?? true) {
    const targets = new Map<string, Set<string>>();
    for (const file of [options.configFile, options.secretsFile]) {
      const dir = path.dirname(file);
      if (!targets.has(dir)) targets.set(dir, new Set());
      targets.get(dir)!.add(path.basename(file));
    }
    for (const [dir, names] of targets) {
      try {
        // 监听目录而不是文件：编辑器常用「写临时文件再改名」保存，文件句柄会失效。
        watchers.push(fs.watch(dir, (_event, filename) => {
          if (filename && !names.has(filename.toString())) return;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            debounce = null;
            void serialize(reload);
          }, options.debounceMs ?? 100);
        }));
      } catch (error) {
        log({ event: "settings-watch-unavailable", dir, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return {
    configFile: options.configFile,
    secretsFile: options.secretsFile,
    get: (key) => active[key] as never,
    subscribe(keys, listener) {
      const entry = { keys, listener };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    describe: () => {
      const pending = new Set(pendingRestart());
      return describeSettings(latest, definitions).map((entry) => ({
        ...entry,
        pendingRestart: pending.has(entry.key)
      }));
    },
    pendingRestart,
    unknownKeys: () => latest.unknown,
    register,
    registerPlugin,
    plugins,
    section,
    reload: () => serialize(reload),
    update: (patch) => serialize(() => update(patch)),
    close() {
      if (debounce) clearTimeout(debounce);
      for (const watcher of watchers) watcher.close();
      watchers = [];
      listeners.clear();
    }
  };
}

async function readText(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function readYaml(file: string, layer: "file" | "secrets"): Promise<{ value: unknown } | { issues: SettingsIssue[] }> {
  let text: string;
  try {
    text = await readText(file);
  } catch (error) {
    return { issues: [{ key: "", layer, message: `无法读取 ${file}：${error instanceof Error ? error.message : String(error)}` }] };
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    return { issues: [{ key: "", layer, message: `${file}：${doc.errors[0]!.message}` }] };
  }
  return { value: doc.toJS() ?? undefined };
}

async function writeAtomic(file: string, text: string, mode: number): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, text, { mode });
  await fsp.chmod(temp, mode);
  await fsp.rename(temp, file);
}

function formatIssues(issues: readonly SettingsIssue[]): string {
  return issues.map((issue) => `[${issue.layer}] ${issue.key || "(根)"}：${issue.message}`).join("；");
}
