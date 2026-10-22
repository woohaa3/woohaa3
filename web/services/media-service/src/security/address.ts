/**
 * 地址分类（change: split-web-runtime-services，任务 3.3）。
 *
 * 把「私网 / 回环 / 链路本地 / 元数据」判定集中在这里，供受控下载与其它安全边界复用。
 * 纯函数、无 I/O，便于单测穷举边界。
 */

/** 是否为 loopback / link-local / 私网 / 云元数据 IPv4 或 IPv6。 */
export function isPrivateAddress(host: string): boolean {
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

export function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

export function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized.includes(":")) return false;
  if (normalized === "::1" || normalized === "::") return true; // loopback / unspecified
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true; // link-local fe80::/10
  // IPv4-mapped：::ffff:127.0.0.1 等。
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}
