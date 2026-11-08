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
  EXTENSION_CONFIG_PREFIX,
  SETTING_DEFINITIONS,
  describeSettings,
  diffSettings,
  extensionToggleKey,
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
/**
 * 扩展启停段的键前缀（`extensions.<id>.enabled`）。
 *
 * 所有扩展共用这一段——不区分 site / host / browser-local：启停就是配置的一部分，
 * 与扩展自己的参数同层同格式。键由扩展目录发现动态产生，不进静态定义表；
 * 写入走 `setExtensionToggle`。
 */
export { EXTENSION_CONFIG_PREFIX };
/** 扩展 ID 形态：与目录名一致，禁止路径分隔符与 `..`（键会落到配置文件路径上）。 */
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 构建期注入的设置项默认值（build profile 的 `settings`）；未注入时为空。 */
declare const __WOOHAA3_SETTING_DEFAULTS__: Readonly<Record<string, unknown>> | undefined;

function buildSettingDefaults(): Readonly<Record<string, SettingPrimitive>> {
  if (typeof __WOOHAA3_SETTING_DEFAULTS__ !== "object" || __WOOHAA3_SETTING_DEFAULTS__ === null) return {};
  const out: Record<string, SettingPrimitive> = {};
  for (const [key, value] of Object.entries(__WOOHAA3_SETTING_DEFAULTS__)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** 设置项默认值：用户配置文件仍优先；这里只替换「没有值时的默认」。 */
function withBuildDefault<T extends { default?: SettingPrimitive }>(
  key: string,
  definition: T,
  defaults: Readonly<Record<string, SettingPrimitive>>
): T {
  return key in defaults ? { ...definition, default: defaults[key] } : definition;
}

export type SettingsServiceOptions = {
  configFile: string;
  secretsFile: string;
  env?: Record<string, string | undefined>;
  /** 监听文件变化自动重载；默认开启。 */
  watch?: boolean;
  debounceMs?: number;
  logger?: (event: Record<string, unknown>) => void;
  /** 构建期注入的设置项默认值；缺省读 `__WOOHAA3_SETTING_DEFAULTS__`（测试可显式传入）。 */
  settingDefaults?: Readonly<Record<string, SettingPrimitive>>;
};

export type SettingsPatch = Record<string, string | number | boolean | null>;

export type SettingsUpdateResult = { ok: true; changed: string[] } | { ok: false; issues: SettingsIssue[] };

export type SettingsSection = Record<string, SettingPrimitive>;

/** 登记一个插件：设置页「插件配置」据此列出宿主插件树里的每个插件。 */
export type SettingsPluginRegistration = {
  modelTypes?: SettingPluginView["modelTypes"];
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
  /**
   * 扩展的启停状态：`extensions.<id>.enabled`（**所有**扩展共用，不区分 site / host）。
   *
   * 这些键按扩展目录发现动态产生，不进静态定义表（静态表要求启动时穷举键），
   * 但和其他配置一样落在同一个配置文件、同样走注释保留写入与热重载。
   * 未出现的 ID 不在结果里（由消费方按 manifest 的 `defaultEnabled` 取默认值）。
   *
   * 只有**进入站点控制面**的扩展（有可激活后端入口）才真正消费这个键；Provider / 存储后端
   * 这类只声明 `hostPlugin` 的插件随宿主装载，配置里给它们写 `enabled` 不产生任何效果
   * （历史迁移可能留下这类键）。manifest 未声明 `defaultEnabled` 时按**停用**取默认。
   */
  extensionToggles(): Record<string, boolean>;
  /** 写一个扩展的启停状态；写入配置文件并触发同一次热重载。 */
  setExtensionToggle(extensionId: string, enabled: boolean): Promise<SettingsUpdateResult>;
  close(): void;
};

/**
 * 配置文件位置：显式环境变量优先，否则从 `cwd` 向上找仓库里的 `web/` 目录。
 *
 * 为什么不能直接 `path.resolve(cwd, "web/woohaa.config.yml")`：进程 cwd 不一定是仓库根
 * （从 `web/backend` 直接启动、或用 `pnpm -C` 跑子包时都会变）。相对解析会在**错误的位置**
 * 新建一份配置文件，而那份文件既不在 .gitignore 覆盖范围内、也不会被真正读取，表现为
 * 「设置写进去了但没生效」。找不到仓库根时退回旧的相对路径行为。
 */
export function resolveSettingsFiles(env: Record<string, string | undefined>, cwd = process.cwd()): { configFile: string; secretsFile: string } {
  const root = repoWebRoot(cwd);
  return {
    configFile: path.resolve(root, env[CONFIG_FILE_ENV] || path.join("web", "woohaa.config.yml")),
    secretsFile: path.resolve(root, env[SECRETS_FILE_ENV] || path.join("web", "woohaa.secrets.yml"))
  };
}

/**
 * 从 `cwd` 向上找到同时含 `web/` 与 `scripts/lib/extension-host.mjs` 的仓库根。
 *
 * 用这两个标记而不是只看 `web/`：子包目录（`web/backend`）自己也可能有同名子目录，
 * 只认 `web/` 会把根定位到错误层级。找不到时返回原 `cwd`（保持旧行为，不强行失败）。
 */
function repoWebRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    const webDir = path.join(dir, "web");
    const hostModule = path.join(dir, "scripts", "lib", "extension-host.mjs");
    if (fs.existsSync(webDir) && fs.existsSync(hostModule)) return dir;
    // The parent repository keeps the public client in a `client` submodule.
    // Backend processes are sometimes started from that parent (for example an
    // isolated review harness), so the ordinary upward walk would otherwise
    // miss `client/web/woohaa.config.yml` and silently fall back to defaults.
    const clientRoot = path.join(dir, "client");
    if (
      fs.existsSync(path.join(clientRoot, "web")) &&
      fs.existsSync(path.join(clientRoot, "scripts", "lib", "extension-host.mjs"))
    ) {
      return clientRoot;
    }
    // 已在 `web/` 内部（`web/backend`）：退到它的父目录再找。
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd);
    dir = parent;
  }
}

