/**
 * 并排双视图的布局规则（U72）。
 *
 * 只测纯决定：什么时候并排、每个窗格绑定哪个视图、活动视图用哪份取景。像素/手势/历史的
 * 共享由「同一段画布代码 + 同一份控制器」保证，不需要在这里重复证明。
 */
import { describe, expect, it } from "vitest";
import { paneViewport, splitPanes, syncPaneViewports } from "./panes.js";

const view = (id: string, label: string, active = false) => ({ id, label, active });
const host = { x: 12, y: -8, zoom: 0.5 };

describe("splitPanes", () => {
  it("未开开关或只有一个视图时不并排（保留原来的单画布路径）", () => {
    expect(splitPanes(undefined)).toBeNull();
    expect(splitPanes({})).toBeNull();
    expect(splitPanes({ sideBySide: false, views: [view("view-1", "视图 1", true)] })).toBeNull();
    // 开关打开但没有第二个视图：内核已经拒绝过，这里也不能凭空造一个窗格。
    expect(splitPanes({ sideBySide: true, views: [view("view-1", "视图 1", true)] })).toBeNull();
  });

  it("开关打开且有两个以上视图时按内核顺序给出窗格，并保留活动标记", () => {
    const panes = splitPanes({
      sideBySide: true,
      views: [view("view-1", "视图 1"), view("view-2", "视图 2", true)],
    });
    expect(panes).toEqual([
      { id: "view-1", label: "视图 1", active: false },
      { id: "view-2", label: "视图 2", active: true },
    ]);
  });

  it("窗格名直接用内核标签，界面不自己编号", () => {
    const panes = splitPanes({ sideBySide: true, views: [view("a", "左"), view("b", "右", true)] });
    expect(panes?.map((pane) => pane.label)).toEqual(["左", "右"]);
  });
});

describe("paneViewport", () => {
  it("活动视图用宿主视口，非活动视图用自己记住的取景", () => {
    const active = { id: "view-2", label: "视图 2", active: true };
    const other = { id: "view-1", label: "视图 1", active: false };
    const stored = { "view-1": { x: 100, y: 40, zoom: 2 } };
    expect(paneViewport(active, host, stored)).toBe(host);
    expect(paneViewport(other, host, stored)).toEqual({ x: 100, y: 40, zoom: 2 });
  });

  it("还没单独调过的非活动视图沿用当前取景，不会突然跳到 100%", () => {
    const other = { id: "view-1", label: "视图 1", active: false };
    expect(paneViewport(other, host, {})).toEqual(host);
  });

  it("两个窗格的取景互不影响：改一个不改变另一个的结果", () => {
    const first = { id: "view-1", label: "视图 1", active: false };
    const second = { id: "view-2", label: "视图 2", active: false };
    const before = paneViewport(second, host, {});
    const stored = { "view-1": { x: 7, y: 7, zoom: 4 } };
    expect(paneViewport(first, host, stored)).toEqual({ x: 7, y: 7, zoom: 4 });
    expect(paneViewport(second, host, stored)).toEqual(before);
  });
});

describe("syncPaneViewports", () => {
  const active = { id: "view-1", label: "视图 1", active: true };
  const idle = { id: "view-2", label: "视图 2", active: false };

  it("新出现的窗格从当前取景开始，不会突然跳到 100%", () => {
    const next = syncPaneViewports([active, idle], {}, host);
    expect(next).toEqual({ "view-1": host, "view-2": host });
  });

  it("活动窗格跟随宿主视口，非活动窗格锁住自己的取景（平移不会带跑另一块）", () => {
    const first = syncPaneViewports([active, idle], {}, host);
    const zoomed = { x: -40, y: 12, zoom: 2 };
    const next = syncPaneViewports([active, idle], first, zoomed);
    expect(next["view-1"]).toEqual(zoomed);
    // 关键：另一块画布不跟着动，否则「取景独立」名存实亡。
    expect(next["view-2"]).toEqual(host);
  });

  it("没有变化时返回同一个引用（可以放进 effect 而不自激重渲染）", () => {
    const first = syncPaneViewports([active, idle], {}, host);
    expect(syncPaneViewports([active, idle], first, host)).toBe(first);
  });

  it("窗格消失后丢掉记录，避免留下再也用不到的键", () => {
    const first = syncPaneViewports([active, idle], {}, host);
    expect(syncPaneViewports([active], first, host)).toEqual({ "view-1": host });
  });

  it("不并排时原样返回，调用方不必判断", () => {
    const kept = { "view-1": host };
    expect(syncPaneViewports(null, kept, host)).toBe(kept);
  });
});
