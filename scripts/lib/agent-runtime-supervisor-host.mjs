/**
 * Agent Supervisor 的宿主侧生命周期：启动、探活与自动重启。
 *
 * Supervisor 是 dev 启动器拉起的独立进程，后端只是它的客户端。二者生命周期不同：
 * 后端由 `node --watch` 长期持有，Supervisor 却可能在开发过程中被外部清理（清理脚本、
 * OOM、`kill -9`）——此后后端的每一次 ensure 都变成裸的
 * `connect ENOENT .../supervisor.sock`，页面表现为「生成」直接失败，而且不会自己恢复。
 *
 * 这里把「Supervisor 必须存在」变成启动器持续维持的不变量：`startWatch()` 定时 ping，
 * 端点消失或换了 workspace 就重新拉起。socket 路径、token 与 workspaceKey 保持不变，
 * 因此已经持有这些环境变量的后端无需重启，下一次请求即可连上新的 Supervisor。
 *
 * 端点命名与 Windows 差异见 ./agent-runtime-endpoints.mjs。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { hashKey, supervisorEndpoint } from "./agent-runtime-endpoints.mjs";

/** 默认探活间隔：足够快地把故障窗口缩到 2 秒级，又不至于频繁写日志。 */
export const SUPERVISOR_WATCH_INTERVAL_MS = 2000;

/** 单次 RPC 的上限；Supervisor 卡死时不能让探活永远挂着。 */
const RPC_TIMEOUT_MS = 3000;
/** 探活使用更短的超时：卡死的进程也要在下一轮之前被判定为不可用。 */
const PING_TIMEOUT_MS = 2000;
const STARTUP_TIMEOUT_MS = 5000;

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function describeError(error) {
	return `${error?.code ?? ""} ${error?.message ?? error}`.trim();
}

/** 与服务端 JSONL 协议一致的 RPC 客户端（dev 启动器与测试共用）。 */
export function supervisorRpc(config, method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(config.socketPath);
		let buffer = "";
		const id = Date.now();
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("Agent Supervisor 连接超时")); }, timeoutMs);
		const finish = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += String(chunk);
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) continue;
				try {
					const response = JSON.parse(line);
					if (response.id !== id) continue;
					if (response.ok) finish(null, response.result);
					else finish(new Error(response.error || "Agent Supervisor 请求失败"));
				} catch { /* 等待完整 JSON 行 */ }
			}
		});
		socket.once("error", error => finish(error));
		socket.once("connect", () => socket.write(JSON.stringify({ id, token: config.token, workspaceKey: config.workspaceKey, method, params }) + "\n"));
	});
}

/**
 * @param {{
 *   root: string,
 *   runtimeDir: string,
 *   workspaceKey?: string,
 *   rpc?: typeof supervisorRpc,
 *   log?: (message: string) => void,
 *   watchIntervalMs?: number,
 *   startupTimeoutMs?: number
 * }} options
 */