type RawLayers = { file: unknown; secrets: unknown };

export async function createSettingsService(options: SettingsServiceOptions): Promise<SettingsService> {
  const log = options.logger ?? (() => undefined);
  const env = options.env ?? {};
  const listeners = new Set<{ keys: readonly string[]; listener: SettingsListener }>();
  const buildDefaults = options.settingDefaults ?? buildSettingDefaults();
  const definitions: Record<string, SettingDefinition> = Object.fromEntries(
    Object.entries(SETTING_DEFINITIONS).map(([key, definition]) => [key, withBuildDefault(key, definition, buildDefaults)])
  );
  /** 插件清单：按登记顺序排列（设置页「插件配置」的展示顺序）。 */
  const pluginRegistry = new Map<string, SettingsPluginRegistration>();

  /**
   * 产品/构建默认里表示「用内置」的 `exposer.primary = local-public` 迁移为自动。
   *
   * 只在来源是 `default` 时迁移：用户文件、密钥层或旧环境变量里的显式 `local-public` 必须
   * 保持手动语义。迁移只改生效值，不重写配置文件；旧键 `storage.expose` 仍按兼容值读取。
   */
  const resolve = (layers: RawLayers): ResolvedSettings => {
    const resolved = resolveSettings({ ...layers, env }, { definitions, unknownKeys: "collect" });
    if (resolved.sources["exposer.primary"] === "default" && resolved.values["exposer.primary"] === "local-public") {
      resolved.values["exposer.primary"] = "auto";
    }
    return resolved;
  };

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
      const key = `${prefix}.${field}`;
      added[key] = withBuildDefault(key, {
        ...definition,
        group,
        ...(ownerExtensionId ? { ownerExtensionId } : {})
      } as SettingDefinition, buildDefaults);
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
        ...(plugin.modelTypes ? { modelTypes: plugin.modelTypes } : {}),
        ...(prefix ? { configPrefix: prefix } : {}),
        settingCount: count,
        siteManaged: plugin.siteManaged ?? false,
        provider: providerIdFromConfigPrefix(prefix) !== null,
        ...(plugin.modelRefresh ? { modelRefresh: plugin.modelRefresh } : {})
      };
    });

  /**
   * 读取 `extensions.<id>.enabled`。
   *
   * 直接从**文件层原文**读：这段是动态键，不进定义表，因此不参与 `resolveSettings` 的
   * 类型校验，也不出现在 `unknownKeys` 里。值不是布尔就当作没配置——由消费方按 manifest
   * 的 `defaultEnabled` 取默认，**缺省为停用**（控制面的取值见 `control-plane.ts`）。
   */
  const extensionToggles = (): Record<string, boolean> => {
    const file = layers.file;
    if (!file || typeof file !== "object" || Array.isArray(file)) return {};
    const extensions = (file as Record<string, unknown>).extensions;
    if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return {};
    const result: Record<string, boolean> = {};
    for (const [extensionId, entry] of Object.entries(extensions)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const enabled = (entry as Record<string, unknown>).enabled;
      if (typeof enabled === "boolean") result[extensionId] = enabled;
    }
    return result;
  };

  /**
   * 写 `extensions.frontend.<id>.enabled`（与普通项同一次串行写入、同样保留注释与顺序）。
   *
   * 不经过 `update()` 的定义表校验路径：这里的键是运行期发现的，写之前只校验 ID 形态。
   */
  const setExtensionToggle = async (extensionId: string, enabled: boolean): Promise<SettingsUpdateResult> => {
    if (!EXTENSION_ID_PATTERN.test(extensionId)) {
      return { ok: false, issues: [{ key: EXTENSION_CONFIG_PREFIX, layer: "file", message: "插件 ID 非法" }] };
    }
    const target = options.configFile;
    const doc = parseDocument(await readText(target));
    if (doc.errors.length > 0) {
      return { ok: false, issues: [{ key: EXTENSION_CONFIG_PREFIX, layer: "file", message: doc.errors[0]!.message }] };
    }
    doc.setIn(["extensions", extensionId, "enabled"], enabled);
    await writeAtomic(target, doc.toString(), 0o644);
    const next = await readLayers();
    if ("issues" in next) return { ok: false, issues: next.issues };
    layers = next.layers;
    const { changed, settled } = apply(next.resolved);
    await settled;
    const key = extensionToggleKey(extensionId);
    // 启停键不属于定义表，`diffSettings` 不会给出它；显式通知订阅者这次写入涉及哪个键。
    log({ event: "extension-toggled", extensionId, enabled });
    return { ok: true, changed: changed.includes(key) ? changed : [...changed, key] };
  };
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
    extensionToggles,
    setExtensionToggle: (extensionId, enabled) => serialize(() => setExtensionToggle(extensionId, enabled)),
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
