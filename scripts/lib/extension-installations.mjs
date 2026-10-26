/**
 * 受管安装根与 `installations.json`
 * （change: 2026-10-21-add-extension-marketplace-point，任务 4.2 / design D6、D7）。
 *
 * 受管根布局：
 *
 *   <managedRoot>/
 *   ├── installations.json      # 唯一提交点：版本指针 + revision + 审计
 *   ├── installations.lock      # 排他写入锁（多进程共享同一受管根时拒绝第二个写入者）
 *   ├── installed/<id>/<ver>/   # 按版本并存的已解包扩展（只在 commit 时由 staging rename 进来）
 *   └── staging/<jobId>/        # 安装任务暂存区；从不被扫描，启动时整体清理
 *
 * 写入规则：
 * - installations.json 只经 commit() 写：mutator 产出新状态 → tmp 文件 → fsync → rename → fsync 目录。
 *   rename 之前的任何失败都不改变当前指针（design D6「唯一提交点」）。
 * - commit 要求 expectedRevision 与当前一致，否则 MARKETPLACE_REVISION_CONFLICT；成功 revision + 1。
 * - 写入者只有一个：openInstallations({ lock: true }) 以 wx 独占创建锁文件；锁文件记录 pid，
 *   持有者进程已不存在时视为陈旧锁并接管，否则 MARKETPLACE_WRITER_LOCKED。
 *
 * 本模块只读写受管根里的 JSON 与目录，不执行扩展代码。扫描器只用只读的 readInstallations。
 */
import fs from "node:fs";
import path from "node:path";

export const MANAGED_DIR_ENV = "WOOHAA3_EXTENSION_MANAGED_DIR";
/** 开发缺省受管根（相对仓库根；.woohaa3/ 已被 gitignore）。 */
export const DEFAULT_MANAGED_DIR = ".woohaa3/extensions";
export const INSTALLATIONS_FILE = "installations.json";
export const INSTALLATIONS_LOCK_FILE = "installations.lock";
export const INSTALLATIONS_SCHEMA_VERSION = 1;
export const INSTALLATION_HISTORY_LIMIT = 50;
export const INSTALLATION_STATES = ["active", "observing", "uninstalling"];

const KEBAB_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const VERSION_SEGMENT = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/** 安装记录错误：带稳定 code（与 contracts 的 MARKETPLACE_FAILURE_CODES 同口径）。 */
export class ExtensionInstallationsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExtensionInstallationsError";
    this.code = code;
    for (const [key, value] of Object.entries(details)) this[key] = value;
  }
}

/** 解析受管根：环境变量优先，否则仓库根下的缺省目录。返回绝对路径（不要求存在）。 */
export function resolveManagedRoot({ repoRoot, env = process.env } = {}) {
  const raw = env?.[MANAGED_DIR_ENV];
  const value = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : DEFAULT_MANAGED_DIR;
  return path.resolve(repoRoot ?? process.cwd(), value);
}

function assertSegment(name, value, pattern) {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("..")) {
    throw new ExtensionInstallationsError("MARKETPLACE_INSTALLATIONS_CORRUPT", `${name} 不能用作目录名：${String(value)}`);
  }
}

/** 受管根内的固定路径。versionDir 校验 id 与版本段，拒绝路径分隔与 ..。 */
export function managedLayout(managedRoot) {
  const root = path.resolve(managedRoot);
  const installedDir = path.join(root, "installed");
  return {
    root,
    installationsFile: path.join(root, INSTALLATIONS_FILE),
    lockFile: path.join(root, INSTALLATIONS_LOCK_FILE),
    installedDir,
    stagingDir: path.join(root, "staging"),
    versionDir(extensionId, version) {
      assertSegment("extensionId", extensionId, KEBAB_ID);
      assertSegment("version", version, VERSION_SEGMENT);
      return path.join(installedDir, extensionId, version);
    }
  };
}

