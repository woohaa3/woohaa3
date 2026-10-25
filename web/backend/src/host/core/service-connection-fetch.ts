/** Per-source authenticated transport: resolve once, reject private addresses and pin the dial. */
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31 || a === 192 && (b === 168 || b === 0) || a === 100 && b! >= 64 && b! <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address);
}
export function createServiceConnectionFetch(options: {
  endpoint: string; validate: () => Promise<void>; allowHttp: boolean;
  lookup?: (host: string) => Promise<readonly { address: string; family: number }[]>;
}): typeof fetch {
  const origin = new URL(options.endpoint).origin;
  return (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== origin || url.username || url.password) throw new Error("来源请求目标未获准");
    await options.validate();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(host);
    if (url.protocol !== "https:" && !(options.allowHttp && loopback && url.protocol === "http:")) throw new Error("来源协议未获准");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await (options.lookup ?? (name => lookup(name, { all: true })))(host);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address) && !(options.allowHttp && loopback && ["127.0.0.1", "::1"].includes(item.address)))) throw new Error("来源 DNS 包含非公网地址");
    // DNS resolution can await; recheck revocation immediately before sending authentication.
    await options.validate();
    request.headers.set("accept-encoding", "identity");
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => { headers[name] = value; });
    return new Promise<Response>((resolve, reject) => {
      const pinned = addresses[0]!;
      const upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: request.method, headers, signal: request.signal,
        // Fresh socket, validated address; preserve URL hostname for TLS/SNI and Host.
        agent: false, family: pinned.family,
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      }, response => {
        if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) { response.destroy(); reject(new Error("拒绝来源认证请求重定向")); return; }
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
        const noBody = request.method === "HEAD" || [204, 205, 304].includes(response.statusCode ?? 200);
        resolve(new Response(noBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 500, headers }));
      });
      upstream.setTimeout(120_000, () => upstream.destroy(new Error("来源请求超时")));
      upstream.on("error", reject);
      upstream.end(body);
    });
  }) as typeof fetch;
}
