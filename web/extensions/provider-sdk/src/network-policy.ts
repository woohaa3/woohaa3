/**
 * 出网主机策略（change: 2026-10-21-isolate-extension-host-process，任务 5.1 / design D5）。
 *
 * 两处共用同一套判定，避免各写一份：
 * - Provider 的 `createGuardedFetch`（可选 `allowedHosts`：`baseUrl` 不在白名单时构造即抛错）；
 * - Extension Host 子进程的全局出网守卫（`web/backend/src/extension-host/child/network-guard.ts`）。
 *
 * 白名单条目即 `extension.json` 的 `permissions.network`：域名，可带 `*.` 前缀（只匹配子域，不匹配
 * 裸域）与 `:port`（不写端口则任意端口）。IP 字面量条目按字面比较。比较大小写不敏感，忽略末尾的点。
 *
 * 私网判定覆盖：IPv4 回环 / 私网 / 链路本地 / CGNAT / 0.0.0.0/8 / 组播与保留；IPv6 回环、未指定、
 * 唯一本地 fc00::/7、链路本地 fe80::/10、IPv4 映射地址（按内嵌 IPv4 判定）；主机名 localhost / *.localhost / *.local。
 * 只依赖平台内置能力，无 node 依赖，可在浏览器安全的上下文里被 tree-shake。
 */

export type HostRule = {
  readonly raw: string;
  /** 小写主机名（通配条目不含 `*.` 前缀）。 */
  readonly host: string;
  readonly wildcard: boolean;
  /** 未写端口时为 null（任意端口）。 */
  readonly port: number | null;
};

/** 出网被拒（白名单外或解析到私网）。错误码与 contracts 的 `EXTENSION_NETWORK_DENIED` 一致。 */
export class NetworkDeniedError extends Error {
  readonly code = "EXTENSION_NETWORK_DENIED" as const;
  readonly host: string;
  readonly port: number | null;
  readonly reason: "not-allowed" | "private-address";
  constructor(host: string, port: number | null, reason: "not-allowed" | "private-address", via?: string) {
    const target = port === null ? host : `${host}:${port}`;
    super(
      reason === "private-address"
        ? `出网被拒：${target} 解析或指向回环 / 私网 / 链路本地地址${via ? `（${via}）` : ""}`
        : `出网被拒：${target} 不在扩展声明的 permissions.network 白名单内${via ? `（${via}）` : ""}`
    );
    this.name = "NetworkDeniedError";
    this.host = host;
    this.port = port;
    this.reason = reason;
  }
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** 解析一条白名单条目；非法条目抛错（扩展声明已在预检校验，这里是纵深防御）。 */
export function parseHostRule(entry: string): HostRule {
  const raw = String(entry);
  let value = raw.trim().toLowerCase();
  if (value.length === 0 || /[\s/?#@]/.test(value) || value.includes("://")) throw new Error(`出网白名单条目非法：${raw}`);
  let port: number | null = null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) {
    value = bracketed[1];
    if (bracketed[2]) port = Number(bracketed[2]);
  } else {
    const portMatch = /^([^:]+):(\d+)$/.exec(value);
    if (portMatch) {
      value = portMatch[1];
      port = Number(portMatch[2]);
    }
  }
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`出网白名单端口非法：${raw}`);
  const wildcard = value.startsWith("*.");
  const host = normalizeHost(wildcard ? value.slice(2) : value);
  if (host.length === 0 || host.includes("*")) throw new Error(`出网白名单条目非法：${raw}`);
  return { raw, host, wildcard, port };
}

export function parseHostRules(entries: readonly string[] | undefined): readonly HostRule[] {
  return (entries ?? []).map(parseHostRule);
}

/** 主机（可带端口）是否命中白名单。`port` 缺省按协议默认端口由调用方给出，未知时传 null（仅匹配不限端口的条目）。 */
export function isHostAllowed(rules: readonly HostRule[], host: string, port: number | null): boolean {
  const target = normalizeHost(host);
  if (target.length === 0) return false;
  return rules.some((rule) => {
    if (rule.port !== null && rule.port !== port) return false;
    if (rule.wildcard) return target.endsWith(`.${rule.host}`);
    return target === rule.host;
  });
}

/** 一个 URL 是否命中白名单（端口缺省取协议默认端口）。 */
export function isUrlAllowed(rules: readonly HostRule[], url: URL | string): boolean {
  const parsed = typeof url === "string" ? new URL(url) : url;
  return isHostAllowed(rules, parsed.hostname, effectivePort(parsed));
}

export function effectivePort(url: URL): number | null {
  if (url.port) return Number(url.port);
  if (url.protocol === "https:" || url.protocol === "wss:") return 443;
  if (url.protocol === "http:" || url.protocol === "ws:") return 80;
  return null;
}

/** 本机 / mDNS 主机名。 */
export function isLocalHostname(host: string): boolean {
  const value = normalizeHost(host);
  return value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local");
}

function parseIpv4(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.some((value) => value > 255) ? null : octets;
}

/** IPv4 字面量是否为回环 / 私网 / 链路本地 / CGNAT / 保留。非 IPv4 返回 false；超范围八位组按不安全处理。 */
export function isPrivateIpv4(host: string): boolean {
  const value = normalizeHost(host);
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(value) && parseIpv4(value) === null) return true;
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && octets[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // 组播与保留
  return false;
}

/** IPv6 字面量是否为回环 / 未指定 / 唯一本地 / 链路本地，或映射到私网 IPv4。非 IPv6 返回 false。 */
export function isPrivateIpv6(host: string): boolean {
  const value = normalizeHost(host);
  if (!value.includes(":")) return false;
  if (value === "::1" || value === "::" || /^0*:0*:0*:0*:0*:0*:0*:0*1$/.test(value)) return true;
  const mapped = /^(?:0*:)*:?ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const mappedHex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = value.split(":")[0] ?? "";
  const head = parseInt(first.length === 0 ? "0" : first, 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((head & 0xff00) === 0xff00) return true; // 组播
  return false;
}

/** 地址字面量（IPv4 / IPv6）是否不允许作为出网目标。 */
export function isPrivateAddress(address: string): boolean {
  return isPrivateIpv4(address) || isPrivateIpv6(address);
}

/** 主机名或地址是否指向本机 / 私网（只看字面量与本机主机名；域名解析结果由调用方另行判定）。 */
export function isPrivateHost(host: string): boolean {
  return isLocalHostname(host) || isPrivateAddress(host);
}
