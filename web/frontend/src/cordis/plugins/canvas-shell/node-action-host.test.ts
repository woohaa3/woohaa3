/**
 * 节点顶部操作横条的非 React 宿主逻辑
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1/3.2/3.4/3.9 / design D6 修订）。
 *
 * 非渲染回归：横条由 Bevy 绘制、Rust 命中，本模块只做「聚合纯数据描述」「按贡献 id 派发命中」
 * 与「设置弹窗状态」，不触碰 DOM/渲染。
 */
import { describe, expect, it, vi } from "vitest";
import { describeNodeActions, routeNodeActionHit, createNodeActionSettingsStore, resolveSettingsComponent } from "./node-action-host.js";
import type { NodeActionContribution, NodeActionSettingsProps } from "../../contract/platform.js";

function contribution(overrides: Partial<NodeActionContribution> & Pick<NodeActionContribution, "id">): NodeActionContribution {
  return {
    owner: "test",
    order: 0,
    describe: () => ({ label: overrides.id, enabled: true }),
    activate: () => undefined,
    ...overrides
  };
}

const CONTEXT = { nodeId: "n1", nodeType: "image", writable: true };

describe("describeNodeActions（任务 3.1/3.2）", () => {
  it("按 order 从左到右聚合，缺省不含 summary", () => {
    const result = describeNodeActions({
      contributions: [
        contribution({ id: "convert", order: 10, describe: () => ({ label: "转为片场", enabled: true, menu: true, summary: "gpt-5" }) }),
        contribution({ id: "download", order: 0, describe: () => ({ label: "下载", enabled: true }) })
      ],
      context: CONTEXT
    });
    expect(result).not.toBeNull();
    expect(result!.presentation.actions.map((action) => action.id)).toEqual(["download", "convert"]);
    expect(result!.presentation.actions[1]).toEqual({ id: "convert", label: "转为片场", enabled: true, menu: true });
    expect(result!.presentation.summary).toBe("gpt-5");
    expect(result!.owners.has("convert")).toBe(true);
  });

  it("available=false 或 describe 返回 null 的贡献不参与", () => {
    const result = describeNodeActions({
      contributions: [
        contribution({ id: "a", order: 0, available: () => false, describe: () => ({ label: "A", enabled: true }) }),
        contribution({ id: "b", order: 1, describe: () => null }),
        contribution({ id: "c", order: 2, describe: () => ({ label: "C", enabled: false, reason: "未就绪" }) })
      ],
      context: CONTEXT
    });
    expect(result!.presentation.actions).toEqual([{ id: "c", label: "C", enabled: false }]);
  });

  it("无动作时返回 null（不绘制横条）", () => {
    expect(describeNodeActions({ contributions: [], context: CONTEXT })).toBeNull();
  });

  it("可用性谓词抛错视为不可用，不中断整条横条", () => {
    const result = describeNodeActions({
      contributions: [
        contribution({ id: "boom", order: 0, available: () => { throw new Error("bad"); }, describe: () => ({ label: "boom", enabled: true }) }),
        contribution({ id: "ok", order: 1, describe: () => ({ label: "OK", enabled: true }) })
      ],
      context: CONTEXT
    });
    expect(result!.presentation.actions.map((action) => action.id)).toEqual(["ok"]);
  });
});

describe("routeNodeActionHit（任务 3.4/3.9）", () => {
  it("动作本体命中派发 activate（menu:false），并注入宿主设置开启器", () => {
    const activate = vi.fn();
    const openSettings = vi.fn();
    routeNodeActionHit({
      hit: { nodeId: "n1", actionId: "download", menu: false },
      context: CONTEXT,
      contributions: [contribution({ id: "download", activate })],
      openSettings
    });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "n1", nodeType: "image", writable: true, menu: false }));
    expect(typeof activate.mock.calls[0]![0].requestSettings).toBe("function");
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("贡献在无法直接开始时调用注入的 requestSettings，宿主据此打开设置弹窗（横条模式唯一渲染器）", () => {
    const activate = vi.fn((activation: { requestSettings: () => void }) => { activation.requestSettings(); });
    const openSettings = vi.fn();
    const settings = () => null;
    routeNodeActionHit({
      hit: { nodeId: "n1", actionId: "convert", menu: false },
      context: CONTEXT,
      contributions: [contribution({ id: "convert", activate, settings: settings as never })],
      openSettings
    });
    expect(openSettings).toHaveBeenCalledWith({ nodeId: "n1", nodeType: "image", writable: true, contributionId: "convert" });
  });

  it("未声明 settings 的贡献调用 requestSettings 不打开弹窗（不回退 TS 几何）", () => {
    const activate = vi.fn((activation: { requestSettings: () => void }) => { activation.requestSettings(); });
    const openSettings = vi.fn();
    routeNodeActionHit({
      hit: { nodeId: "n1", actionId: "convert", menu: false },
      context: CONTEXT,
      contributions: [contribution({ id: "convert", activate })],
      openSettings
    });
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("设置箭头命中打开弹窗，不调用 activate", () => {
    const activate = vi.fn();
    const openSettings = vi.fn();
    const settings = () => null;
    routeNodeActionHit({
      hit: { nodeId: "n1", actionId: "convert", menu: true },
      context: CONTEXT,
      contributions: [contribution({ id: "convert", activate, settings: settings as never })],
      openSettings
    });
    expect(activate).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledWith({ nodeId: "n1", nodeType: "image", writable: true, contributionId: "convert" });
  });

  it("未声明 settings 的贡献命中箭头不打开弹窗", () => {
    const openSettings = vi.fn();
    routeNodeActionHit({
      hit: { nodeId: "n1", actionId: "convert", menu: true },
      context: CONTEXT,
      contributions: [contribution({ id: "convert" })],
      openSettings
    });
    expect(openSettings).not.toHaveBeenCalled();
  });

  it("贡献已停用时命中静默忽略（不回退 TS 几何）", () => {
    const activate = vi.fn();
    routeNodeActionHit({
      hit: { nodeId: "n1", actionId: "film-set-conversion", menu: false },
      context: CONTEXT,
      contributions: [contribution({ id: "download", activate })],
      openSettings: vi.fn()
    });
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("设置弹窗状态与内容解析（任务 3.6）", () => {
  it("open/close 订阅通知；内容按贡献 id 解析", () => {
    const store = createNodeActionSettingsStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.open({ nodeId: "n1", nodeType: "image", writable: true, contributionId: "convert" });
    expect(store.get()).toEqual({ nodeId: "n1", nodeType: "image", writable: true, contributionId: "convert" });
    expect(listener).toHaveBeenCalledTimes(1);
    store.close();
    expect(store.get()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    // 重复 close 不再通知。
    store.close();
    expect(listener).toHaveBeenCalledTimes(2);

    const Settings = ((_props: NodeActionSettingsProps) => null) as never;
    expect(resolveSettingsComponent([contribution({ id: "convert", settings: Settings })], "convert")).toBe(Settings);
    expect(resolveSettingsComponent([contribution({ id: "convert" })], "convert")).toBeNull();
  });
});
