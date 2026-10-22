/**
 * 多文档工作区注册表回归
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 1.2/1.4）。
 *
 * 覆盖身份分源、同节点去重、复制节点与同名文件隔离、关闭邻项、代际隔离与数量上限；
 * 纯状态机，不加载内核、不采集渲染。
 */
import { describe, expect, it } from "vitest";
import {
  EditorDocumentRegistry,
  MAX_OPEN_DOCUMENTS,
  neighbourAfterClose,
  nodeDocumentId
} from "../src/document-workspace.js";

function registry(limit?: number) {
  return new EditorDocumentRegistry(limit);
}

describe("文档身份与去重", () => {
  it("同一节点复用条目，复制节点与同名文件各自独立", () => {
    const documents = registry();
    const first = documents.open({ kind: "node", canvasId: "c1", nodeId: "n1", name: "图片 1" });
    const again = documents.open({ kind: "node", canvasId: "c1", nodeId: "n1", name: "图片 1（改名）" });
    expect(first).toMatchObject({ ok: true, created: true, id: nodeDocumentId("c1", "n1") });
    // 复用不递增代际，名称随权威节点更新。
    expect(again).toMatchObject({ ok: true, created: false, generation: 1 });
    expect(documents.snapshotState().entries).toHaveLength(1);
    expect(documents.snapshotState().entries[0]!.name).toBe("图片 1（改名）");

    // 复制节点（新 nodeId）即使共用媒体也不合并；另一画布的同名节点同样独立。
    documents.open({ kind: "node", canvasId: "c1", nodeId: "n1-copy", name: "图片 1" });
    documents.open({ kind: "node", canvasId: "c2", nodeId: "n1", name: "图片 1" });
    expect(documents.snapshotState().entries).toHaveLength(3);
    expect(new Set(documents.snapshotState().entries.map((entry) => entry.id)).size).toBe(3);
  });

  it("同名文件每次打开都是新条目；空文件名被拒绝且不留条目", () => {
    const documents = registry();
    const first = documents.open({ kind: "file", fileName: "same.png" });
    const second = documents.open({ kind: "file", fileName: "same.png" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.id).not.toBe(second.id);
    expect(documents.snapshotState().entries).toHaveLength(2);
    expect(documents.open({ kind: "file", fileName: "   " })).toMatchObject({ ok: false, code: "invalid" });
    expect(documents.snapshotState().entries).toHaveLength(2);
  });

  it("达到上限拒绝新打开，既有条目仍可激活", () => {
    const documents = registry(2);
    const first = documents.open({ kind: "file", fileName: "a.png" });
    documents.open({ kind: "file", fileName: "b.png" });
    const rejected = documents.open({ kind: "file", fileName: "c.png" });
    expect(rejected).toMatchObject({ ok: false, code: "limit" });
    if (rejected.ok) return;
    expect(rejected.reason).toContain("最多同时打开 2 个文档");
    expect(documents.snapshotState().entries).toHaveLength(2);
    if (!first.ok) return;
    expect(documents.activate(first.id)).toMatchObject({ ok: true, changed: true });
  });

  it("默认上限为 8 个文档", () => {
    expect(MAX_OPEN_DOCUMENTS).toBe(8);
    const documents = registry();
    for (let index = 0; index < MAX_OPEN_DOCUMENTS; index++) {
      expect(documents.open({ kind: "file", fileName: `f${index}.png` }).ok).toBe(true);
    }
    expect(documents.open({ kind: "file", fileName: "overflow.png" })).toMatchObject({ ok: false, code: "limit" });
  });
});

describe("激活、关闭与顺序", () => {
  it("关闭活动项优先左邻，其次右邻；最后一项关闭后无活动项", () => {
    const documents = registry();
    const a = documents.open({ kind: "file", fileName: "a.png" });
    const b = documents.open({ kind: "file", fileName: "b.png" });
    const c = documents.open({ kind: "file", fileName: "c.png" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("open failed");
    // 顺序按打开顺序，激活不重排。
    const order = () => documents.snapshotState().entries.map((entry) => entry.id);
    expect(order()).toEqual([a.id, b.id, c.id]);
    documents.activate(a.id);
    expect(order()).toEqual([a.id, b.id, c.id]);

    // 关闭中间项：活动项不变。
    expect(documents.close(b.id)).toMatchObject({ ok: true, nextActiveId: a.id });
    // 关闭活动项 c 无左邻以外：左邻是 a（只剩 a、c）→ a。
    expect(documents.close(c.id)).toMatchObject({ ok: true, nextActiveId: a.id });
    expect(documents.close(a.id)).toMatchObject({ ok: true, nextActiveId: null });
    expect(documents.snapshotState().activeId).toBeNull();
  });

  it("关闭非活动项不改活动项；关闭未知项返回失败", () => {
    const documents = registry();
    const a = documents.open({ kind: "file", fileName: "a.png" });
    const b = documents.open({ kind: "file", fileName: "b.png" });
    if (!a.ok || !b.ok) return;
    expect(documents.close(a.id)).toMatchObject({ ok: true, nextActiveId: b.id });
    expect(documents.close("file:missing")).toMatchObject({ ok: false, code: "missing" });
  });

  it("neighbourAfterClose 预览左邻优先规则", () => {
    const documents = registry();
    documents.open({ kind: "file", fileName: "a.png" });
    const b = documents.open({ kind: "file", fileName: "b.png" });
    const c = documents.open({ kind: "file", fileName: "c.png" });
    if (!b.ok || !c.ok) throw new Error("open failed");
    const entries = documents.snapshotState().entries;
    expect(neighbourAfterClose(entries, b.id)).toBe(entries[0]!.id);
    expect(neighbourAfterClose(entries, c.id)).toBe(b.id);
    expect(neighbourAfterClose(entries, "missing")).toBeNull();
  });
});

describe("代际与门禁", () => {
  it("关闭重开后得到新代际，旧回调失效", () => {
    const documents = registry();
    const first = documents.open({ kind: "node", canvasId: "c1", nodeId: "n1", name: "A" });
    if (!first.ok) return;
    expect(documents.isCurrent(first.id, first.generation)).toBe(true);
    documents.close(first.id);
    const reopened = documents.open({ kind: "node", canvasId: "c1", nodeId: "n1", name: "A" });
    if (!reopened.ok) return;
    expect(reopened.generation).toBeGreaterThan(first.generation);
    expect(documents.isCurrent(first.id, first.generation)).toBe(false);
    expect(documents.isCurrent(reopened.id, reopened.generation)).toBe(true);
    // 迟到结果不得复活已关闭项。
    expect(documents.update("node:c1:gone", { status: "dirty" })).toBe(false);
  });

  it("门禁存在时拒绝切换，重复激活同一项仍是无操作", () => {
    const documents = registry();
    const a = documents.open({ kind: "file", fileName: "a.png" });
    const b = documents.open({ kind: "file", fileName: "b.png" });
    if (!a.ok || !b.ok) return;
    documents.activate(a.id);
    documents.setGate(a.id, "请先确认或取消文字编辑");
    expect(documents.snapshotState().activeGate).toBe("请先确认或取消文字编辑");
    expect(documents.activate(b.id)).toMatchObject({ ok: false, code: "gate" });
    expect(documents.snapshotState().activeId).toBe(a.id);
    expect(documents.activate(a.id)).toMatchObject({ ok: true, changed: false });
    documents.setGate(a.id, null);
    expect(documents.activate(b.id)).toMatchObject({ ok: true, changed: true });
  });

  it("文档级状态独立：后台失败不写到活动文档", () => {
    const documents = registry();
    const a = documents.open({ kind: "file", fileName: "a.png" });
    const b = documents.open({ kind: "file", fileName: "b.png" });
    if (!a.ok || !b.ok) return;
    documents.activate(b.id);
    documents.update(a.id, { status: "error", message: "保存失败" });
    const entries = documents.snapshotState().entries;
    expect(entries.find((entry) => entry.id === a.id)).toMatchObject({ status: "error", message: "保存失败" });
    expect(entries.find((entry) => entry.id === b.id)).toMatchObject({ status: "clean", message: null });
    expect(documents.unsettled().map((entry) => entry.id)).toEqual([a.id]);
  });

  it("独立文件成功发布为节点后原位绑定，保留顺序与代际", () => {
    const documents = registry();
    const file = documents.open({ kind: "file", fileName: "art.png" });
    const tail = documents.open({ kind: "node", canvasId: "c1", nodeId: "n9", name: "其它" });
    if (!file.ok || !tail.ok) return;
    const rebound = documents.rebindToNode(file.id, { canvasId: "c1", nodeId: "n1", name: "作品 1" });
    expect(rebound).toMatchObject({ id: file.id, name: "作品 1", writable: true });
    expect(rebound?.source).toEqual({ kind: "node", canvasId: "c1", nodeId: "n1" });
    expect(documents.snapshotState().entries.map((entry) => entry.id)).toEqual([file.id, tail.id]);
    expect(documents.findByNode("c1", "n1")?.id).toBe(file.id);
  });
});
