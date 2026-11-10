/**
 * 实例登记：宿主把自己的位置写到**固定目录**，让同机其他工具不必靠扫端口找人。
 *
 * ## 为什么要有这个文件
 *
 * 扫端口能找出宿主，但成本与顺序都不对：一次发现要探两千个端口，才能认出两三个实例；
 * 而且「端口开着」并不等于「这是宿主」，还得再问一遍身份。登记表把关系反过来——
 * **宿主启动时自己登记**，读的人只看一个目录就知道谁在、在哪、是哪份数据。
 *
 * ## 为什么放在临时目录而不是数据目录
 *
 * 登记表描述的是**当前进程**（端口、pid、启动时刻），进程一退就失效。放进数据目录会留下
 * 永远不会被清理的陈旧条目，而数据目录本身还可能跨机器同步。临时目录天然随重启消失，
 * 语义与「运行态」一致。
 *
 * ## 陈旧条目怎么处理
 *
 * 读取方负责校验：登记的是不是还活着（问一次身份端点）、pid 是否还在。不靠写入方保证
 * 清理干净——进程被 kill -9 时没人能保证。清理是 best-effort，宁可多留一条被判定为
 * 陈旧的记录，也不要漏掉一个活着的实例。
 *
 * @module backend/host/identity-registry
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 登记文件所在目录名（相对运行目录）。 */
const REGISTRY_DIR_NAME = "woohaa3/instances";/** 登记格式版本：读取方据此拒绝不认识的形状。 */
export const IDENTITY_REGISTRY_SCHEMA = 1;

/** 一条登记记录。 */
export type IdentityRegistryEntry = {
  schema: number;
  /** 与身份端点一致的实例指纹。 */
  instanceId: string;
  /** 可打开画布页面的 origin（`http://127.0.0.1:<port>`，无结尾斜杠）。 */
  origin: string;
  /**
   * 只供 API 的 origin（dev 形态才有）。
   *
   * `pnpm dev` 里页面由 vite 提供、后端只监听 API 端口，所以 `origin` 记前端、这里记后端。
   * 两者是同一个实例的两个面，读的人不该把它们当成两个实例。
   */
  apiOrigin?: string;
  /** 数据目录绝对路径。 */
  dataDir: string;
  /** 进程启动时刻（ISO）。 */
  startedAt: string;
  /** 进程 id：读取方据此判断条目是否残留。 */
  pid: number;
  /** 应用版本；取不到时为空串。 */
  version: string;
};

/**
 * 登记目录的绝对路径。
 *
 * 优先 `XDG_RUNTIME_DIR`（Linux 的用户私有运行目录，权限与生命周期都正确）；否则退回系统
 * 临时目录并按 uid 分子目录，避免多用户机器上互相看到、互相覆盖。
 *
 * **这条规则必须与 `dsh-plugins/woohaa-attach` 的 `resolveRegistryDir` 完全一致**——那边是
 * 读取方，本文件是写入方，两边算不出同一个目录就等于没有登记表。改动时两处一起改。
 * @param home - 运行目录（测试注入用）；缺省按平台推导。
 * @returns 登记目录绝对路径。
 */
export function resolveRegistryDir(home?: string): string {
  if (home !== undefined) return path.join(home, REGISTRY_DIR_NAME);
  const runtime = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtime) return path.join(runtime, REGISTRY_DIR_NAME);
  // Windows 的 tmpdir 本身按用户隔离，不必再加 uid；POSIX 的 /tmp 是共享的。
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  return path.join(os.tmpdir(), "woohaa3", uid === "" ? "instances" : `instances-${uid}`);
}

/** 一条登记的完整文件路径。 */
export function registryFileOf(directory: string, instanceId: string): string {
  return path.join(directory, `${instanceId}.json`);
}

/**
 * 写一条登记（原子替换）。
 *
 * 用 tmp + rename：读的人可能正好在写，半截 JSON 不该被当成条目。
 * @param directory - 登记目录。
 * @param entry - 登记内容。
 */
export function writeRegistryEntry(directory: string, entry: IdentityRegistryEntry): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = registryFileOf(directory, entry.instanceId);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** 删除一条登记；不存在或删不掉都算成功（退出路径不该因此失败）。 */
export function removeRegistryEntry(directory: string, instanceId: string): void {
  try {
    fs.rmSync(registryFileOf(directory, instanceId), { force: true });
  } catch {
    // 退出清理是 best-effort：读的人会自己校验活性。
  }
}

/**
 * 读登记目录里的全部条目。
 *
 * 坏文件跳过（半截写入、别的程序放错东西）——一条脏记录不该让发现整体失败。
 * @param directory - 登记目录。
 * @returns 形状合法的条目；目录不存在时为空数组。
 */
export function readRegistry(directory: string): IdentityRegistryEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const entries: IdentityRegistryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      const entry = readEntry(value);
      if (entry !== null) entries.push(entry);
    } catch {
      continue;
    }
  }
  return entries;
}

/**
 * 校验一条登记的形状。
 * @param value - 解析后的 JSON。
 * @returns 合法条目；形状不对或版本未知时 null。
 */
export function readEntry(value: unknown): IdentityRegistryEntry | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== IDENTITY_REGISTRY_SCHEMA) return null;
  const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
  const instanceId = text("instanceId");
  const origin = text("origin");
  if (instanceId === "" || origin === "") return null;
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : 0;
  return {
    schema: IDENTITY_REGISTRY_SCHEMA,
    instanceId,
    origin,
    ...(text("apiOrigin") === "" ? {} : { apiOrigin: text("apiOrigin") }),
    dataDir: text("dataDir"),
    startedAt: text("startedAt"),
    pid,
    version: text("version")
  };
}
