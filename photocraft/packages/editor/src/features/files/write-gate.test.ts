/**
 * 文件域写入门禁与请求序号回归
 * （change: 2026-10-22-add-photocraft-file-workflows，任务 3.3）。
 *
 * 这些断言针对的是**真实存在过的缺口**：保存/导出进行中仍可新建、复制、恢复或写元数据，
 * 于是产物对应的修订与用户看到的画面不一致；以及先发起的异步打开后完成时抢走呈现。
 */
import { describe, expect, it } from "vitest";
import { RequestSequence, planFileWrite } from "./write-gate.js";

describe("写入前统一门禁", () => {
  it("导出冻结期间拒绝，并说明是在导出而不是报没有文档", () => {
    expect(planFileWrite({ phase: "freezing" })).toMatchObject({ ok: false, code: "exporting" });
  });

  it("保存进行中或仍有待重试产物时拒绝", () => {
    expect(planFileWrite({ phase: "saving" })).toMatchObject({ ok: false, code: "saving" });
    expect(planFileWrite({ phase: "idle", pendingArtifacts: true })).toMatchObject({ ok: false, code: "saving" });
  });

  it("未结算草稿拒绝", () => {
    expect(planFileWrite({ phase: "editing", draft: true })).toMatchObject({ ok: false, code: "draft" });
  });

  it("需要文档的操作在没有文档时拒绝；新建（不要求文档）放行", () => {
    expect(planFileWrite({ phase: "idle", hasDocument: false, requireDocument: true }))
      .toMatchObject({ ok: false, code: "no-document" });
    expect(planFileWrite({ phase: "idle", hasDocument: false })).toEqual({ ok: true });
  });

  it("优先级：导出/保存先于草稿与缺文档（按提示去新建只会更糟）", () => {
    expect(planFileWrite({ phase: "saving", draft: true, hasDocument: false, requireDocument: true }))
      .toMatchObject({ code: "saving" });
    expect(planFileWrite({ phase: "freezing", draft: true })).toMatchObject({ code: "exporting" });
  });

  it("精简宿主省略阶段字段时按不阻塞处理", () => {
    expect(planFileWrite({})).toEqual({ ok: true });
  });
});

describe("请求序号：只有最新请求可以改变呈现", () => {
  it("后完成的旧请求被识别为非最新", () => {
    const sequence = new RequestSequence();
    const first = sequence.next("open");
    const second = sequence.next("open");
    expect(sequence.isLatest("open", first)).toBe(false);
    expect(sequence.isLatest("open", second)).toBe(true);
    expect(sequence.current("open")).toBe(2);
  });

  it("不同 key 互不影响（打开与保存各自的序号）", () => {
    const sequence = new RequestSequence();
    const open = sequence.next("open");
    sequence.next("save");
    expect(sequence.isLatest("open", open)).toBe(true);
  });

  it("作废后所有在途请求失效（释放工作区/切页）", () => {
    const sequence = new RequestSequence();
    const token = sequence.next("open");
    sequence.invalidate("open");
    expect(sequence.isLatest("open", token)).toBe(false);
  });

  it("从 0 开始计（从未发起时为 0）", () => {
    expect(new RequestSequence().current("open")).toBe(0);
  });
});