export function emptyInstallations() {
  return { schemaVersion: INSTALLATIONS_SCHEMA_VERSION, revision: 0, extensions: {} };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验一份 installations.json。返回 { ok, value, errors }。只校验扫描与指针所需的字段；
 * Manager 写入的其余字段（packageDigest、trust、permissions、observeUntil、requiresRestart、rejected…）原样保留。
 */
export function validateInstallations(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ["installations.json 必须是对象"] };
  if (raw.schemaVersion !== INSTALLATIONS_SCHEMA_VERSION) errors.push(`schemaVersion 必须是 ${INSTALLATIONS_SCHEMA_VERSION}`);
  if (!Number.isInteger(raw.revision) || raw.revision < 0) errors.push("revision 必须是非负整数");
  if (!isPlainObject(raw.extensions)) errors.push("extensions 必须是对象");
  else {
    for (const [extensionId, record] of Object.entries(raw.extensions)) {
      const at = `extensions.${extensionId}`;
      if (!KEBAB_ID.test(extensionId)) errors.push(`extensions 键不是合法 extensionId：${extensionId}`);
      if (!isPlainObject(record)) {
        errors.push(`${at} 必须是对象`);
        continue;
      }
      if (typeof record.current !== "string" || !VERSION_SEGMENT.test(record.current) || record.current.includes("..")) errors.push(`${at}.current 非法`);
      if (record.previous !== undefined && record.previous !== null && (typeof record.previous !== "string" || !VERSION_SEGMENT.test(record.previous) || record.previous.includes(".."))) {
        errors.push(`${at}.previous 非法`);
      }
      if (typeof record.sourceId !== "string" || record.sourceId.length === 0) errors.push(`${at}.sourceId 非法`);
      if (record.state !== undefined && !INSTALLATION_STATES.includes(record.state)) errors.push(`${at}.state 非法`);
      if (record.history !== undefined && !Array.isArray(record.history)) errors.push(`${at}.history 必须是数组`);
    }
  }
  return errors.length === 0 ? { ok: true, value: raw, errors: [] } : { ok: false, errors };
}

/**
 * 只读读取（扫描器与设置投影用）：文件不存在 → 空状态；损坏 → 空状态 + warnings，不抛错——
 * 受管扩展缺失不能阻止宿主启动（受管扩展视为可选插件）。
 */
export function readInstallations(managedRoot) {
  const layout = managedLayout(managedRoot);
  if (!fs.existsSync(layout.installationsFile)) return { state: emptyInstallations(), warnings: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(layout.installationsFile, "utf8"));
  } catch (error) {
    return { state: emptyInstallations(), warnings: [`${layout.installationsFile} 不是合法 JSON：${error.message}；受管扩展本次不装配`] };
  }
  const validated = validateInstallations(parsed);
  if (!validated.ok) {
    return { state: emptyInstallations(), warnings: [`${layout.installationsFile} 无效：${validated.errors.join("；")}；受管扩展本次不装配`] };
  }
  return { state: validated.value, warnings: [] };
}

function readForWrite(layout) {
  if (!fs.existsSync(layout.installationsFile)) return emptyInstallations();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(layout.installationsFile, "utf8"));
  } catch (error) {
    throw new ExtensionInstallationsError("MARKETPLACE_INSTALLATIONS_CORRUPT", `${layout.installationsFile} 不是合法 JSON，拒绝在其上提交：${error.message}`);
  }
  const validated = validateInstallations(parsed);
  if (!validated.ok) {
    throw new ExtensionInstallationsError("MARKETPLACE_INSTALLATIONS_CORRUPT", `${layout.installationsFile} 无效，拒绝在其上提交：${validated.errors.join("；")}`);
  }
  return validated.value;
}

/** 追加一条审计历史，只保留最近 INSTALLATION_HISTORY_LIMIT 条。返回新记录对象（不改入参）。 */
export function appendHistory(record, entry) {
  const history = [...(record?.history ?? []), entry];
  return { ...record, history: history.slice(-INSTALLATION_HISTORY_LIMIT) };
}

