import assert from "node:assert/strict";
import test from "node:test";
import { RESTART_EXIT_CODE, decideBackendExit } from "./dev-restart-policy.mjs";

test("退出码 75 且非主动停止：重新拉起", () => {
  const state = { restarts: [] };
  assert.deepEqual(decideBackendExit(state, { code: RESTART_EXIT_CODE, now: 0 }), { action: "restart", attempt: 1 });
});

test("其他退出码：结束会话（保持原行为），0 也按失败码 1 结束", () => {
  const state = { restarts: [] };
  assert.deepEqual(decideBackendExit(state, { code: 2 }), { action: "stop", code: 2, reason: "exit" });
  assert.deepEqual(decideBackendExit(state, { code: null, signal: "SIGKILL" }), { action: "stop", code: 1, reason: "exit" });
  assert.deepEqual(decideBackendExit(state, { code: 0 }), { action: "stop", code: 1, reason: "exit" });
});

test("会话停止中：忽略退出", () => {
  assert.deepEqual(decideBackendExit({ restarts: [] }, { code: RESTART_EXIT_CODE, stopping: true }), { action: "ignore" });
});

test("10 秒内连续 5 次 75：按崩溃结束会话", () => {
  const state = { restarts: [] };
  const results = [0, 1000, 2000, 3000, 4000].map((now) => decideBackendExit(state, { code: RESTART_EXIT_CODE, now }));
  assert.deepEqual(results.slice(0, 4).map((r) => r.action), ["restart", "restart", "restart", "restart"]);
  assert.deepEqual(results[4], { action: "stop", code: RESTART_EXIT_CODE, reason: "restart-loop" });
});

test("间隔超过窗口后重新计数，不误判循环", () => {
  const state = { restarts: [] };
  for (const now of [0, 1000, 2000, 3000]) decideBackendExit(state, { code: RESTART_EXIT_CODE, now });
  assert.deepEqual(decideBackendExit(state, { code: RESTART_EXIT_CODE, now: 20_000 }), { action: "restart", attempt: 1 });
});