export function createAgentSupervisorHost({
	root,
	runtimeDir,
	workspaceKey = hashKey(path.resolve(root)),
	rpc = supervisorRpc,
	log = () => undefined,
	watchIntervalMs = SUPERVISOR_WATCH_INTERVAL_MS,
	startupTimeoutMs = STARTUP_TIMEOUT_MS
} = {}) {
	const socketPath = supervisorEndpoint({ workspaceKey, runtimeDir });
	const tokenPath = path.join(runtimeDir, "token");
	const packageDir = path.join(root, "packages", "execution-runtime");
	const script = path.join(packageDir, "dist", "cli.js");

	/** dev 启动器不跑完整 build：只在产物缺失时构建一次，避免每次启动都等打包。 */
	const ensureScript = () => {
		if (!fs.existsSync(script)) {
			try {
				execFileSync("pnpm", ["-C", "web", "--filter", "woohaa3-executor", "run", "build"], {
					cwd: root,
					stdio: "inherit",
					shell: process.platform === "win32"
				});
			} catch (error) {
				throw new Error(`woohaa3-executor 构建失败：${describeError(error)}`);
			}
			if (!fs.existsSync(script)) throw new Error("woohaa3-executor 构建后仍缺少 dist/cli.js");
		}
		return script;
	};
	/** token 在本次会话内固定：文件被删掉后重建新 token 会让已注入后端的环境失效。 */
	let token = "";
	let config = null;
	let pending = null;
	let timer = null;
	let checking = false;
	let stopped = false;

	const readToken = () => {
		if (token) return token;
		fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        if(process.platform!=="win32") {
            const directory=fs.lstatSync(runtimeDir);
            if(!directory.isDirectory() || directory.isSymbolicLink() || directory.uid!==process.getuid() || (directory.mode & 0o077)!==0) {
                throw new Error("Agent runtime directory must be a private directory owned by the current user");
            }
        }
		token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8").trim() : "";
		if (!token) {
			token = crypto.randomBytes(32).toString("hex");
			fs.writeFileSync(tokenPath, token, { mode: 0o600 });
		}
		return token;
	};

	const launch = async () => {
		if (stopped) throw new Error("Agent Supervisor 已停止");
		const next = { socketPath, token: readToken(), workspaceKey };
		if (fs.existsSync(socketPath)) {
			try {
				const state = await rpc(next, "ping", {}, PING_TIMEOUT_MS);
				if (state?.workspaceKey === workspaceKey) return { ...next, pid: state.pid };
			} catch (error) {
				log(`Agent Supervisor 端点不可用（${describeError(error)}），重新拉起`);
			}
			// 命名管道没有 unlink 语义：随最后一个句柄关闭由系统回收，跳过清理。
			if (process.platform !== "win32") {
				try { fs.unlinkSync(socketPath); } catch { /* already removed */ }
			}
		}
		const child = spawn(process.execPath, [ensureScript(), "daemon", "--socket", socketPath, "--state", runtimeDir, "--token", next.token, "--workspace", workspaceKey, "--owner-pid", String(process.pid)], {
			cwd: root, detached: true, stdio: "ignore", windowsHide: true
		});
		child.unref();
		const deadline = Date.now() + startupTimeoutMs;
		let lastError;
		while (Date.now() < deadline) {
			if (stopped) throw new Error("Agent Supervisor 已停止");
			try {
				const state = await rpc(next, "ping", {}, PING_TIMEOUT_MS);
				if (state?.workspaceKey === workspaceKey) return { ...next, pid: state.pid };
			} catch (error) {
				lastError = error;
				await delay(100);
			}
		}
		throw new Error(`Agent Supervisor 启动超时${lastError ? `（${describeError(lastError)}）` : ""}`);
	};

	/** 幂等：启动期与探活可能并发调用，只允许一次 spawn。 */
	const ensure = () => {
		if (pending) return pending;
		pending = (async () => {
			const next = await launch();
			config = next;
			return next;
		})().finally(() => { pending = null; });
		return pending;
	};

	const ping = async () => {
		if (!config) throw new Error("Agent Supervisor 尚未启动");
		return rpc(config, "ping", {}, PING_TIMEOUT_MS);
	};

	const check = async () => {
		if (stopped || checking || pending) return;
		checking = true;
		try {
			if (config) {
				try {
					const state = await rpc(config, "ping", {}, PING_TIMEOUT_MS);
					if (state?.workspaceKey === workspaceKey) return;
				} catch (error) {
					log(`Agent Supervisor 无响应（${describeError(error)}），自动重启中`);
				}
			}
			config = null;
			await ensure();
			log(`Agent Supervisor 已重启（pid ${config?.pid ?? "unknown"}）`);
		} catch (error) {
			log(`Agent Supervisor 自动重启失败：${error.message}，下一轮继续重试`);
		} finally {
			checking = false;
		}
	};

	const stopWatch = () => {
		if (timer) clearInterval(timer);
		timer = null;
	};

	const startWatch = () => {
		if (timer || stopped) return;
		timer = setInterval(() => void check(), watchIntervalMs);
		timer.unref?.();
	};

	const stop = async () => {
		stopped = true;
		stopWatch();
		if (pending) await pending.catch(() => undefined);
		const current = config;
		config = null;
		if (!current) return;
		try { await rpc(current, "shutdown", {}, PING_TIMEOUT_MS); } catch { /* supervisor may already be gone */ }
	};

	return { socketPath, readToken, ensure, ping, startWatch, stopWatch, stop };
}