function fsyncPath(target) {
  let fd;
  try {
    fd = fs.openSync(target, "r");
    fs.fsyncSync(fd);
  } catch {
    // 部分平台（Windows 目录）不支持 fsync 目录：忽略，rename 本身仍是原子的。
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** tmp + fsync + rename + fsync 目录。 */
export function writeFileAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w", 0o644);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fsyncPath(path.dirname(file));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireLock(layout, { owner }) {
  const payload = `${JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(layout.lockFile, payload, { flag: "wx", mode: 0o644 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(layout.lockFile, "utf8"));
      } catch {
        holder = null;
      }
      if (holder && holder.pid !== process.pid && processAlive(holder.pid)) {
        throw new ExtensionInstallationsError(
          "MARKETPLACE_WRITER_LOCKED",
          `受管扩展根已被另一个进程占用（pid ${holder.pid}）：${layout.root}；多个宿主不能共享同一受管根`,
          { holderPid: holder.pid }
        );
      }
      // 持有者已退出、锁文件损坏或是本进程遗留：视为陈旧锁，删除后重试一次。
      fs.rmSync(layout.lockFile, { force: true });
    }
  }
  throw new ExtensionInstallationsError("MARKETPLACE_WRITER_LOCKED", `无法获取受管扩展根写入锁：${layout.root}`);
}

/**
 * 打开受管根用于写入（Extension Manager 唯一调用方）。
 *
 * - lock: true（缺省）：获取排他锁；release() 释放。
 * - read()：读当前状态（损坏抛 MARKETPLACE_INSTALLATIONS_CORRUPT）。
 * - commit(mutator, { expectedRevision })：mutator 收到当前状态的**可修改深拷贝**，可以就地修改后返回
 *   undefined，也可以返回新状态对象；结果与当前状态内容相同时不写盘、不推进 revision。revision 由本模块推进。
 *   返回提交后的状态（含新 revision）。
 * - clearStaging()：清空暂存区（启动时调用）。
 *
 * 同步实现：同一进程内天然串行；跨进程由锁文件保证单写入者。
 */
export function openInstallations({ managedRoot, lock = true, owner = "extension-manager" } = {}) {
  if (typeof managedRoot !== "string" || managedRoot.length === 0) {
    throw new ExtensionInstallationsError("MARKETPLACE_INSTALLATIONS_CORRUPT", "缺少受管扩展根 managedRoot");
  }
  const layout = managedLayout(managedRoot);
  fs.mkdirSync(layout.installedDir, { recursive: true });
  fs.mkdirSync(layout.stagingDir, { recursive: true });
  if (lock) acquireLock(layout, { owner });
  let released = false;
  const assertOpen = () => {
    if (released) throw new ExtensionInstallationsError("MARKETPLACE_WRITER_LOCKED", "受管扩展根句柄已释放");
  };
  return {
    layout,
    read() {
      assertOpen();
      return readForWrite(layout);
    },
    commit(mutator, { expectedRevision } = {}) {
      assertOpen();
      const current = readForWrite(layout);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
        throw new ExtensionInstallationsError(
          "MARKETPLACE_REVISION_CONFLICT",
          `安装记录 revision 冲突：期望 ${String(expectedRevision)}，当前 ${current.revision}`,
          { expectedRevision, currentRevision: current.revision }
        );
      }
      const draft = structuredClone(current);
      const next = mutator(draft) ?? draft;
      const candidate = { ...next, schemaVersion: INSTALLATIONS_SCHEMA_VERSION, revision: current.revision };
      if (JSON.stringify(candidate) === JSON.stringify(current)) return current;
      candidate.revision = current.revision + 1;
      const validated = validateInstallations(candidate);
      if (!validated.ok) {
        throw new ExtensionInstallationsError("MARKETPLACE_INSTALLATIONS_CORRUPT", `拒绝提交无效的安装记录：${validated.errors.join("；")}`);
      }
      writeFileAtomic(layout.installationsFile, `${JSON.stringify(candidate, null, 2)}\n`);
      return candidate;
    },
    clearStaging() {
      assertOpen();
      fs.rmSync(layout.stagingDir, { recursive: true, force: true });
      fs.mkdirSync(layout.stagingDir, { recursive: true });
    },
    release() {
      if (released) return;
      released = true;
      if (!lock) return;
      try {
        const holder = JSON.parse(fs.readFileSync(layout.lockFile, "utf8"));
        if (holder?.pid === process.pid) fs.rmSync(layout.lockFile, { force: true });
      } catch {
        // 锁文件已不在或已被接管：无需处理。
      }
    }
  };
}

/**
 * 列出既不被 current 也不被 previous 引用的版本目录（提交前崩溃留下的孤儿，或已被替换的旧版本）。
 * 只返回路径，删除由调用方按保留期决定。
 */
export function listOrphanVersionDirs(managedRoot, state) {
  const layout = managedLayout(managedRoot);
  if (!fs.existsSync(layout.installedDir)) return [];
  const orphans = [];
  for (const idEntry of fs.readdirSync(layout.installedDir, { withFileTypes: true })) {
    if (!idEntry.isDirectory()) continue;
    const record = state.extensions?.[idEntry.name];
    const keep = new Set([record?.current, record?.previous].filter(Boolean));
    const idDir = path.join(layout.installedDir, idEntry.name);
    for (const versionEntry of fs.readdirSync(idDir, { withFileTypes: true })) {
      if (!versionEntry.isDirectory() || keep.has(versionEntry.name)) continue;
      orphans.push({ extensionId: idEntry.name, version: versionEntry.name, dir: path.join(idDir, versionEntry.name) });
    }
  }
  return orphans;
}
