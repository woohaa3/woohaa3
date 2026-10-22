/** 本机 MCP 安装：按声明式注册表检测客户端并写入其用户级配置。不接收浏览器提供的路径或命令。 */
import { access, constants, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { McpInstallClient, McpInstallClientId, McpInstallTarget } from "@woohaa3/contracts";
import { InstallationError } from "./errors.js";
import { applyEntry, entryState, parseConfig } from "./config-format.js";
import { applyPluginPatch, parsePluginPatch, pluginPatchState } from "./plugin-patch.js";
import { MCP_CLIENT_REGISTRY, findClient } from "./clients/registry.js";
import type { InstallTarget, McpClientSpec, SpecContext } from "./clients/types.js";

export { InstallationError };
export type McpInstallerOptions = {
  env?: NodeJS.ProcessEnv;
  /** macOS 应用安装目录；测试可指向临时目录。 */
  applicationsDir?: string;
  /** 任意客户端的官方 MCP 命令执行器；默认 execFile（不经 shell）。 */
  runCommand?: CommandRunner;
  /** 按客户端覆盖命令执行器（测试桩）。 */
  commandRunners?: Partial<Record<McpInstallClientId, CommandRunner>>;
  /** @deprecated 兼容旧调用方的 Codex 专用执行器，等价于 commandRunners.codex。 */
  runCodex?: CommandRunner;
};

export type CommandRunner = (executable: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;

const defaultRunner = async (executable: string, args: string[], env: NodeJS.ProcessEnv) => {
  try {
    await promisify(execFile)(executable, args, { env, timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true });
  } catch { throw new InstallationError("客户端命令未能保存配置，请检查配置格式及文件权限后重试。"); }
};

export function createMcpInstaller(options: McpInstallerOptions = {}) {
  const env = options.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || homedir();
  const platform = process.platform;
  const exists = (file: string) => access(file).then(() => true, () => false);
  const applicationsDir = options.applicationsDir ?? "/Applications";
  const ctx = (): SpecContext => ({ env, home, platform, applicationsDir, exists });
  const runCommand = options.runCommand ?? defaultRunner;
  const commandRunners: Partial<Record<McpInstallClientId, CommandRunner>> = { ...options.commandRunners, ...(options.runCodex ? { codex: options.runCodex } : {}) };

  async function executable(names: readonly string[]) {
    const candidates = platform === "win32" ? names.flatMap(name => [`${name}.exe`, `${name}.cmd`, name]) : [...names];
    for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
      for (const name of candidates) {
        const file = path.join(dir, name);
        if (await access(file, constants.X_OK).then(() => true, () => false)) return file;
      }
    }
    return null;
  }

  /** 检测证据是「或」关系；只读，不创建目录或文件，也不执行客户端命令。 */
  async function detected(spec: McpClientSpec) {
    for (const evidence of spec.detect) {
      if (evidence.kind === "executable" && await executable(evidence.names)) return true;
      if (evidence.kind === "file") {
        for (const file of await evidence.paths(ctx())) if (await exists(file)) return true;
      }
      if (evidence.kind === "app" && platform === "darwin") {
        for (const name of evidence.names) if (await exists(path.join(applicationsDir, `${name}.app`))) return true;
      }
      if (evidence.kind === "targets") {
        for (const item of await spec.targets(ctx())) if (await exists(item.path)) return true;
      }
    }
    return false;
  }

  /** 插件类客户端按 patch 里的插件实例判定，其余按声明的远程条目形状判定。 */
  const stateOf = (spec: McpClientSpec, root: unknown, url: string) =>
    spec.writer.kind === "plugin-patch" ? pluginPatchState(root, url) : entryState(root as Record<string, any>, spec.entry, url);

  /** 插件 patch 是顶层数组，与常规配置对象的解析入口不同。 */
  const parseTarget = (spec: McpClientSpec, text: string, format: InstallTarget["format"]) =>
    spec.writer.kind === "plugin-patch" ? parsePluginPatch(text) : parseConfig(text, format);

  async function inspectTarget(spec: McpClientSpec, target: InstallTarget, url: string): Promise<McpInstallTarget> {
    const skeleton = { key: target.key, label: target.label, path: target.path, configured: false };
    try {
      const text = await readFile(target.path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      return { ...skeleton, configured: stateOf(spec, parseTarget(spec, text, target.format), url) === "configured" };
    } catch (error) {
      return { ...skeleton, error: error instanceof InstallationError ? error.message : "无法读取客户端配置，请检查文件权限后重试。" };
    }
  }

  async function inspect(spec: McpClientSpec, url: string): Promise<McpInstallClient> {
    const targets = await Promise.all((await spec.targets(ctx())).map(item => inspectTarget(spec, item, url)));
    const first = targets[0];
    return {
      id: spec.id,
      label: spec.label,
      group: spec.group,
      configPath: first?.path ?? "",
      configured: first?.configured ?? false,
      ...(first?.error ? { error: first.error } : {}),
      targets
    };
  }

  /** 目标文件解析符号链接；文件不存在时保留原路径。 */
  const resolveTarget = (file: string) => realpath(file).catch(error => {
    if (error.code === "ENOENT") return file;
    throw error;
  });

  async function readTarget(spec: McpClientSpec, target: InstallTarget) {
    const text = await readFile(target.path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    return { text, data: parseTarget(spec, text, target.format) };
  }

  /** 共享安全机制：安装锁 + 写前重读比对 + 临时文件原子替换。 */
  async function withLock<T>(file: string, run: () => Promise<T>) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(`${file}.woohaa-install.lock`, "wx", 0o600).catch(() => { throw new InstallationError("客户端配置正在写入或目录不可写，请稍后重试。"); });
    try { return await run(); }
    finally { await handle.close(); await rm(`${file}.woohaa-install.lock`, { force: true }); }
  }

  async function replace(file: string, expected: string, next: string) {
    const current = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    if (current !== expected) throw new InstallationError("配置已被其他程序修改，请重试；未覆盖新内容。");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const mode = await stat(file).then(s => s.mode & 0o777, () => 0o600);
      await writeFile(temp, next, { flag: "wx", mode });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  }

  /** 插件类目标写入前确认 profile 已具备对应插件，缺失时拒绝写入。 */
  async function requirePlugin(target: InstallTarget, plugin: string) {
    const manifest = await readFile(path.join(path.dirname(target.path), "package.json"), "utf8")
      .then(text => JSON.parse(text) as Record<string, any>).catch(() => null);
    const bundles = manifest?.dsh?.profile?.bundles;
    const declared = (Array.isArray(bundles) && bundles.includes(plugin))
      || [manifest?.dependencies, manifest?.devDependencies, manifest?.peerDependencies]
        .some(deps => deps !== null && typeof deps === "object" && plugin in deps);
    if (!declared) {
      throw new InstallationError(`该 profile 未安装 MCP 客户端插件，请先执行 dsh plugin --profile ${target.key} add ${plugin} 后重试；原文件未修改。`);
    }
  }

  async function installTarget(spec: McpClientSpec, target: InstallTarget, url: string) {
    if (spec.writer.kind !== "command" && !await detected(spec)) {
      throw new InstallationError(`未找到 ${spec.label}，请安装客户端后重新检测。`);
    }
    const file = await resolveTarget(target.path);
    return withLock(file, async () => {
      if (await exists(file)) await access(file, constants.W_OK);
      const { text, data } = await readTarget(spec, { ...target, path: file });
      const state = stateOf(spec, data, url);
      if (state === "configured") return { client: await inspect(spec, url), changed: false };
      if (state === "conflict") {
        throw new InstallationError("已有同名 MCP 配置 woohaa3-model-canvas，请先在客户端中移除冲突项后重试；原文件未修改。");
      }
      if (spec.writer.kind === "command") {
        const exe = await executable(spec.writer.names);
        if (!exe) throw new InstallationError(`未找到 ${spec.label}，请安装客户端后重新检测。`);
        const childEnv = { ...env, ...(spec.writer.env?.(target, env) ?? {}) };
        const run = commandRunners[spec.id] ?? runCommand;
        await run(exe, spec.writer.args(url), childEnv);
      } else {
        if (spec.writer.kind === "plugin-patch") {
          await requirePlugin(target, spec.writer.plugin);
          await replace(file, text, applyPluginPatch(text, url, spec.writer.plugin));
        } else {
          await replace(file, text, applyEntry(text, target.format, spec.entry, url));
        }
      }
      const client = await inspect(spec, url);
      const installed = client.targets.find(item => item.key === target.key);
      if (!installed?.configured) {
        throw new InstallationError(installed?.error ?? "配置写入后未能确认，请重新检测并检查客户端配置。");
      }
      return { client, changed: true };
    });
  }

  return {
    /** 只读列出客户端目标，供 API 校验路径段。 */
    async targets(id: McpInstallClientId) {
      const spec = findClient(id);
      return spec ? spec.targets(ctx()) : [];
    },
    async detect(url: string) {
      const clients: McpInstallClient[] = [];
      for (const spec of MCP_CLIENT_REGISTRY) {
        // 没有可写目标（例如按 profile 存放配置但尚未建 profile）不展示，避免空按钮。
        if (!(await spec.targets(ctx())).length) continue;
        if (await detected(spec)) clients.push(await inspect(spec, url));
      }
      return { clients };
    },
    async install(id: McpInstallClientId, url: string, targetKey = "default") {
      const spec = findClient(id);
      if (!spec) throw new InstallationError("未注册的客户端。");
      const target = (await spec.targets(ctx())).find(item => item.key === targetKey);
      if (!target) throw new InstallationError("未找到该客户端的安装目标，请重新检测后重试。", "target-not-found");
      return installTarget(spec, target, url);
    }
  };
}
