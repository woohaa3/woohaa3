import { expect, it, vi } from "vitest";
import { createCurrentUserService } from "./current-user.js";
import { createIdentitySubjectService } from "./identity-subject.js";
import type { ApplicationRemote } from "./application-remote.js";

const controlled = (subject: string, actions: string[] = []) => ({ accessControl: true, dataScopeId: `user:test:${subject}`, subject, identityProvider: "test", allowedActions: actions, policyVersion: "1" });
function harness(request: ReturnType<typeof vi.fn>) {
  const identity = createIdentitySubjectService();
  const user = createCurrentUserService({ transport: { request } } as unknown as ApplicationRemote, identity);
  return { user, identity };
}

it("默认 session 提供管理资格与实例缓存空间，没有假用户", async () => {
  const { user, identity } = harness(vi.fn().mockResolvedValue({ ok: true, data: { accessControl: false, dataScopeId: "instance:stable" } }));
  expect(user.hasAction("models.manage")).toBe(false);
  await user.refresh();
  expect(user.hasAction("models.manage")).toBe(true);
  expect(identity.namespace()).toBe("instance:stable");
  expect(identity.getSnapshot().identity).toBeNull();
  expect(user.getSnapshot()).not.toHaveProperty("subject");
});

it("受控 action 与数据空间来自通用 session，刷新失败时清除", async () => {
  const request = vi.fn().mockResolvedValueOnce({ ok: true, data: controlled("a", ["models.manage"]) }).mockResolvedValueOnce({ ok: false, code: "unauthorized" });
  const { user, identity } = harness(request);
  await user.refresh();
  expect(user.hasAction("models.manage")).toBe(true);
  expect(user.hasAction("unknown.action")).toBe(false);
  expect(identity.namespace()).toBe("user:test:a");
  await user.refresh();
  expect(user.hasAction("models.manage")).toBe(false);
  expect(identity.namespace()).toBeNull();
});

it.each([null, {}, { subject: "old", identityProvider: "test" }, { accessControl: false }, { accessControl: true, dataScopeId: "user:a" }])("缺失或旧读模型不会开放：%j", async data => {
  const { user } = harness(vi.fn().mockResolvedValue({ ok: true, data }));
  await user.refresh();
  expect(user.getSnapshot()).toBeNull();
  expect(user.hasAction("models.manage")).toBe(false);
});

it("已开放实例的网络失败会清除资格和缓存空间", async () => {
  const { user, identity } = harness(vi.fn().mockResolvedValueOnce({ ok: true, data: { accessControl: false, dataScopeId: "instance:x" } }).mockRejectedValueOnce(new Error("offline")));
  await user.refresh();
  await user.refresh();
  expect(user.getSnapshot()).toBeNull();
  expect(identity.namespace()).toBeNull();
});

it("刷新期间关闭旧资格，乱序与卸载后的响应不能恢复旧空间", async () => {
  const responses: Array<(value: unknown) => void> = [];
  const { user, identity } = harness(vi.fn(() => new Promise(resolve => responses.push(resolve))));
  const first = user.refresh(); const second = user.refresh();
  responses[1]({ ok: true, data: controlled("new") }); await second;
  responses[0]({ ok: true, data: { accessControl: false, dataScopeId: "instance:old" } }); await first;
  expect(identity.namespace()).toBe("user:test:new");
  const third = user.refresh();
  expect(user.getSnapshot()).toBeNull(); expect(identity.namespace()).toBeNull();
  user.dispose();
  responses[2]({ ok: true, data: controlled("late") }); await third;
  expect(user.getSnapshot()).toBeNull(); expect(identity.namespace()).toBeNull();
});
