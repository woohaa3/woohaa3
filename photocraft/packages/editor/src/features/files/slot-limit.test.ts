/**
 * 文档槽位上限的唯一真源防漂移
 * （change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * 标签上限的真源是共享 `document-workspace.ts` 的 `MAX_OPEN_DOCUMENTS`（注册表的实际执行者，
 * 也是宿主 `workspace-policy` 读的那一份）。本域的 `requestDocumentSlot` 曾**自带一份
 * `MAX_OPEN_DOCUMENTS = 8`**——这不只是重复，而是两套权威值：一旦共享侧调整，本域提示会
 * 谎报数字，而真正拒绝的理由来自另一处。依赖方向是 editor → protocol，protocol 无法反向
 * import 共享实现，所以现在改为**由调用方传入上限**，本域不再声明这个常量。
 *
 * 这里同时锁两件事：本域不再导出该常量（防止重复回归），且传入工作区真值时行为一致。
 */
import { describe, expect, it } from "vitest";
import * as filesProtocol from "@woohaa3/photocraft-protocol";
import { requestDocumentSlot } from "@woohaa3/photocraft-protocol";
import { MAX_OPEN_DOCUMENTS as WORKSPACE_LIMIT } from "../../document-workspace.js";

describe("文档槽位上限只由共享工作区声明", () => {
  it("本域不再导出一份自己的上限常量", () => {
    expect("MAX_OPEN_DOCUMENTS" in filesProtocol).toBe(false);
  });

  it("用工作区真值调用时，上限前一个槽位可申请、上限本身被拒", () => {
    expect(requestDocumentSlot(WORKSPACE_LIMIT - 1, WORKSPACE_LIMIT)).toEqual({ ok: true });
    expect(requestDocumentSlot(WORKSPACE_LIMIT, WORKSPACE_LIMIT)).toMatchObject({ ok: false });
  });

  it("拒绝原因里的数字来自传入的上限，而不是写死的字面量", () => {
    const denied = requestDocumentSlot(5, 5);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.reason).toContain("5");
    // 换一个上限，提示必须跟着变：写死 8 的实现会在这里失败。
    const other = requestDocumentSlot(3, 3);
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.reason).toContain("3");
  });

  it("非法上限被拒绝，而不是当成永远可申请", () => {
    expect(requestDocumentSlot(0, 0)).toMatchObject({ ok: false });
    expect(requestDocumentSlot(0, Number.NaN)).toMatchObject({ ok: false });
  });
});
