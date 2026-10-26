/**
 * 开发编排的受控重启判定（change: 2026-10-21-harden-extension-fault-isolation，design D6）。
 *
 * 宿主以退出码 75（restart-requested）退出时，dev 会话重新拉起同一条后端命令而不是结束会话；
 * 但短时间内连续出现（默认 10 秒内连续 5 次）说明宿主一启动就请求重启，按崩溃处理并结束会话，
 * 避免无限循环。其他退出码保持原行为（结束会话）。纯函数，便于单测。
 */

export const RESTART_EXIT_CODE = 75;
export const RESTART_LOOP_LIMIT = 5;
export const RESTART_LOOP_WINDOW_MS = 10_000;

/**
 * 记录一次退出并给出动作。
 *
 * @param {{ restarts: number[] }} state 同一子进程的重启历史（毫秒时间戳），由调用方持有
 * @param {{ code: number | null, signal?: string | null, stopping?: boolean, now?: number,
 *   limit?: number, windowMs?: number }} exit
 * @returns {{ action: "ignore" } | { action: "restart", attempt: number } |
 *   { action: "stop", code: number, reason: "exit" | "restart-loop" }}
 */
export function decideBackendExit(state, exit) {
  if (exit.stopping) return { action: "ignore" };
  const code = exit.code;
  if (code !== RESTART_EXIT_CODE) {
    return { action: "stop", code: code || 1, reason: "exit" };
  }
  const now = exit.now ?? Date.now();
  const limit = exit.limit ?? RESTART_LOOP_LIMIT;
  const windowMs = exit.windowMs ?? RESTART_LOOP_WINDOW_MS;
  // 「连续 N 次且每次间隔都短于窗口」：间隔一旦超过窗口，重新计数。
  const last = state.restarts.at(-1);
  if (last !== undefined && now - last >= windowMs) state.restarts.length = 0;
  state.restarts.push(now);
  if (state.restarts.length >= limit) {
    return { action: "stop", code: RESTART_EXIT_CODE, reason: "restart-loop" };
  }
  return { action: "restart", attempt: state.restarts.length };
}

/**
 * PM2 `stop_exit_codes` 里的退出码不会被拉起：75 一旦列入，受控重启就会变成永久停机。
 * 返回拒绝原因（中文），合法时返回 null。
 */
export function restartExitCodeBlocked(stopExitCodes) {
  if (stopExitCodes === undefined) return null;
  const codes = Array.isArray(stopExitCodes) ? stopExitCodes : [stopExitCodes];
  if (!codes.some((code) => Number(code) === RESTART_EXIT_CODE)) return null;
  return `配置校验拒绝：stop_exit_codes 不得包含 ${RESTART_EXIT_CODE}（受控重启退出码，需由 PM2 重新拉起）`;
}
