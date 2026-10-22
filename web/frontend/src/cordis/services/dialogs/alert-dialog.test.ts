/**
 * AlertDialog 异步动作注册（change: add-frontend-dialog-system，任务 2.3 / 5.1）。
 *
 * store 不保存业务闭包：payload 携带 actionKey，异步动作由 registry 解析。
 */
import { describe, expect, it } from "vitest";
import { alertDefinition, registerAlertAction, resolveAlertAction } from "./alert-dialog.js";

describe("alert action registry", () => {
  it("注册后可解析，注销后不可解析", () => {
    const action = async () => ({ ok: true as const });
    const unregister = registerAlertAction("delete-snippet-1", action);
    expect(resolveAlertAction("delete-snippet-1")).toBe(action);
    unregister();
    expect(resolveAlertAction("delete-snippet-1")).toBeNull();
  });

  it("未知或缺失 actionKey 返回 null", () => {
    expect(resolveAlertAction("nope")).toBeNull();
    expect(resolveAlertAction(undefined)).toBeNull();
  });

  it("payload 校验要求非空标题与描述", () => {
    expect(alertDefinition.validatePayload({ title: "t", description: "d" }).ok).toBe(true);
    expect(alertDefinition.validatePayload({ title: "", description: "d" }).ok).toBe(false);
    expect(alertDefinition.validatePayload({ title: "t" }).ok).toBe(false);
  });

  it("actionKey 与 danger 被规范化", () => {
    const result = alertDefinition.validatePayload({
      title: "删除",
      description: "不可撤销",
      actionKey: "del-1",
      danger: true
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.payload as { actionKey: string }).actionKey).toBe("del-1");
      expect((result.payload as { danger: boolean }).danger).toBe(true);
    }
  });
});
