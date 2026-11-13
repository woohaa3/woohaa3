/**
 * Agent runtime 的端点命名与子进程启动目标（issue #15 / #17）。
 *
 * Windows 没有 Unix domain socket 的文件语义：`net.Server#listen(<文件路径>)` 恒返回
 * `EACCES` 且不触发监听回调，开发启动会卡在「Agent Supervisor 启动超时」。因此两个端点
 * （supervisor 控制通道与每个连接的 stdio 通道）在 win32 上一律改用**命名管道**；
 * 端点字符串原样经 supervisor RPC 传给 local-agent 的 `net.createConnection`，两种形式它都接受。
 *
 * 命名管道是全机器共享的命名空间，不像 `.local/` 下的文件那样按 checkout 隔离，所以管道名
 * 必须带上 workspaceKey / key 摘要，否则两个 checkout 会抢同一个名字。
 *
 * 同理，Windows 上 npm / pnpm 全局安装的 CLI 是 `.cmd` / `.bat` 批处理垫片，Node 不能直接
 * exec：`spawn` 会**同步抛 EINVAL**（不是 `error` 事件），必须交给 shell 执行。shell 模式下
 * 参数按空格拼接，空参数要显式写成 `""`，否则会被吞掉。与 local-agent 的
 * `packages/execution-runtime/src/endpoints.ts` 保持一致。
 *
 * platform 由调用方显式传入（默认 `process.platform`），让两个分支都能在任意机器上被测试。
 */

import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

/** 需要走命名管道与 shell 包装的平台。 */
export const WINDOWS = "win32";

/** 批处理垫片后缀：这些文件在 Windows 上不能作为可执行文件直接 spawn。 */
export const BATCH_SUFFIX = /\.(cmd|bat)$/i;

const isWindows = platform => platform === WINDOWS;

/** key 的稳定摘要：端点名与 journal 文件名共用，避免把原始 key 暴露在管道名里。 */
export function hashKey(value) {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, 40);
}

/**
 * supervisor 控制通道端点。
 *
 * @param {{ platform?: string, workspaceKey: string, runtimeDir: string }} options
 */
export function supervisorEndpoint({ platform = process.platform, workspaceKey, runtimeDir } = {}) {
	if (isWindows(platform)) return `\\\\.\\pipe\\woohaa-agent-${workspaceKey}`;
	return path.join(runtimeDir, "supervisor.sock");
}

/**
 * 单个 Agent 连接的 stdio 通道端点。
 *
 * @param {{ platform?: string, key: string, stdioDir: string }} options
 */
export function stdioEndpoint({ platform = process.platform, key, stdioDir } = {}) {
	if (isWindows(platform)) return `\\\\.\\pipe\\woohaa-agent-stdio-${hashKey(key)}`;
	return path.join(stdioDir, `${hashKey(key)}.sock`);
}

/** Reserve space for the full stdio path, not just supervisor.sock. */
export function agentRuntimeDirectory({root, platform=process.platform, tempDir=os.tmpdir(), uid=process.getuid?.() ?? "user"}={}) {
 const local=path.join(root,".local","agent-runtime");
 if(isWindows(platform))return local;
 const fits=dir=>Buffer.byteLength(stdioEndpoint({platform,key:"maximum",stdioDir:path.join(dir,"stdio")}))<104;
 if(fits(local))return local;
 const digest=hashKey(path.resolve(root)).slice(0,20);
 const temporary=path.join(tempDir,`woohaa-agent-${uid}-${digest}`);
 if(fits(temporary))return temporary;
 // macOS TMPDIR itself can be too long for AF_UNIX. Ownership is checked by the host.
 const short=path.join("/tmp",`wa-${uid}-${digest}`);
 if(!fits(short))throw new Error("Agent runtime socket directory exceeds Unix path limit");
 return short;
}

/**
 * 解析实际的 spawn 目标：Windows 的批处理垫片需要 shell 包装并给命令加引号。
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {string} [platform]
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function resolveSpawnTarget(command, args = [], platform = process.platform) {
	if (!isWindows(platform) || !BATCH_SUFFIX.test(command)) return { command, args, shell: false };
	return {
		command: `"${command}"`,
		args: args.map(arg => (arg === "" ? '""' : arg)),
		shell: true
	};
}
