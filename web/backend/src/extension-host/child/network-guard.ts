/**
 * Extension Host 子进程的全局出网守卫（change: 2026-10-21-isolate-extension-host-process，任务 5.2 / design D5）。
 *
 * 子进程入口在 `import(entry)` **之前**调用 `installNetworkGuard`。白名单 = 扩展声明的 `permissions.network`；
 * 空白名单 = 禁止一切出网。判定共用 provider-sdk 的 `network-policy`（与 `createGuardedFetch` 同一套规则）。
 *
 * 拦截点（从外到内，任一层都独立生效）：
 * 1. `globalThis.fetch`：先按 URL 判定，给出清晰错误（不等到建连）；
 * 2. `http(s).request/get`：按请求目标判定；`http.Agent.prototype.createConnection` 在加载时就捕获了
 *    `net.createConnection`，单独替换；
 * 3. `net.Socket.prototype.connect`：**最终闸门**——`net.connect` / `net.createConnection` / `tls.connect` /
 *    内置 undici（Node 自带 fetch 的实现）建连都经过它。主机名命中白名单后，注入的 `lookup` 再检查解析
 *    结果，解析到回环 / 私网 / 链路本地即拒绝（防 DNS 重绑定到内网）；Unix 套接字 / 命名管道一律拒绝；
 * 4. `dns.lookup` / `dns.promises.lookup` / `dns.resolve*`：白名单外的名字不解析。
 *
 * 违规抛 `ExtensionNetworkDeniedError`（`code = "EXTENSION_NETWORK_DENIED"`，只含主机与端口，不含路径与查询），
 * 并回调 `onViolation` 供入口上报诊断；守卫不判崩溃。
 *
 * `lockdown: true` 另把 `child_process` / `worker_threads` / `cluster` 的导出换成抛错桩（纵深防御：
 * 它们能绕过 JS 层守卫）。替换后调用 `syncBuiltinESMExports`，ESM 具名导入同样生效。
 *
 * **已知局限**：原生模块、`process.binding` 可绕过（预检拒绝包内 `.node`）；这不是 OS 级沙箱。
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { LookupAddress, LookupOneOptions } from "node:dns";
import { NetworkDeniedError, effectivePort, isHostAllowed, isPrivateAddress, isPrivateHost, parseHostRules, type HostRule } from "@woohaa3/provider-sdk";

const require = createRequire(import.meta.url);
// 用 CommonJS 形态拿到**可写**的内置模块对象（ESM 命名空间不可改）。
const net = require("node:net") as typeof import("node:net");
const http = require("node:http") as typeof import("node:http");
const https = require("node:https") as typeof import("node:https");
const dns = require("node:dns") as typeof import("node:dns");

export type NetworkViolation = { host: string; port: number | null; via: string; reason: "not-allowed" | "private-address" | "local-socket" };

export class ExtensionNetworkDeniedError extends NetworkDeniedError {
  readonly via: string;
  constructor(host: string, port: number | null, reason: "not-allowed" | "private-address", via: string) {
    super(host, port, reason, via);
    this.name = "ExtensionNetworkDeniedError";
    this.via = via;
  }
}

export type NetworkGuardOptions = {
  allowedHosts: readonly string[];
  onViolation?: (violation: NetworkViolation) => void;
  lockdown?: boolean;
};

export type NetworkGuard = { uninstall(): void };

type Restore = () => void;
let active: NetworkGuard | null = null;

/** 安装守卫（每个进程只允许一个；重复安装抛错）。返回的 `uninstall` 只供测试使用。 */
export function installNetworkGuard(options: NetworkGuardOptions): NetworkGuard {
  if (active) throw new Error("出网守卫已安装");
  const rules = parseHostRules(options.allowedHosts);
  const restores: Restore[] = [];
  const report = (violation: NetworkViolation) => {
    try {
      options.onViolation?.(violation);
    } catch {
      // 上报失败不能让守卫失效。
    }
  };
  const deny = (host: string, port: number | null, reason: "not-allowed" | "private-address", via: string): never => {
    report({ host, port, via, reason });
    throw new ExtensionNetworkDeniedError(host, port, reason, via);
  };
  /** 主机（名字或字面量）是否可作为目标；不可时抛错。 */
  const checkTarget = (rawHost: string, port: number | null, via: string) => {
    const host = rawHost.replace(/^\[|\]$/g, "");
    if (!isAllowed(rules, host, port)) deny(host, port, "not-allowed", via);
    if (isPrivateHost(host)) deny(host, port, "private-address", via);
  };

  const replace = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]) => {
    const original = target[key];
    target[key] = value;
    restores.push(() => {
      target[key] = original;
    });
  };

  // 1. fetch
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === "function") {
    replace(globalThis, "fetch", (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") deny(url.hostname || url.protocol, null, "not-allowed", "fetch");
      checkTarget(url.hostname, effectivePort(url), "fetch");
      return originalFetch(input, init);
    }) as typeof fetch);
  }

  // 2. http(s).request / get
  for (const [module, defaultPort, name] of [[http, 80, "http"], [https, 443, "https"]] as const) {
    for (const method of ["request", "get"] as const) {
      const original = module[method] as (...args: unknown[]) => unknown;
      replace(module, method, ((...args: unknown[]) => {
        const { host, port } = requestTarget(args, defaultPort);
        checkTarget(host, port, `${name}.${method}`);
        return original.apply(module, args);
      }) as never);
    }
  }

  // 3. 最终闸门：Socket#connect
  const originalLookup = dns.lookup;
  const guardedLookup = (hostname: string, lookupOptions: unknown, callback: (...args: unknown[]) => void) => {
    const run = typeof lookupOptions === "function" ? (lookupOptions as typeof callback) : callback;
    const opts = typeof lookupOptions === "function" ? {} : (lookupOptions as LookupOneOptions);
    (originalLookup as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(hostname, opts, (error: unknown, address: unknown, family: unknown) => {
      if (error) return run(error);
      const list = Array.isArray(address) ? (address as LookupAddress[]).map((entry) => entry.address) : [address as string];
      const blocked = list.find((value) => isPrivateAddress(value));
      if (blocked !== undefined) {
        report({ host: hostname, port: null, via: "dns", reason: "private-address" });
        return run(new ExtensionNetworkDeniedError(hostname, null, "private-address", `解析到 ${blocked}`));
      }
      return run(null, address, family);
    });
  };
  const originalConnect = net.Socket.prototype.connect;
  replace(net.Socket.prototype, "connect", function guardedConnect(this: import("node:net").Socket, ...args: unknown[]) {
    const normalized = normalizeConnectArgs(args);
    const options = normalized[0] as Record<string, unknown>;
    if (typeof options.path === "string") {
      report({ host: options.path, port: null, via: "net", reason: "local-socket" });
      throw new ExtensionNetworkDeniedError(String(options.path), null, "not-allowed", "本地套接字");
    }
    const host = typeof options.host === "string" && options.host.length > 0 ? options.host : "localhost";
    const port = options.port === undefined ? null : Number(options.port);
    checkTarget(host, port, "net");
    const userLookup = typeof options.lookup === "function" ? (options.lookup as typeof guardedLookup) : null;
    options.lookup = userLookup ? wrapLookup(userLookup, report) : guardedLookup;
    return (originalConnect as (...a: unknown[]) => unknown).apply(this, normalized);
  } as typeof originalConnect);
  // http.Agent 在模块加载时捕获了 net.createConnection；它最终仍走 Socket#connect，这里只为错误更早暴露。
  const originalCreateConnection = http.Agent.prototype.createConnection;
  replace(http.Agent.prototype, "createConnection", function guardedCreateConnection(this: unknown, ...args: unknown[]) {
    const options = (args[0] ?? {}) as { host?: string; port?: number };
    checkTarget(options.host ?? "localhost", options.port ?? null, "http.Agent");
    return (originalCreateConnection as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof originalCreateConnection);

  // 4. DNS：白名单外的名字不解析。
  const guardName = (via: string) => (hostname: unknown) => {
    const name = String(hostname ?? "");
    if (!isAllowed(rules, name, null, true)) deny(name, null, "not-allowed", via);
  };
  replace(dns, "lookup", ((hostname: string, ...rest: unknown[]) => {
    guardName("dns.lookup")(hostname);
    return (originalLookup as (...a: unknown[]) => unknown)(hostname, ...rest);
  }) as typeof dns.lookup);
  const promiseLookup = dns.promises.lookup;
  replace(dns.promises, "lookup", (async (hostname: string, ...rest: unknown[]) => {
    guardName("dns.promises.lookup")(hostname);
    const result = await (promiseLookup as (...a: unknown[]) => Promise<LookupAddress | LookupAddress[]>)(hostname, ...rest);
    const list = Array.isArray(result) ? result : [result];
    const blocked = list.find((entry) => isPrivateAddress(entry.address));
    if (blocked) deny(hostname, null, "private-address", `解析到 ${blocked.address}`);
    return result;
  }) as typeof dns.promises.lookup);
  for (const method of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCname"] as const) {
    for (const target of [dns, dns.promises] as const) {
      const original = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
      if (typeof original !== "function") continue;
      replace(target as unknown as Record<string, unknown>, method, (hostname: unknown, ...rest: unknown[]) => {
        guardName(`dns.${method}`)(hostname);
        return original.call(target, hostname, ...rest);
      });
    }
  }

  if (options.lockdown) restores.push(...lockdownProcessModules());
  syncBuiltinESMExports();

  const guard: NetworkGuard = {
    uninstall() {
      for (const restore of restores.reverse()) restore();
      syncBuiltinESMExports();
      active = null;
    }
  };
  active = guard;
  return guard;
}

/** 白名单判定；IP 字面量也要求显式列出。`nameOnly` 用于 DNS（不知道端口，任一端口条目命中即可）。 */
function isAllowed(rules: readonly HostRule[], host: string, port: number | null, nameOnly = false): boolean {
  if (nameOnly) return rules.some((rule) => isHostAllowed([{ ...rule, port: null }], host, null));
  return isHostAllowed(rules, host, port);
}

function wrapLookup(userLookup: (...args: never[]) => void, report: (violation: NetworkViolation) => void) {
  return (hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const run = typeof options === "function" ? (options as typeof callback) : callback;
    const opts = typeof options === "function" ? {} : options;
    (userLookup as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(hostname, opts, (error: unknown, address: unknown, family: unknown) => {
      if (error) return run(error);
      const list = Array.isArray(address) ? (address as LookupAddress[]).map((entry) => entry.address) : [address as string];
      const blocked = list.find((value) => isPrivateAddress(value));
      if (blocked !== undefined) {
        report({ host: hostname, port: null, via: "dns", reason: "private-address" });
        return run(new ExtensionNetworkDeniedError(hostname, null, "private-address", `解析到 ${blocked}`));
      }
      return run(null, address, family);
    });
  };
}

/** Socket#connect 的参数规范化：沿用 Node 内部的 `net._normalizeArgs`（存在时），否则按常见形态解析。 */
function normalizeConnectArgs(args: unknown[]): unknown[] {
  const internal = (net as unknown as { _normalizeArgs?: (a: unknown[]) => unknown[] })._normalizeArgs;
  if (Array.isArray(args[0]) && args[0].length > 0 && typeof args[0][0] === "object") return args[0] as unknown[];
  if (typeof internal === "function") return internal(args);
  const [first, second, third] = args;
  if (first !== null && typeof first === "object") return [{ ...(first as object) }, typeof second === "function" ? second : undefined];
  if (typeof first === "string" && !/^\d+$/.test(first)) return [{ path: first }, second];
  return [{ port: first, host: typeof second === "string" ? second : undefined }, typeof second === "function" ? second : third];
}

/** http(s).request 的目标主机与端口（url 字符串 / URL / options 三种形态）。 */
function requestTarget(args: unknown[], defaultPort: number): { host: string; port: number | null } {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    const url = new URL(String(first));
    return { host: url.hostname, port: url.port ? Number(url.port) : defaultPort };
  }
  const options = (first ?? {}) as { hostname?: string; host?: string; port?: number | string; socketPath?: string };
  if (options.socketPath) return { host: options.socketPath, port: null };
  const host = (options.hostname ?? options.host ?? "localhost").replace(/:\d+$/, "");
  return { host, port: options.port === undefined ? defaultPort : Number(options.port) };
}

/** 把派生进程 / 线程的模块导出换成抛错桩。 */
function lockdownProcessModules(): Restore[] {
  const restores: Restore[] = [];
  const block = (moduleName: string, keys: readonly string[]) => {
    const module = require(moduleName) as Record<string, unknown>;
    for (const key of keys) {
      if (!(key in module)) continue;
      const original = module[key];
      const stub = function blocked() {
        throw Object.assign(new Error(`受管扩展不允许使用 ${moduleName}.${key}`), { code: "permission-denied" });
      };
      try {
        module[key] = stub;
        restores.push(() => {
          module[key] = original;
        });
      } catch {
        // 只读导出（极少数）：跳过，仍有其余闸门。
      }
    }
  };
  block("node:child_process", ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
  block("node:worker_threads", ["Worker"]);
  block("node:cluster", ["fork", "setupPrimary", "setupMaster"]);
  return restores;
}
