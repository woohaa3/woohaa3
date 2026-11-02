import os from "node:os";

/**
 * 复核目标的地址解析。
 *
 * 远端 CDP 浏览器访问不到本机 127.0.0.1（那是它自己的环回），所以 CDP 模式下
 * 开发/E2E 服务要绑 0.0.0.0，baseURL 换成本机可达的地址。
 *
 * 同时必须用 HTTPS：`http://<内网 IP>` 不是安全上下文（`navigator.gpu`、Service
 * Worker、`crypto.subtle` 都不可用），拿它做 GPU / 视觉复核会得到失真的结论。
 * 服务端由 `E2E_TLS=1` 切到自签证书，浏览器侧配合 `ignoreHTTPSErrors`。
 *
 * 未配置 CDP 时保持原样（127.0.0.1 + http）。
 */
const endpoint = (process.env.WOOHAA_REVIEW_CDP_URL || process.env.ATC_REVIEW_CDP_URL || "").trim();

export const reviewEndpoint = endpoint;
export const reviewMode: "cdp" | "local" = endpoint ? "cdp" : "local";

/** 本机可达地址：优先 WOOHAA_REVIEW_HOST，其次第一个非内部 IPv4。 */
export function localReachableHost(): string {
	const explicit = (process.env.WOOHAA_REVIEW_HOST || "").trim();
	if (explicit) return explicit;
	for (const entries of Object.values(os.networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return "127.0.0.1";
}

/** 浏览器要访问的 host。 */
export const reviewBaseHost = reviewMode === "cdp" ? localReachableHost() : "127.0.0.1";

/** 浏览器要访问的 scheme：远端复核走 https（安全上下文），本机保持 http。 */
export const reviewScheme = reviewMode === "cdp" ? "https" : "http";

/** 浏览器使用的 baseURL。 */
export function reviewBaseUrl(port: number): string {
	return `${reviewScheme}://${reviewBaseHost}:${port}`;
}

/** webServer 就绪探测地址（探测始终从本机出发）。 */
export function reviewProbeUrl(port: number): string {
	return `${reviewScheme}://127.0.0.1:${port}/`;
}

/** `use` 中需要补充的选项。 */
export const reviewUseOptions = reviewMode === "cdp" ? { ignoreHTTPSErrors: true } : {};

/** webServer 需要额外注入的环境变量。 */
export const reviewWebServerEnv: Record<string, string> =
	reviewMode === "cdp" ? { HOST: "0.0.0.0", E2E_TLS: "1" } : {};

/** webServer 探测自签证书时要忽略证书错误。 */
export const reviewWebServerIgnoreHTTPSErrors = reviewMode === "cdp";
