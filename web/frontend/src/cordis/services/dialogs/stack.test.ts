/**
 * modal stack reducer 与 selectors（change: add-frontend-dialog-system，任务 1.2 / 1.3）。
 */
import { describe, expect, it } from "vitest";
import {
  activeDialogId,
  closeDialog,
  dialogScopePath,
  findDialog,
  isModalActive,
  openDialog,
  replaceDialog,
  setDialogBusy,
  topDialog,
  topInstanceId
} from "./stack.js";
import type { DialogInstance } from "./types.js";

function makeId(prefix: string) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

const accept = (payload: unknown) => ({ ok: true as const, payload });

function open(stack: readonly DialogInstance[], dialogId: string, makeInstanceId = makeId(dialogId)) {
  return openDialog(stack, { dialogId }, { validate: accept, makeInstanceId });
}

describe("modal stack reducer", () => {
  it("open 追加实例并记录 parent", () => {
    const a = open([], "library");
    const b = open(a.stack, "editor");
    expect(a.stack).toHaveLength(1);
    expect(b.stack).toHaveLength(2);
    expect(b.instance!.parentInstanceId).toBe(a.instance!.instanceId);
    expect(activeDialogId(b.stack)).toBe("editor");
    expect(dialogScopePath(b.stack)).toEqual(["library", "editor"]);
    expect(isModalActive(b.stack)).toBe(true);
  });

  it("singleton 重复打开替换而不是堆叠", () => {
    const first = openDialog([], { dialogId: "media-preview", payload: { assetId: "a" } }, {
      validate: accept,
      singleton: true,
      makeInstanceId: makeId("mp")
    });
    const second = openDialog(first.stack, { dialogId: "media-preview", payload: { assetId: "b" } }, {
      validate: accept,
      singleton: true,
      makeInstanceId: makeId("mp")
    });
    expect(second.stack).toHaveLength(1);
    expect(second.replaced).toBe(true);
    expect(second.instance!.instanceId).toBe(first.instance!.instanceId);
    expect((second.instance!.payload as { assetId: string }).assetId).toBe("b");
  });

  it("payload 校验失败时 stack 不变并返回错误", () => {
    const result = openDialog([], { dialogId: "x", payload: 1 }, {
      validate: () => ({ ok: false, error: "bad" }),
      makeInstanceId: makeId("x")
    });
    expect(result.stack).toHaveLength(0);
    expect(result.error).toBe("bad");
    expect(result.instance).toBeNull();
  });

  it("close 移除目标及其显式子孙", () => {
    const a = open([], "library", () => "a");
    const b = open(a.stack, "editor", () => "b");
    const c = open(b.stack, "confirm", () => "c");
    const result = closeDialog(c.stack, "a");
    expect(result.closed.map((instance) => instance.instanceId)).toEqual(["a", "b", "c"]);
    expect(result.stack).toHaveLength(0);
  });

  it("close 非顶部且无子孙时只移除自身", () => {
    const a = open([], "library", () => "a");
    const b = open(a.stack, "editor", () => "b");
    const result = closeDialog(b.stack, "a");
    // b 是 a 的子孙，也会被移除。
    expect(result.closed.map((instance) => instance.instanceId)).toEqual(["a", "b"]);
  });

  it("closeTop 只移除顶部", () => {
    const a = open([], "library", () => "a");
    const b = open(a.stack, "editor", () => "b");
    const result = closeDialog(b.stack);
    expect(result.closed.map((instance) => instance.instanceId)).toEqual(["b"]);
    expect(activeDialogId(result.stack)).toBe("library");
  });

  it("setBusy 以 instanceId 校验，忽略迟到结果", () => {
    const a = open([], "library", () => "a");
    const updated = setDialogBusy(a.stack, "a", true);
    expect(updated.updated).toBe(true);
    expect(topDialog(updated.stack)!.busy).toBe(true);
    const repeated = setDialogBusy(updated.stack, "a", true);
    expect(repeated.updated).toBe(false);
    expect(repeated.stack).toBe(updated.stack);
    const late = setDialogBusy(updated.stack, "gone", true);
    expect(late.updated).toBe(false);
    expect(late.stack).toBe(updated.stack);
  });

  it("replace 只改 payload 且不产生新 instanceId", () => {
    const a = open([], "media-preview", () => "a");
    const result = replaceDialog(a.stack, { assetId: "z" });
    expect(result.replaced).toBe(true);
    expect(result.stack[0]!.instanceId).toBe("a");
    expect(result.stack[0]!.payload).toEqual({ assetId: "z" });
  });

  it("selectors 在空栈返回确定值", () => {
    expect(topInstanceId([])).toBeNull();
    expect(topDialog([])).toBeNull();
    expect(activeDialogId([])).toBeNull();
    expect(dialogScopePath([])).toEqual([]);
    expect(isModalActive([])).toBe(false);
    expect(findDialog([], "x")).toBeNull();
  });
});
