#!/usr/bin/env node
/**
 * E2E / 复核服务的可选 TLS。
 *
 * 复核浏览器（CDP）通常通过内网地址访问 agent 上的服务，而 `http://<内网 IP>` 不是
 * 安全上下文：`navigator.gpu`、Service Worker、`crypto.subtle` 等能力都会缺失。
 * 用这种页面得出的 GPU / 视觉复核结论不可信，所以远端复核模式要改用 HTTPS。
 *
 * `E2E_TLS=1` 时返回 https server；证书优先读 `E2E_TLS_CERT` / `E2E_TLS_KEY`，
 * 否则用 openssl 生成一次性自签证书（配合 Playwright `ignoreHTTPSErrors`）。
 * 未开启时行为不变，仍是 http。
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function tlsEnabled(env = process.env) {
	return (env.E2E_TLS || "").trim() === "1";
}

/** 服务地址的 scheme，与 `createReviewServer` 保持一致。 */
export function reviewScheme(env = process.env) {
	return tlsEnabled(env) ? "https" : "http";
}

function selfSignedCertificate() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa-e2e-tls-"));
	const key = path.join(dir, "key.pem");
	const cert = path.join(dir, "cert.pem");
	try {
		execFileSync(
			"openssl",
			[
				"req", "-x509", "-newkey", "rsa:2048", "-nodes",
				"-keyout", key, "-out", cert,
				"-days", "2",
				"-subj", "/CN=woohaa-e2e-review",
			],
			{ stdio: "ignore" }
		);
	} catch (error) {
		throw new Error(
			`E2E_TLS=1 需要 openssl 生成自签证书，或显式提供 E2E_TLS_CERT / E2E_TLS_KEY：${error.message}`
		);
	}
	return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

export function tlsOptions(env = process.env) {
	if (env.E2E_TLS_CERT && env.E2E_TLS_KEY) {
		return { cert: fs.readFileSync(env.E2E_TLS_CERT), key: fs.readFileSync(env.E2E_TLS_KEY) };
	}
	return selfSignedCertificate();
}

/** 按 `E2E_TLS` 创建 http 或 https server。 */
export function createReviewServer(handler, env = process.env) {
	return tlsEnabled(env) ? https.createServer(tlsOptions(env), handler) : http.createServer(handler);
}
