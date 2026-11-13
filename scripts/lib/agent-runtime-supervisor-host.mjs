/**
 * 执行器运行时的宿主侧接入：连接既有实例，缺失时才按需拉起。
 *
 * change: 2026-11-10-split-agent-runtime-lifecycle（任务 1.3 / design D5）
 *
 * 运行时是 **workspace 级独立实例**：宿主与开发启动器只负责探活与连接，不拥有它的生命周期。
 * - 先读 `executor.json` 身份快照并 `ping`，workspace/schema 匹配就复用；
 * - 端点缺失或进程已退出才 detached 拉起，且不再传 `--owner-pid`；
 * - `stopWatch()` / `stop()` 只停止探活，不调用 `shutdown`。
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

/** 与 `execution-runtime/src/identity.ts` 对齐（脚本不编译 TS，只读同一份快照）。 */
export const EXECUTOR_IDENTITY_SCHEMA_VERSION = 2;

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
 * 读取身份快照；不在这里创建目录（创建语义归 daemon 与 dev 启动器）。
 * 返回 `{ status: "missing" | "legacy" | "malformed" | "insecure" | "ok", identity? }`。
 */
export function readRuntimeIdentity(runtimeDir) {
	let stat;
	try {
		stat = fs.lstatSync(runtimeDir);
	} catch (error) {
		if (error?.code === "ENOENT") return { status: "missing" };
		return { status: "malformed", message: describeError(error) };
	}
	if (process.platform !== "win32") {
		if (!stat.isDirectory() || stat.isSymbolicLink()) return { status: "insecure", message: "运行时目录必须是真实目录" };
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return { status: "insecure", message: "运行时目录必须属于当前用户" };
		if ((stat.mode & 0o077) !== 0) return { status: "insecure", message: "运行时目录必须为私有目录（0700）" };
	}
	let text;
	try {
		text = fs.readFileSync(path.join(runtimeDir, "executor.json"), "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { status: "missing" };
		return { status: "malformed", message: describeError(error) };
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return { status: "malformed", message: "executor.json 不是合法 JSON" };
	}
	if (!value || typeof value !== "object" || typeof value.schemaVersion !== "number") {
		return { status: "legacy", message: "executor.json 缺少 schemaVersion" };
	}
	const strings = ["workspaceKey", "socketPath", "token", "runtimeVersion"];
	if (strings.some(key => typeof value[key] !== "string" || value[key].trim() === "")
		|| !Number.isInteger(value.pid) || value.pid <= 0
		|| !Number.isFinite(value.startedAt) || value.startedAt <= 0) {
		return { status: "malformed", message: "executor.json 字段不完整" };
	}
	if (value.schemaVersion !== EXECUTOR_IDENTITY_SCHEMA_VERSION) {
		return { status: "incompatible", message: `运行时 schema ${value.schemaVersion} 与当前 ${EXECUTOR_IDENTITY_SCHEMA_VERSION} 不兼容`, identity: value };
	}
	return {
		status: "ok",
		identity: {
			schemaVersion: value.schemaVersion,
			workspaceKey: value.workspaceKey,
			pid: value.pid,
			socketPath: value.socketPath,
			token: value.token,
			startedAt: value.startedAt,
			runtimeVersion: value.runtimeVersion
		}
	};
}

/**
 * @param {{
 *   root: string,
 *   runtimeDir: string,
 *   workspaceKey?: string,
 *   scriptPath?: string,
 *   expectedRuntimeBuild?: string,
 *   canvasWorkspaceRoot?: string,
 *   canvasWorkspaceProtectedPaths?: string[],
 *   rpc?: typeof supervisorRpc,
 *   spawnProcess?: typeof spawn,
 *   stopRuntime?: () => Promise<void>,
 *   readIdentity?: typeof readRuntimeIdentity,
 *   log?: (message: string) => void,
 *   watchIntervalMs?: number,
 *   startupTimeoutMs?: number
 * }} options
 */
export function createAgentSupervisorHost({
	root,
	runtimeDir,
	workspaceKey = hashKey(path.resolve(root)),
	scriptPath = null,
	expectedRuntimeBuild = null,
	canvasWorkspaceRoot = null,
	canvasWorkspaceProtectedPaths = [],
	rpc = supervisorRpc,
	spawnProcess = spawn,
	stopRuntime = null,
	readIdentity = readRuntimeIdentity,
	/**
	 * 启动 daemon 用的 Node 解释器。缺省 `process.execPath`。
	 *
	 * 单文件 SEA 形态里 `process.execPath` 指向 web host 可执行文件本身，用它跑
	 * `dist/cli.js` 会重新执行内嵌 main（SEA 永远跑自己的入口，命令行参数被忽略），
	 * 结果是又起一个 web host 而不是执行器。这类形态必须显式给出真实的 node 路径。
	 */
	nodeBin = process.execPath,
	log = () => undefined,
	watchIntervalMs = SUPERVISOR_WATCH_INTERVAL_MS,
	startupTimeoutMs = STARTUP_TIMEOUT_MS
} = {}) {
	const socketPath = supervisorEndpoint({ workspaceKey, runtimeDir });
	const tokenPath = path.join(runtimeDir, "token");
	const packageDir = path.join(root, "packages", "execution-runtime");
	const script = scriptPath ? path.resolve(scriptPath) : path.join(packageDir, "dist", "cli.js");
	const buildMarkerPath = path.join(runtimeDir, "runtime-build");

	/**
	 * dev 启动器不跑完整 build：只在产物缺失时构建一次，避免每次启动都等打包。
	 * 发行包传入随包 `scriptPath` 时直接用该产物，禁止在只读资源目录里尝试 pnpm。
	 */
	const ensureScript = () => {
		if (scriptPath) {
			if (!fs.existsSync(script)) throw new Error(`执行器运行时缺少随包入口：${script}`);
			return script;
		}
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

	const readBuildMarker = () => {
		try {
			return fs.readFileSync(buildMarkerPath, "utf8").trim();
		} catch (error) {
			if (error?.code === "ENOENT") return "";
			throw error;
		}
	};

	const writeBuildMarker = () => {
		if (!expectedRuntimeBuild) return;
		fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(buildMarkerPath, `${expectedRuntimeBuild}\n`, { mode: 0o600 });
	};

	/** 制品升级：停掉同 workspace 的旧 daemon 后再起随包版本。 */
	const stopExistingRuntime = async () => {
		try {
			execFileSync(nodeBin, [ensureScript(), "runtime", "stop", "--state", runtimeDir, "--workspace", workspaceKey], {
				cwd: root,
				stdio: ["ignore", "pipe", "pipe"],
				encoding: "utf8",
				windowsHide: true,
				timeout: 15_000
			});
		} catch (error) {
			const detail = [error?.stdout, error?.stderr].filter(Boolean).join(" ").trim();
			throw new Error(`旧执行器运行时停止失败：${describeError(error)}${detail ? `（${detail}）` : ""}`);
		}
	};
	const stopRuntimeImpl = stopRuntime ?? stopExistingRuntime;

	/** token 只用于「没有既有身份时的新实例」；已有身份一律复用其 token。 */
	let token = "";
	let config = null;
	let pending = null;
	let timer = null;
	let checking = false;
	let stopped = false;

	const readToken = () => {
		if (token) return token;
		fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") {
			const directory = fs.lstatSync(runtimeDir);
			if (!directory.isDirectory() || directory.isSymbolicLink() || (typeof process.getuid === "function" && directory.uid !== process.getuid()) || (directory.mode & 0o077) !== 0) {
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

	const pingIdentity = async (identity) => {
		const state = await rpc({ socketPath: identity.socketPath, token: identity.token, workspaceKey: identity.workspaceKey }, "ping", {}, PING_TIMEOUT_MS);
		return state?.workspaceKey === workspaceKey;
	};

	const launch = async () => {
		if (stopped) throw new Error("Agent Supervisor 已停止");
		const stored = readIdentity(runtimeDir);
		if (stored.status === "ok") {
			const identity = stored.identity;
			if (identity.workspaceKey !== workspaceKey) {
				throw new Error(`运行时属于其它 workspace（${identity.workspaceKey}），拒绝复用也不结束该实例`);
			}
			let healthy = false;
			try {
				healthy = await pingIdentity(identity);
			} catch (error) {
				log(`执行器运行时探活失败（${describeError(error)}），按缺失处理`);
			}
			if (healthy) {
				const marker = readBuildMarker();
				const workspaceReady = !canvasWorkspaceRoot || await rpc({ socketPath: identity.socketPath, token: identity.token, workspaceKey }, "workspace.settings").then(value => value?.available === true, () => false);
				if ((!expectedRuntimeBuild || marker === expectedRuntimeBuild) && workspaceReady) {
					log(`复用执行器运行时（pid ${identity.pid}，${identity.runtimeVersion}）`);
					return { socketPath: identity.socketPath, token: identity.token, workspaceKey, pid: identity.pid, reused: true };
				}
				log(`执行器运行时制品已更新（${marker || "未记录"} → ${expectedRuntimeBuild}），重启运行时`);
				await stopRuntimeImpl();
			} else {
				log(`执行器运行时端点无响应（pid ${identity.pid}），按缺失处理`);
			}
		} else if (stored.status === "legacy" || stored.status === "incompatible") {
			// 旧运行时不是「缺失」：不接管，也不结束；端点可能仍被它占用。
			throw new Error(`执行器运行时${stored.status === "legacy" ? "缺少身份版本" : "版本不兼容"}：${stored.message}；请显式 runtime stop 后重启`);
		} else if (stored.status === "insecure") {
			throw new Error(`执行器运行时目录不满足私有权限：${stored.message}`);
		}

		const next = { socketPath, token: readToken(), workspaceKey };
		// 命名管道没有 unlink 语义：随最后一个句柄关闭由系统回收，跳过清理。
		if (process.platform !== "win32") {
			try { fs.unlinkSync(socketPath); } catch { /* already removed */ }
		}
		const child = spawnProcess(nodeBin, [ensureScript(), "daemon", "--socket", socketPath, "--state", runtimeDir, "--token", next.token, "--workspace", workspaceKey, ...(canvasWorkspaceRoot ? ["--canvas-workspace-root", canvasWorkspaceRoot, ...canvasWorkspaceProtectedPaths.flatMap(location => ["--canvas-workspace-protected-path", location])] : [])], {
			cwd: root, detached: true, stdio: "ignore", windowsHide: true
		});
		child.unref();
		const deadline = Date.now() + startupTimeoutMs;
		let lastError;
		while (Date.now() < deadline) {
			if (stopped) throw new Error("Agent Supervisor 已停止");
			try {
				const state = await rpc(next, "ping", {}, PING_TIMEOUT_MS);
				if (state?.workspaceKey === workspaceKey) {
					writeBuildMarker();
					return { ...next, pid: state.pid, reused: false };
				}
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
			log(`Agent Supervisor 已恢复（pid ${config?.pid ?? "unknown"}）`);
		} catch (error) {
			log(`Agent Supervisor 自动恢复失败：${error.message}，下一轮继续重试`);
		} finally {
			checking = false;
		}
	};

	/** 只停止探活；运行时继续存活（spec: 启动器退出不停止运行时）。 */
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
		config = null;
	};

	return { socketPath, readToken, ensure, ping, check, startWatch, stopWatch, stop };
}
