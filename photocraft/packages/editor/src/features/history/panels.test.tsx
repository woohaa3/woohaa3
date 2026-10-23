/**
 * 历史/动作/数据驱动面板回归（U74/U75/U76）。
 *
 * 用替身控制器覆盖三条不可替代的界面语义：
 * 1. 清理必须先看范围、显式确认后才执行（不可恢复操作不能一键完成）；
 * 2. ATN 导入的未知步骤报告必须显示，默认整组回滚要说明原因；
 * 3. 批处理逐文件报告，取消只停「下一项」，取消后不再发起剩余项，收尾释放队列。
 *
 * 不加载真实 wasm、不采集渲染：真实像素/历史/字节语义在 Rust 域测试里。
 */
/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionsPanel, AutomationPanel, DataSetsPanel, HistoryPanel } from "./panels.js";
import type { ActionsStateView, BatchProgressView, HistoryStateView, VariablesStateView } from "./model.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Failure = { ok: false; code: string; message: string };
const fail = (message: string): Failure => ({ ok: false, code: "command-failed", message });

const HISTORY: HistoryStateView = {
  entries: [
    { index: 0, label: "打开", current: false },
    { index: 1, label: "画笔", current: true }
  ],
  redo: [],
  current: 1,
  sources: [
    { index: 0, label: "打开", live: false },
    { index: 1, label: "画笔", live: true }
  ],
  canUndo: true,
  canRedo: false,
  snapshots: [{ id: 5, name: "基线", activeLayer: 3 }, { id: 6, name: "第二张", activeLayer: null }],
  epoch: "0123456789abcdef"
};

const ACTIONS: ActionsStateView = {
  actions: [{ name: "两步", steps: 1, set: null }],
  recording: null,
  detail: { name: "两步", steps: [{ id: "image.adjust", params: {} }], disabled: [], dialogs: [], color: "" },
  preflight: { steps: [{ step: 0, id: "image.adjust", enabled: true, playable: true, reason: null }], blocked: [], playable: true },
  budget: { maxActions: 256, maxStepsPerAction: 2048, maxAtnBytes: 8388608 }
};

const VARIABLES: VariablesStateView = {
  defs: [{ name: "可见性", layer: 1, kind: "visibility" }],
  dataSets: [{ name: "第一组", values: 1, entries: [{ variable: "可见性", kind: "visibility", value: true }] }],
  active: null,
  budget: { maxCsvBytes: 8 * 1024 * 1024, maxDataSets: 1024, maxValuesPerSet: 512, maxVariables: 256 }
};

function mount(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(ui));
  return container;
}

const controller = (history: unknown) => ({ dispatch: () => ({ ok: true, value: {} }), features: { history } }) as never;

const button = (container: HTMLElement, text: string) => [...container.querySelectorAll("button")]
  .find((entry) => entry.textContent?.trim() === text) as HTMLButtonElement | undefined;

/**
 * 拦截下载交付：面板只创建一个 `<a download>` 并点它。这里记录最后创建的锚点，
 * 其余 `createElement` 调用仍走原始实现（否则 React 自己的节点创建会被打断）。
 */
function captureDownload() {
  const original = document.createElement.bind(document);
  const seen: HTMLAnchorElement[] = [];
  vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
    const element = original(tag, options);
    if (tag === "a") {
      Object.defineProperty(element, "click", { value: vi.fn(), configurable: true });
      seen.push(element as HTMLAnchorElement);
    }
    return element;
  }) as typeof document.createElement);
  return () => seen.at(-1);
}

/** React 受控输入用内部 value tracker 去重，必须走原生 setter 才会触发 onChange。 */
const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

/** `<select>` 的值切换：`change` 事件（React 的 onChange 对 select 监听它）。 */
const setSelect = (select: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("U74 历史面板", () => {
  it("列出历史与快照，并显示历史源身份", () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(),
      selectSnapshot: vi.fn(),
      renameSnapshot: vi.fn(),
      deleteSnapshot: vi.fn(),
      deleteState: vi.fn(),
      newDocumentFromHistory: vi.fn(),
      purgePlan: vi.fn(),
      purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(2);
    expect(container.querySelector('[data-history-entry="1"]')?.getAttribute("aria-current")).toBe("step");
    expect(container.querySelectorAll("[data-snapshot]")).toHaveLength(2);
    expect(container.textContent).toContain("01234567");
  });

  it("清理必须先取范围说明，确认前不执行 purge", () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      purgePlan: vi.fn(() => ({ ok: true, value: { command: "edit.purge.undo", scope: "当前文档的可撤销记录", bytes: 4096, recoverable: false } })),
      purge: vi.fn(() => ({ ok: true, value: {} }))
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);

    act(() => button(container, "撤销记录")!.click());
    expect(history.purgePlan).toHaveBeenCalledWith("undo");
    // 只点了范围按钮：还没确认，绝不能已经清理。
    expect(history.purge).not.toHaveBeenCalled();
    const dialog = container.querySelector('[data-purge-confirm="undo"]');
    expect(dialog?.textContent).toContain("当前文档的可撤销记录");
    expect(dialog?.textContent).toContain("不可撤销");

    act(() => button(container, "确认清理")!.click());
    // 确认门：面板必须显式传 confirm=true。
    expect(history.purge).toHaveBeenCalledWith("undo", true);
    expect(container.querySelector('[data-purge-confirm="undo"]')).toBeNull();
    // 成功也要有回执：确认框消失后什么都不说，用户分不清「清掉了」和「点了没反应」
    // （视频缓存这类范围清理后列表完全不变，更需要一条回执）。
    expect(container.querySelector("[data-history-notice]")?.textContent).toContain("当前文档的可撤销记录");
    expect(container.querySelector("[data-history-error]")).toBeNull();
  });

  it("取消确认不发清理请求", () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      purgePlan: () => ({ ok: true, value: { command: "edit.purge.all", scope: "所有文档", bytes: 0, recoverable: false } }),
      purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    act(() => button(container, "全部")!.click());
    act(() => button(container, "取消")!.click());
    expect(history.purge).not.toHaveBeenCalled();
    expect(container.querySelector("[data-purge-confirm]")).toBeNull();
  });

  it("清理失败显示原因，不假装成功", () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      purgePlan: () => ({ ok: true, value: { command: "edit.purge.undo", scope: "可撤销记录", bytes: 0, recoverable: false } }),
      purge: vi.fn(() => fail("文件有未结算的笔迹"))
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    act(() => button(container, "撤销记录")!.click());
    act(() => button(container, "确认清理")!.click());
    expect(container.querySelector("[data-history-error]")?.textContent).toContain("未结算的笔迹");
  });

  it("空范围在确认前就说明没有可清理的内容，不给「确认清理」", () => {
    // 确认框原先只显示「（当前为空）」，仍给出「确认清理」；用户确认后内核再报
    // `nothing to purge`。现在内核在范围说明里下发 `available: false` + 原因，界面据此只留
    // 「知道了」，不把一个必被拒绝的操作包装成可确认的决定。
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      purgePlan: () => ({
        ok: true,
        value: {
          command: "edit.purge.clipboard", scope: "工作区内复制的像素与图层", bytes: 0,
          available: false, reason: "the clipboard is empty", recoverable: false
        }
      }),
      purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    act(() => button(container, "剪贴板")!.click());
    expect(container.querySelector('[data-purge-unavailable="true"]')?.textContent).toContain("没有可清理的内容");
    expect(container.querySelector('[data-purge-unavailable="true"]')?.textContent).toContain("clipboard");
    expect(button(container, "确认清理")).toBeUndefined();
    expect(history.purge).not.toHaveBeenCalled();
    // 关掉说明不留下对话框。
    act(() => button(container, "知道了")!.click());
    expect(container.querySelector("[data-purge-confirm]")).toBeNull();
  });

  it("可清理但释放 0 字节时不说「当前为空」，仍给「确认清理」", () => {
    // 各状态共用同一批 tile 时，清掉整个撤销栈其实**不会**腾出空间，但它仍会丢掉历史。
    // 原先这种情况显示「（当前为空）」，用户以为点确认什么也不会发生——结果撤销栈被清空。
    const plan = (bytes: number, approximate: boolean) => ({
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      purgePlan: () => ({
        ok: true,
        value: { command: "edit.purge.histories", scope: "所有历史", bytes, approximate, available: true, reason: null, recoverable: false }
      }),
      purge: vi.fn()
    });

    const zero = mount(<HistoryPanel controller={controller(plan(0, false))} readonly={false} />);
    act(() => button(zero, "所有历史")!.click());
    const text = zero.querySelector("[data-purge-confirm]")?.textContent ?? "";
    expect(text).toContain("不会腾出空间");
    expect(text).not.toContain("当前为空");
    expect(button(zero, "确认清理")).toBeDefined();

    // 有字节时：精确范围说「正好」，`all` 说「约」（形状描边缓存没有公开读数）。
    const exact = mount(<HistoryPanel controller={controller(plan(4096, false))} readonly={false} />);
    act(() => button(exact, "所有历史")!.click());
    expect(exact.querySelector("[data-purge-confirm]")?.textContent).toContain("正好 4 KiB");
    const approx = mount(<HistoryPanel controller={controller(plan(4096, true))} readonly={false} />);
    act(() => button(approx, "所有历史")!.click());
    expect(approx.querySelector("[data-purge-confirm]")?.textContent).toContain("约 4 KiB");

    // `all` 恰好报 0 时不能说「不会腾出空间」：形状描边缓存没有公开读数，实际仍在释放。
    const approxZero = mount(<HistoryPanel controller={controller(plan(0, true))} readonly={false} />);
    act(() => button(approxZero, "所有历史")!.click());
    const zeroText = approxZero.querySelector("[data-purge-confirm]")?.textContent ?? "";
    expect(zeroText).toContain("没有公开大小");
    expect(zeroText).not.toContain("不会腾出空间");
  });

  it("历史源取样会记住取源时的 epoch，清理后再取样被拒绝而不是画出新内容", () => {
    // U74「清理后正确失效历史画笔源」在界面上的证据：取源时把 epoch 记住，之后每次取样都送
    // 同一个 epoch。清理之后内核拒绝该句柄，界面显示失效原因，不显示一张「看起来正常」的新图。
    let epoch = "aaaaaaaaaaaaaaaa";
    let purged = false;
    const sampleHistory = vi.fn((params: { epoch: string; state?: number }) => {
      if (params.epoch !== epoch) {
        return fail(`历史源已失效（取源时为 ${params.epoch}，当前为 ${epoch}）：状态序列或文档已经变化`);
      }
      return {
        ok: true,
        value: { epoch: params.epoch, state: params.state ?? 1, label: "画笔", live: params.state === undefined, width: 1, height: 1, sources: 2, pixels: "AAAAAA==" }
      };
    });
    const history = {
      historyState: () => ({ ok: true, value: { ...HISTORY, epoch } }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(), sampleHistory,
      purgePlan: () => ({ ok: true, value: { command: "edit.purge.histories", scope: "所有历史", bytes: 4096, available: true, reason: null, recoverable: false } }),
      purge: vi.fn(() => { purged = true; epoch = "bbbbbbbbbbbbbbbb"; return { ok: true, value: {} }; })
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    const select = container.querySelector("[data-sample-state]") as HTMLSelectElement;
    act(() => setSelect(select, "0"));
    act(() => button(container, "取样历史源")!.click());
    expect(sampleHistory).toHaveBeenLastCalledWith({ epoch: "aaaaaaaaaaaaaaaa", state: 0, maxSide: 128 });
    expect(container.querySelector("[data-history-sample]")?.textContent).toContain("归档状态");

    // 走一遍清理确认：清完立刻丢掉旧取样。
    act(() => button(container, "所有历史")!.click());
    act(() => button(container, "确认清理")!.click());
    expect(purged).toBe(true);
    expect(container.querySelector("[data-history-sample]")).toBeNull();

    // 再取样仍然用旧 epoch（面板还没重新取源）：内核拒绝，界面如实报失效。
    act(() => button(container, "取样历史源")!.click());
    expect(container.querySelector("[data-history-error]")?.textContent).toContain("已失效");
    expect(container.querySelector("[data-history-sample]")).toBeNull();

    // 「重新取源」后改用新 epoch，取样恢复。
    act(() => button(container, "重新取源")!.click());
    act(() => button(container, "取样历史源")!.click());
    expect(sampleHistory).toHaveBeenLastCalledWith({ epoch: "bbbbbbbbbbbbbbbb", state: 0, maxSide: 128 });
    expect(container.querySelector("[data-history-sample]")?.textContent).toContain("已取样第 1 步");
    expect(container.querySelector("[data-history-error]")).toBeNull();
  });

  it("宿主没有取样端口时只停用取样，历史面板其余部分照常可用", () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      purgePlan: vi.fn(), purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    act(() => button(container, "取样历史源")!.click());
    expect(container.querySelector("[data-history-error]")?.textContent).toContain("没有历史源取样端口");
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(2);
    // 校验端口也缺时同样只报一次可读错误，不抛异常、不影响历史列表。
    act(() => button(container, "检查源可用")!.click());
    expect(container.querySelector("[data-history-error]")?.textContent).toContain("没有历史源校验端口");
    expect(container.querySelectorAll("[data-history-entry]")).toHaveLength(2);
  });

  it("取样结果画出真实像素，长度不符时如实报错而不是画半张图", () => {
    // 取样端口返回的是像素；只显示「1×1」等于把结果丢掉。这里同时锁住两件事：
    // 1. 尺寸与像素长度一致时画出 canvas；
    // 2. 长度对不上时（这里故意多给一个像素）报错，不把半张图像当成整张。
    const sample = (pixels: string) => ({
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      sampleHistory: () => ({ ok: true, value: { epoch: "aaaaaaaaaaaaaaaa", state: 1, label: "画笔", live: false, width: 1, height: 1, sources: 2, pixels } }),
      purgePlan: vi.fn(), purge: vi.fn()
    });
    const ok = mount(<HistoryPanel controller={controller(sample("AAAAAA=="))} readonly={false} />);
    act(() => button(ok, "取样历史源")!.click());
    const canvas = ok.querySelector("[data-history-sample-preview] canvas") as HTMLCanvasElement | null;
    expect(canvas?.getAttribute("width")).toBe("1");
    expect(ok.querySelector("[data-history-sample-error]")).toBeNull();

    const bad = mount(<HistoryPanel controller={controller(sample("AAAAAAAAAA=="))} readonly={false} />);
    act(() => button(bad, "取样历史源")!.click());
    expect(bad.querySelector("[data-history-sample-error]")?.textContent).toContain("取样像素长度不符");
  });

  it("检查源可用走内核校验但不合成像素，过期句柄同样被拒", () => {
    // 历史画笔落笔前只需要「这个源还能用吗」：这条路径不返回 pixels，判定仍在内核里。
    // 内核拿**送回来的** epoch 与当前身份比对：面板记着旧 epoch 时，即使源本身换了也只能被拒。
    let epoch = "aaaaaaaaaaaaaaaa";
    const checkHistorySource = vi.fn((params: { epoch: string; state?: number }) =>
      params.epoch === epoch
        ? { ok: true, value: { epoch: params.epoch, state: params.state ?? 1, label: "画笔", live: false, width: 400, height: 300, sources: 2 } }
        : fail("历史源已失效：状态序列或文档已经变化")
    );
    const history = {
      historyState: () => ({ ok: true, value: { ...HISTORY, epoch } }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(), checkHistorySource,
      purgePlan: vi.fn(), purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    act(() => button(container, "检查源可用")!.click());
    expect(checkHistorySource).toHaveBeenLastCalledWith({ epoch: "aaaaaaaaaaaaaaaa" });
    expect(container.querySelector("[data-history-source-usable]")?.textContent).toContain("400×300");
    expect(container.querySelector("[data-history-sample]")).toBeNull();

    // 清理后内核拒绝旧句柄：界面不得继续显示「可用」。
    epoch = "bbbbbbbbbbbbbbbb";
    act(() => button(container, "检查源可用")!.click());
    expect(container.querySelector("[data-history-error]")?.textContent).toContain("已失效");
    expect(container.querySelector("[data-history-source-usable]")).toBeNull();
  });

  it("重命名作用于当前选中的快照，删掉选中项后回落到首个", () => {    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(() => ({ ok: true, value: {} })),
      deleteSnapshot: vi.fn(() => ({ ok: true, value: {} })), deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      purgePlan: vi.fn(), purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    const rename = [...container.querySelectorAll("input")].find((input) => input.placeholder === "输入新名称后回车")!;
    act(() => setValue(rename, "改名后"));
    act(() => { rename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(history.renameSnapshot).toHaveBeenCalledWith(5, "改名后");
  });

  it("删除状态不是说删一行：先说明会退回并丢重做，确认前不发请求", () => {
    // 上游 `history.deleteState` 会先退回该状态之前，再清空其后的所有状态——内容回退且不可重做，
    // 和清理一样属于不可恢复操作。原先是一个一键按钮，用户会以为只是删掉一行历史记录。
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(),
      deleteSnapshot: vi.fn(), deleteState: vi.fn(() => ({ ok: true, value: {} })), newDocumentFromHistory: vi.fn(),
      purgePlan: vi.fn(), purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    expect(history.deleteState).not.toHaveBeenCalled();
    const open = button(container, "删除当前状态…")!;
    act(() => open.click());
    // 打开确认：说明后果，但还没删。
    expect(history.deleteState).not.toHaveBeenCalled();
    const confirm = container.querySelector("[data-delete-state-confirm]")!;
    expect(confirm.textContent).toContain("退回上一个状态");
    expect(confirm.textContent).toContain("不可撤销");
    act(() => button(container, "取消")!.click());
    expect(history.deleteState).not.toHaveBeenCalled();
    expect(container.querySelector("[data-delete-state-confirm]")).toBeNull();

    act(() => button(container, "删除当前状态…")!.click());
    act(() => button(container, "确认删除状态")!.click());
    expect(history.deleteState).toHaveBeenCalledWith(HISTORY.current);
    expect(container.querySelector("[data-delete-state-confirm]")).toBeNull();
  });

  it("端口缺失时不渲染面板（不是调用时抛错）", () => {
    const container = mount(<HistoryPanel controller={controller(undefined)} readonly={false} />);
    expect(container.querySelector("[data-history-panel]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("快照内容是可选三种，默认整份文档", () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(() => ({ ok: true, value: {} })), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(),
      deleteSnapshot: vi.fn(), deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      purgePlan: vi.fn(), purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    const from = container.querySelector<HTMLSelectElement>("[data-snapshot-from]")!;
    // 三种 `from` 都要能选；默认是整份文档（内核默认值），不是「合并图层」。
    expect([...from.options].map((option) => option.value)).toEqual(["fullDocument", "mergedLayers", "currentLayer"]);
    act(() => { button(container, "新建快照")!.click(); });
    expect(history.newSnapshot).toHaveBeenCalledWith({ from: "fullDocument" });

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(from, "currentLayer");
      from.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => { button(container, "新建快照")!.click(); });
    expect(history.newSnapshot).toHaveBeenCalledWith({ from: "currentLayer" });
  });

  it("自历史新建可以指定状态与名称，不给就用当前状态", () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(),
      newDocumentFromHistory: vi.fn(() => ({ ok: true, value: { name: "派生", bytes: new Uint8Array([1, 2, 3]) } })),
      purgePlan: vi.fn(), purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    // 默认不传 state：交给内核用当前状态（不是硬编码第 0 步）。
    act(() => { button(container, "自历史新建文档")!.click(); });
    expect(history.newDocumentFromHistory).toHaveBeenCalledWith({});

    const state = container.querySelector<HTMLSelectElement>("[data-new-document-state]")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(state, "1");
      state.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const nameInput = [...container.querySelectorAll("input")].find((input) => input.placeholder === "留空则用状态标签")!;
    act(() => setValue(nameInput, "从第二步"));
    act(() => { button(container, "自历史新建文档")!.click(); });
    expect(history.newDocumentFromHistory).toHaveBeenCalledWith({ state: 1, name: "从第二步" });
  });

  it("自历史新建把派生工程作为文件交付，并说明当前文档未受影响", () => {
    // 内核会切走活动文档；域会话已经关掉派生文档并交回字节，面板必须把它交付出去，
    // 而不是只显示「成功」却什么都没有——否则用户以为新建了文档，实际丢了。
    vi.stubGlobal("URL", { createObjectURL: () => "blob:derived", revokeObjectURL: () => {} });
    const clicked: string[] = [];
    const create = document.createElement.bind(document);
    const spy = vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const element = create(tag) as HTMLElement & { click?: () => void };
      if (tag === "a") element.click = () => { clicked.push((element as HTMLAnchorElement).download); };
      return element;
    }) as typeof document.createElement);
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(),
      newDocumentFromHistory: vi.fn(() => ({ ok: true, value: { name: "派生 1", bytes: new Uint8Array([1, 2, 3]) } })),
      purgePlan: vi.fn(), purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    try {
      act(() => { button(container, "自历史新建文档")!.click(); });
      expect(clicked).toEqual(["派生 1.pcraft"]);
      // 成功提示不能渲染成错误行：两类消息各有自己的槽位。
      expect(container.querySelector("[data-history-error]")).toBeNull();
      expect(container.querySelector("[data-history-notice]")?.textContent).toContain("派生 1");
      expect(container.querySelector("[data-history-notice]")?.textContent).toContain("当前文档未受影响");
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("自历史新建失败时如实显示原因，不交付空文件", () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:derived", revokeObjectURL: () => {} });
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(),
      newDocumentFromHistory: vi.fn(() => ({ ok: false, code: "command-failed", message: "状态 9 不存在" })),
      purgePlan: vi.fn(), purge: vi.fn()
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    try {
      act(() => { button(container, "自历史新建文档")!.click(); });
      expect(container.querySelector("[data-history-error]")?.textContent).toContain("状态 9 不存在");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("五个清理范围都有入口，视频缓存不被漏掉", () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      newSnapshot: vi.fn(), selectSnapshot: vi.fn(), renameSnapshot: vi.fn(), deleteSnapshot: vi.fn(),
      deleteState: vi.fn(), newDocumentFromHistory: vi.fn(),
      purgePlan: vi.fn(() => ({ ok: true, value: { command: "edit.purge.videoCache", scope: "视频缓存", bytes: 0, recoverable: false } })),
      purge: vi.fn(() => ({ ok: true, value: {} }))
    };
    const container = mount(<HistoryPanel controller={controller(history)} readonly={false} />);
    act(() => { button(container, "视频缓存")!.click(); });
    // 命令已进命令门，界面必须给入口，否则用户以为没有这个范围。
    expect(history.purgePlan).toHaveBeenCalledWith("videoCache");
    expect(container.querySelector('[data-purge-confirm="videoCache"]')).not.toBeNull();
  });
});

describe("U75 动作面板", () => {
  it("导入 ATN 时默认拒绝未知步骤，并把报告显示出来", async () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      actionsState: () => ({ ok: true, value: ACTIONS }),
      // 默认整组回滚：不发 unsupported 报告，而是失败并说明首个事件。
      loadActions: vi.fn(() => fail("有 1 个 Photoshop 步骤在当前运行时没有等价命令，已整组取消导入（首个：photoshopStep）")),
      saveActions: vi.fn(), actionCommand: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    const input = container.querySelector<HTMLInputElement>("[data-atn-file]")!;
    const file = new File([new Uint8Array([1, 2, 3])], "actions.atn");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

    // 默认 acceptUnsupported=false：字节原样交出，由内核决定整组回滚。
    expect(history.loadActions).toHaveBeenCalledWith({ data: "AQID", acceptUnsupported: false });
    expect(container.querySelector("[data-actions-error]")?.textContent).toContain("整组取消导入");
    expect(container.querySelector("[data-atn-unsupported]")).toBeNull();
  });

  it("接受未知步骤时显示逐个未知事件，而不是静默保留", async () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      actionsState: () => ({ ok: true, value: ACTIONS }),
      loadActions: vi.fn(() => ({
        ok: true,
        value: {
          unsupported: [{ action: "导入", step: 2, event: "photoshopStep", name: "Mosaic" }],
          actions: ["导入"],
          warnings: []
        }
      })),
      saveActions: vi.fn(), actionCommand: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => { checkbox.click(); });
    const input = container.querySelector<HTMLInputElement>("[data-atn-file]")!;
    const file = new File([new Uint8Array([1])], "actions.atn");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

    expect(history.loadActions).toHaveBeenCalledWith({ data: "AQ==", acceptUnsupported: true });
    const report = container.querySelector("[data-atn-unsupported]");
    expect(report?.textContent).toContain("第 3 步");
    expect(report?.textContent).toContain("photoshopStep");
    // 保留成功不是错误：提示走独立一行，错误行保持干净。
    expect(container.querySelector("[data-actions-error]")).toBeNull();
    expect(container.querySelector("[data-actions-notice]")?.textContent).toContain("已保留 1 个");
  });

  it("ATN 解析警告逐条显示：导入成功不等于文件被完整读入", async () => {
    // 上游只在尾部字节被忽略这类情况下发警告（文件仍能导入）。面板必须把警告说出来，
    // 否则用户以为整份 .atn 都进来了。
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      actionsState: () => ({ ok: true, value: ACTIONS }),
      loadActions: vi.fn(() => ({
        ok: true,
        value: { unsupported: [], actions: ["导入"], warnings: ["4 trailing bytes ignored"] }
      })),
      saveActions: vi.fn(), actionCommand: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    const input = container.querySelector<HTMLInputElement>("[data-atn-file]")!;
    const file = new File([new Uint8Array([1, 2, 3])], "actions.atn");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

    const warnings = container.querySelector("[data-atn-warnings]");
    expect(warnings?.textContent).toContain("4 trailing bytes ignored");
    // 不是错误：文件确实导入了，只是不完整。
    expect(container.querySelector("[data-actions-error]")).toBeNull();
    expect(container.querySelector("[data-actions-notice]")?.textContent).toContain("警告");
  });

  it("没有解析警告时不显示警告清单，也不谎称有警告", async () => {
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      actionsState: () => ({ ok: true, value: ACTIONS }),
      loadActions: vi.fn(() => ({ ok: true, value: { unsupported: [], actions: ["导入"], warnings: [] } })),
      saveActions: vi.fn(), actionCommand: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    const input = container.querySelector<HTMLInputElement>("[data-atn-file]")!;
    const file = new File([new Uint8Array([1, 2, 3])], "actions.atn");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("[data-atn-warnings]")).toBeNull();
    expect(container.querySelector("[data-actions-notice]")).toBeNull();
  });

  it("导入 ATN 后重读快捷键：内核会把 .atn 里的功能键写进偏好", async () => {
    // `actions.load` 在导入时 `edit_prefs` 写入 `actions.play:<name>` → F 键绑定。只刷新动作列表
    // 会让「快捷键」一栏继续显示导入前的旧绑定，用户以为键位没变。
    const shortcuts = vi.fn()
      .mockReturnValueOnce({ ok: true, value: [] })
      .mockReturnValue({ ok: true, value: [{ action: "导入", shortcut: "F5" }] });
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      actionsState: () => ({ ok: true, value: ACTIONS }),
      actionShortcuts: shortcuts,
      loadActions: vi.fn(() => ({ ok: true, value: { unsupported: [], actions: ["导入"], warnings: [] } })),
      saveActions: vi.fn(), actionCommand: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    expect(shortcuts).toHaveBeenCalledTimes(1);
    const input = container.querySelector<HTMLInputElement>("[data-atn-file]")!;
    const file = new File([new Uint8Array([1, 2, 3])], "actions.atn");
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(shortcuts).toHaveBeenCalledTimes(2);
  });

  it("不可播放的步骤在预检里标出并阻止整组播放", () => {
    const blocked: ActionsStateView = {
      ...ACTIONS,
      preflight: {
        steps: [{ step: 0, id: "actions.photoshopStep", enabled: true, playable: false, reason: "运行时不认识" }],
        blocked: [{ step: 0, id: "actions.photoshopStep", enabled: true, playable: false, reason: "运行时不认识" }],
        playable: false
      }
    };
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      actionsState: () => ({ ok: true, value: blocked }),
      loadActions: vi.fn(), saveActions: vi.fn(), actionCommand: vi.fn(),
      startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    expect(container.querySelector('[data-step="0"]')?.getAttribute("data-playable")).toBe("false");
    expect(container.textContent).toContain("播放会整组拒绝");
  });

  it("停止的步骤与对话框步骤逐条标出，并可直接启停", () => {
    const detail: ActionsStateView = {
      ...ACTIONS,
      detail: { name: "两步", steps: [{ id: "layer.new.layer", params: {} }, { id: "image.adjust", params: {} }], disabled: [0], dialogs: [1], color: "" }
    };
    const history = {
      actionsState: () => ({ ok: true, value: detail }),
      actionCommand: vi.fn(() => ({ ok: true, value: detail })),
      loadActions: vi.fn(), saveActions: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    // 停止的步骤必须显式说明「播放时跳过」，不能只靠按钮文字暗示。
    expect(container.querySelector('[data-step="0"]')?.getAttribute("data-disabled")).toBe("true");
    expect(container.querySelector('[data-step="0"]')?.textContent).toContain("播放时跳过");
    expect(container.querySelector('[data-step="1"]')?.textContent).toContain("显示对话框");

    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('[data-step="0"] button')].find((entry) => entry.textContent === "启用")!.click();
    });
    expect(history.actionCommand).toHaveBeenCalledWith("actions.toggle", { action: "两步", step: 0 });
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('[data-step="1"] button')].find((entry) => entry.textContent === "取消对话框")!.click();
    });
    expect(history.actionCommand).toHaveBeenCalledWith("actions.dialog", { action: "两步", step: 1 });
  });

  it("插入步骤把命令与参数交给动作；非法参数 JSON 不发请求", () => {
    const detail: ActionsStateView = {
      ...ACTIONS,
      detail: { name: "两步", steps: [{ id: "image.adjust", params: {} }], disabled: [], dialogs: [], color: "" }
    };
    const history = {
      actionsState: () => ({ ok: true, value: detail }),
      actionCommand: vi.fn(() => ({ ok: true, value: detail })),
      loadActions: vi.fn(), saveActions: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    const [commandInput, paramsInput] = [...container.querySelectorAll("input")].filter(
      (entry) => entry.placeholder === "layer.new.layer" || entry.placeholder === "{}"
    ) as HTMLInputElement[];

    // 写错的参数不能当 `{}` 提交（会静默插入与意图不同的步骤）。
    act(() => {
      setValue(commandInput!, "layer.new.layer");
      setValue(paramsInput!, "{not json");
    });
    act(() => { button(container, "插入步骤")!.click(); });
    expect(history.actionCommand).not.toHaveBeenCalled();
    expect(container.querySelector("[data-actions-error]")?.textContent).toContain("JSON 对象");

    act(() => { setValue(paramsInput!, '{"name":"脚本层"}'); });
    act(() => { button(container, "插入步骤")!.click(); });
    expect(history.actionCommand).toHaveBeenCalledWith("actions.insert", {
      action: "两步", id: "layer.new.layer", params: { name: "脚本层" }
    });
  });

  it("动作集与条件走同一动作编辑入口，快捷键只读显示", () => {
    const detail: ActionsStateView = {
      ...ACTIONS,
      detail: { name: "两步", steps: [{ id: "image.adjust", params: {} }], disabled: [], dialogs: [], color: "" }
    };
    const history = {
      actionsState: () => ({ ok: true, value: detail }),
      actionCommand: vi.fn(() => ({ ok: true, value: detail })),
      testCondition: vi.fn(() => ({ ok: true, value: { holds: true, played: "两步", failed: null } })),
      actionShortcuts: vi.fn(() => ({ ok: true, value: [{ action: "两步", shortcut: "F4" }] })),
      loadActions: vi.fn(), saveActions: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);

    // 快捷键是会话/偏好，面板只显示，不在这里改绑。
    expect(container.querySelector("[data-shortcut-action]")?.textContent).toContain("F4");
    const setInput = [...container.querySelectorAll("input")].find((entry) => entry.placeholder === "常用") as HTMLInputElement;
    act(() => { setValue(setInput, "常用"); });
    act(() => { button(container, "归入动作集")!.click(); });
    expect(history.actionCommand).toHaveBeenCalledWith("actions.assignSet", { action: "两步", set: "常用" });

    act(() => { button(container, "测试条件")!.click(); });
    // 条件会播放分支（会写文档内容），因此必须走域会话的写入路径而不是 actionCommand。
    expect(history.testCondition).toHaveBeenCalledWith({ if: "always", then: "两步", else: null });
    expect(history.actionCommand).not.toHaveBeenCalledWith("actions.conditional", expect.anything());
    // holds/played 必须显示出来，用户才知道走了哪一支。
    expect(container.querySelector("[data-actions-notice]")?.textContent).toContain("两步");
  });

  it("导出把内核返回的 base64 交给下载，且不伪造成功", () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:atn", revokeObjectURL: () => {} });
    const lastAnchor = captureDownload();
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      actionsState: () => ({ ok: true, value: ACTIONS }),
      loadActions: vi.fn(),
      saveActions: () => ({ ok: true, value: { data: "AQID" } }),
      actionCommand: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    act(() => button(container, "导出 .atn…")!.click());
    const anchor = lastAnchor()!;
    expect(anchor.download).toBe("actions.atn");
    expect(anchor.href).toBe("blob:atn");
    expect(anchor.click).toHaveBeenCalled();
    expect(container.querySelector("[data-actions-error]")).toBeNull();
  });

  it("含非 Photoshop 步骤的动作：默认导出如实失败，跳过导出是显式第二步", () => {
    // 内核的 `actions.save` 对没有 Photoshop 等价命令的步骤默认报错，只有 `skipUnsupported`
    // 才会把它们丢出去。界面不能自动重试：那会让用户在不知情时拿到一份少了步骤的 .atn。
    vi.stubGlobal("URL", { createObjectURL: () => "blob:atn", revokeObjectURL: () => {} });
    const lastAnchor = captureDownload();
    const saveActions = vi.fn()
      .mockReturnValueOnce({ ok: false, message: "step 1 of `两步` (`edit.fillForeground`) has no Photoshop equivalent" })
      .mockReturnValueOnce({ ok: true, value: { data: "AQID", skipped: [{ action: "两步", step: 0, id: "edit.fillForeground" }] } });
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      actionsState: () => ({ ok: true, value: ACTIONS }),
      loadActions: vi.fn(),
      saveActions,
      actionCommand: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);

    // 未选中动作时默认导出仍走「整组」语义，不是某个动作。
    const skip = button(container, "跳过无等价步骤导出…")!;
    expect(skip.disabled).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>("[data-action] button")!.click());
    act(() => button(container, "导出 .atn…")!.click());
    expect(saveActions).toHaveBeenLastCalledWith({ action: "两步" });
    expect(container.querySelector("[data-actions-error]")?.textContent).toContain("no Photoshop equivalent");
    expect(lastAnchor()).toBeUndefined();

    // 「跳过导出」是独立入口，不复用导入侧的「保留未知步骤」勾选框；选中动作后即可点。
    const enabled = button(container, "跳过无等价步骤导出…")!;
    expect(enabled.disabled).toBe(false);
    act(() => enabled.click());
    expect(saveActions).toHaveBeenLastCalledWith({ action: "两步", skipUnsupported: true });
    expect(lastAnchor()!.download).toBe("两步.atn");
    // 被跳过的步骤逐条说出来：否则用户会以为这份 .atn 是完整的。
    const skipped = container.querySelectorAll("[data-atn-skipped] li");
    expect([...skipped].map((entry) => entry.textContent)).toEqual(["两步 第 1 步：edit.fillForeground 没有等价命令，已从导出的 .atn 中省略"]);
  });

  it("停止录制后自动选中刚录的动作，播放与步骤编辑立刻可用", () => {
    // 录制中的 `recording` 字段就是动作名。停止后不选中它，用户看到「录了 2 步」，但「播放」
    // 「删除动作」和步骤列表全部禁用，必须先点一次动作名才恢复——像是录制没生效。
    const recorded: ActionsStateView = {
      ...ACTIONS,
      recording: "新动作",
      actions: [{ name: "新动作", steps: 2, set: null }],
      detail: null,
      preflight: null
    };
    const stopped: ActionsStateView = {
      ...recorded,
      recording: null,
      detail: { name: "新动作", steps: [{ id: "edit.fillForeground", params: {} }, { id: "edit.clear", params: {} }], disabled: [], dialogs: [], color: "" }
    };
    const history = {
      historyState: () => ({ ok: true, value: HISTORY }),
      actionsState: vi.fn((action?: string) => ({ ok: true, value: action ? stopped : recorded })),
      loadActions: vi.fn(), saveActions: vi.fn(),
      actionCommand: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(() => ({ ok: true, value: stopped })), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    act(() => button(container, "停止")!.click());
    // 选中后读到的是带步骤明细的视图，播放按钮不再禁用。
    expect(history.actionsState).toHaveBeenLastCalledWith("新动作");
    expect(container.querySelector('[data-action="新动作"]')?.getAttribute("aria-current")).toBe("true");
    expect(button(container, "播放")!.disabled).toBe(false);
  });

  it("步骤可上下移动：边界处的按钮禁用，不会请求越界移动", () => {
    const detail: ActionsStateView = {
      ...ACTIONS,
      detail: { name: "两步", steps: [{ id: "layer.new.layer", params: {} }, { id: "image.adjust", params: {} }], disabled: [], dialogs: [], color: "" }
    };
    const history = {
      actionsState: () => ({ ok: true, value: detail }),
      actionCommand: vi.fn(() => ({ ok: true, value: detail })),
      loadActions: vi.fn(), saveActions: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    const first = container.querySelector('[data-step="0"]')!;
    const second = container.querySelector('[data-step="1"]')!;
    // 第 0 步不能再上移、最后一步不能再下移：禁用而不是发出会被内核拒绝的请求。
    expect([...first.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "上移")!.disabled).toBe(true);
    expect([...second.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "下移")!.disabled).toBe(true);

    act(() => {
      [...first.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "下移")!.click();
    });
    expect(history.actionCommand).toHaveBeenCalledWith("actions.move", { action: "两步", step: 0, to: 1 });
  });

  it("重命名与按钮颜色都作用于当前动作", () => {
    const detail: ActionsStateView = {
      ...ACTIONS,
      detail: { name: "两步", steps: [{ id: "image.adjust", params: {} }], disabled: [], dialogs: [], color: "red" }
    };
    const history = {
      actionsState: () => ({ ok: true, value: detail }),
      actionCommand: vi.fn(() => ({ ok: true, value: detail })),
      loadActions: vi.fn(), saveActions: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn()
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    const color = container.querySelector<HTMLSelectElement>("[data-action-color]")!;
    expect(color.value).toBe("red");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(color, "green");
      color.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(history.actionCommand).toHaveBeenCalledWith("actions.setColor", { action: "两步", color: "green" });

    const renameInput = [...container.querySelectorAll("input")].find((entry) => entry.placeholder === "两步") as HTMLInputElement;
    act(() => setValue(renameInput, "改名的动作"));
    act(() => { button(container, "重命名")!.click(); });
    expect(history.actionCommand).toHaveBeenCalledWith("actions.rename", { action: "两步", name: "改名的动作" });
  });

  it("从指定步骤播放只在填了数字时传 from", () => {
    const history = {
      actionsState: () => ({ ok: true, value: ACTIONS }),
      actionCommand: vi.fn(), loadActions: vi.fn(), saveActions: vi.fn(),
      startRecording: vi.fn(), stopRecording: vi.fn(), playAction: vi.fn(() => ({ ok: true, value: {} }))
    };
    const container = mount(<ActionsPanel controller={controller(history)} readonly={false} />);
    act(() => button(container, "两步")!.click());
    const fromInput = [...container.querySelectorAll("input")].find((entry) => entry.placeholder === "空=从头") as HTMLInputElement;
    // 空输入是「从头播放」：传 `undefined` 而不是 0，0 会表示「从第 1 步开始」。
    act(() => { button(container, "从该步播放")!.click(); });
    expect(history.playAction).toHaveBeenCalledWith("两步", undefined);
    act(() => setValue(fromInput, "1"));
    act(() => { button(container, "从该步播放")!.click(); });
    expect(history.playAction).toHaveBeenCalledWith("两步", 1);
  });
});

describe("U76 变量与数据集面板", () => {
  it("应用数据集只交出调用方选中的图片资源键", () => {
    const history = {
      variablesState: () => ({ ok: true, value: VARIABLES }),
      applyDataSet: vi.fn(() => ({ ok: true, value: {} })),
      importDataSets: vi.fn(), exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={controller(history)} readonly={false} />);
    expect(container.textContent).toContain("第一组");
    act(() => button(container, "应用")!.click());
    expect(history.applyDataSet).toHaveBeenCalledWith({ name: "第一组", images: {} });
  });

  it("CSV 导入把跳过列的原因显示出来", async () => {
    const history = {
      variablesState: () => ({ ok: true, value: VARIABLES }),
      applyDataSet: vi.fn(),
      importDataSets: () => ({ ok: true, value: { imported: 1, skipped: [{ column: "多余", reason: "没有同名变量" }] } }),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={controller(history)} readonly={false} />);
    const input = container.querySelector<HTMLInputElement>("[data-csv-file]")!;
    const file = new File(["名称,可见性\n第一组,true\n"], "sets.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.textContent).toContain("导入 1 个数据集");
    // 成功不是错误：回执不能渲染在错误槽里（否则用户看到一条错误样式的「成功」）。
    expect(container.querySelector("[data-data-sets-error]")).toBeNull();
    expect(container.querySelector("[data-data-sets-notice]")?.textContent).toContain("导入 1 个数据集");
    expect(container.querySelector("[data-csv-skipped]")?.textContent).toContain("没有同名变量");
  });

  it("CSV 导入失败显示内核原因", async () => {
    const history = {
      variablesState: () => ({ ok: true, value: VARIABLES }),
      applyDataSet: vi.fn(),
      importDataSets: () => fail("还没有变量定义：请先绑定图层"),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={controller(history)} readonly={false} />);
    const input = container.querySelector<HTMLInputElement>("[data-csv-file]")!;
    const file = new File(["名称\n第一组\n"], "sets.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("[data-data-sets-error]")?.textContent).toContain("请先绑定图层");
  });

  it("CSV 超预算在读文件之前就拒绝，不调用内核", async () => {
    // 预算来自内核；面板必须在 `file.text()` 之前看大小：读进内存再让内核拒绝等于白读一遍。
    const history = {
      variablesState: () => ({
        ok: true,
        value: { ...VARIABLES, budget: { maxCsvBytes: 8, maxDataSets: 4, maxValuesPerSet: 2, maxVariables: 2 } }
      }),
      applyDataSet: vi.fn(),
      importDataSets: vi.fn(),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={controller(history)} readonly={false} />);
    const input = container.querySelector<HTMLInputElement>("[data-csv-file]")!;
    const file = new File(["名称,可见性\n第一组,true\n"], "sets.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(history.importDataSets).not.toHaveBeenCalled();
    expect(container.querySelector("[data-data-sets-error]")?.textContent).toContain("超过上限");
  });
});

describe("U76 变量定义面板", () => {
  /** 带图层的控制器替身：变量编辑器的图层下拉来自工作区视图。 */
  const withLayers = (history: unknown, layers = [{ id: 3, name: "标题" }, { id: 4, name: "图片" }]) => ({
    dispatch: () => ({ ok: true, value: {} }),
    currentView: () => ({ hasDocument: true, document: { layers }, sessionActiveIndex: 0 }),
    features: { history }
  }) as never;

  it("添加变量提交整份定义（内核是替换语义，不能只发新增那一条）", () => {
    const history = {
      variablesState: () => ({ ok: true, value: VARIABLES }),
      defineVariables: vi.fn(() => ({ ok: true, value: VARIABLES })),
      applyDataSet: vi.fn(), importDataSets: vi.fn(), exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const nameInput = [...container.querySelectorAll("input")].find((entry) => entry.placeholder === "showTitle") as HTMLInputElement;
    act(() => { setValue(nameInput, "photo"); });
    const layerSelect = [...container.querySelectorAll("select")].find(
      (entry) => [...entry.options].some((option) => option.textContent === "图片")
    ) as HTMLSelectElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(layerSelect, "4");
      layerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => { button(container, "添加变量")!.click(); });

    // 已有的「可见性」必须一起提交，否则会被这次定义整份覆盖掉。
    expect(history.defineVariables).toHaveBeenCalledWith([
      { name: "可见性", layer: 1, type: "visibility" },
      { name: "photo", layer: 4, type: "visibility" }
    ]);
  });

  it("像素变量带方式/对齐/裁切，随整份定义提交", () => {
    const history = {
      variablesState: () => ({ ok: true, value: { defs: [], dataSets: [], active: null } }),
      defineVariables: vi.fn(() => ({ ok: true, value: VARIABLES })),
      applyDataSet: vi.fn(), importDataSets: vi.fn(), exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const kindSelect = [...container.querySelectorAll("select")].find(
      (entry) => [...entry.options].some((option) => option.textContent === "像素替换")
    ) as HTMLSelectElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(kindSelect, "pixelReplacement");
      kindSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const nameInput = [...container.querySelectorAll("input")].find((entry) => entry.placeholder === "showTitle") as HTMLInputElement;
    act(() => { setValue(nameInput, "cover"); });
    act(() => { button(container, "添加变量")!.click(); });

    expect(history.defineVariables).toHaveBeenCalledWith([
      { name: "cover", layer: 3, type: "pixelReplacement", method: "fit", align: "center", clip: false }
    ]);
  });

  it("重名与缺图层时本地拒绝，不发内核请求", () => {
    const history = {
      variablesState: () => ({ ok: true, value: VARIABLES }),
      defineVariables: vi.fn(),
      applyDataSet: vi.fn(), importDataSets: vi.fn(), exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const nameInput = [...container.querySelectorAll("input")].find((entry) => entry.placeholder === "showTitle") as HTMLInputElement;
    act(() => { setValue(nameInput, "可见性"); });
    act(() => { button(container, "添加变量")!.click(); });
    expect(history.defineVariables).not.toHaveBeenCalled();
    expect(container.querySelector("[data-data-sets-error]")?.textContent).toContain("已存在");

    // 没有图层时添加按钮禁用：不会提交一个指向不存在图层的定义。
    const empty = mount(<DataSetsPanel controller={withLayers({
      variablesState: () => ({ ok: true, value: { defs: [], dataSets: [], active: null } }),
      defineVariables: vi.fn(), applyDataSet: vi.fn(), importDataSets: vi.fn(),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    }, [])} readonly={false} />);
    expect(button(empty, "添加变量")!.disabled).toBe(true);
  });

  it("删除变量同样提交剩余整份定义", () => {
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [{ name: "可见性", layer: 1, kind: "visibility" }, { name: "标题", layer: 2, kind: "textReplacement" }],
        dataSets: [], active: null
      } }),
      defineVariables: vi.fn(() => ({ ok: true, value: VARIABLES })),
      applyDataSet: vi.fn(), importDataSets: vi.fn(), exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const row = container.querySelector('[data-variable="可见性"]')!;
    act(() => { [...row.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "删除变量")!.click(); });
    expect(history.defineVariables).toHaveBeenCalledWith([
      { name: "标题", layer: 2, type: "textReplacement" }
    ]);
  });

  it("有不认识的变量种类时拒绝重发整份定义，不猜一个种类写回去", () => {
    // `define` 是整份替换。解码时把未知种类猜成 visibility，会让「删掉另一个变量」这种无关操作
    // 把未来版本的变量静默改写。这里锁定：不认识就不发，并说明是哪几个变量。
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [
          { name: "可见性", layer: 1, kind: "visibility" },
          { name: "图层样式", layer: 2, kind: null, rawKind: "layerStyleReplacement" }
        ],
        dataSets: [], active: null
      } }),
      defineVariables: vi.fn(), applyDataSet: vi.fn(),
      importDataSets: vi.fn(), exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    // 未知种类如实显示，不伪装成「显隐」。
    expect(container.querySelector('[data-variable="图层样式"]')?.textContent).toContain("未知种类");
    expect(container.querySelector("[data-variable-unknown]")?.textContent).toContain("layerStyleReplacement");

    // 删除也不能发：整份替换会把未知种类写坏。
    const row = container.querySelector('[data-variable="可见性"]')!;
    act(() => { [...row.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "删除变量")!.click(); });
    expect(history.defineVariables).not.toHaveBeenCalled();
    // 添加同样被拦下。
    act(() => button(container, "添加变量")!.click());
    expect(history.defineVariables).not.toHaveBeenCalled();
    expect(button(container, "添加变量")!.disabled).toBe(true);
  });

  it("删掉一个变量时，其余像素变量保留方式/对齐/裁切", () => {
    // `define` 是整份替换：如果重发时漏掉 method/align/clip，用户设过的选项会被重置成默认。
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [
          { name: "showTitle", layer: 1, kind: "visibility" },
          { name: "cover", layer: 2, kind: "pixelReplacement", method: "fill", align: "bottomRight", clip: true }
        ],
        dataSets: [], active: null
      } }),
      defineVariables: vi.fn(() => ({ ok: true, value: VARIABLES })),
      applyDataSet: vi.fn(), importDataSets: vi.fn(), exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const row = container.querySelector('[data-variable="showTitle"]')!;
    act(() => { [...row.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "删除变量")!.click(); });
    expect(history.defineVariables).toHaveBeenCalledWith([
      { name: "cover", layer: 2, type: "pixelReplacement", method: "fill", align: "bottomRight", clip: true }
    ]);
  });

  it("删除数据集重发其余全部数据集的原始取值（整份替换语义）", () => {
    // `image.variables.dataSets` 没有单项删除：只能在重发时把其余数据集**原样带回**。
    // 只记「有几个值」是不够的——重发要的是 `{variable, kind, value}`，编不出来就会把别人的
    // 数据集覆盖成空值或被内核整条拒绝。
    const first = { variable: "showTitle", kind: "visibility", value: true };
    const second = { variable: "cover", kind: "pixels", value: "a.png" };
    const third = { variable: "title", kind: "text", value: "Hello" };
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [{ name: "showTitle", layer: 1, kind: "visibility" }],
        dataSets: [
          { name: "A", values: 1, entries: [first] },
          { name: "B", values: 2, entries: [second, third] }
        ],
        active: null
      } }),
      setDataSets: vi.fn(() => ({ ok: true, value: VARIABLES })),
      defineVariables: vi.fn(), applyDataSet: vi.fn(), importDataSets: vi.fn(),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const row = container.querySelector('[data-data-set="A"]')!;
    act(() => { [...row.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "删除")!.click(); });
    // 剩下的 B 原样重发，取值一字不差（含 `kind` 与 `value`）。
    expect(history.setDataSets).toHaveBeenCalledWith([{ name: "B", values: [second, third] }]);
  });

  it("拿不到数据集原始取值时不给删除按钮，避免用编造的值覆盖其它数据集", () => {
    // 精简宿主的 `values` 可能只是一个数字（测试替身常见）。这时「重发全集」无从还原，
    // 只能禁用删除并说明原因，不能凭条数编出一组空值写回去。
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [{ name: "showTitle", layer: 1, kind: "visibility" }],
        dataSets: [{ name: "A", values: 2, entries: [] }],
        active: null
      } }),
      setDataSets: vi.fn(),
      defineVariables: vi.fn(), applyDataSet: vi.fn(), importDataSets: vi.fn(),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const row = container.querySelector('[data-data-set="A"]')!;
    const remove = [...row.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "删除")!;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toContain("原始取值");
    act(() => { remove.click(); });
    expect(history.setDataSets).not.toHaveBeenCalled();
  });

  it("删除失败时不留下「已删除」的说明，避免同时说删了和没删掉", () => {
    const only = { variable: "showTitle", kind: "visibility", value: true };
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [{ name: "showTitle", layer: 1, kind: "visibility" }],
        dataSets: [{ name: "A", values: 1, entries: [only] }],
        active: 0
      } }),
      setDataSets: vi.fn(() => fail("没有活动文档")),
      defineVariables: vi.fn(), applyDataSet: vi.fn(), importDataSets: vi.fn(),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const row = container.querySelector('[data-data-set="A"]')!;
    act(() => { [...row.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "删除")!.click(); });
    expect(container.querySelector("[data-data-sets-error]")?.textContent).toContain("没有活动文档");
    expect(container.querySelector("[data-data-sets-notice]")).toBeNull();
  });

  it("宿主没实现 setDataSets 时说明是缺端口，而不是说视图缺原始取值", () => {
    // 两种「不能删」的原因不同：说成「视图没有原始取值」会让人去查解码器，实际是宿主没这端口。
    const only = { variable: "showTitle", kind: "visibility", value: true };
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [{ name: "showTitle", layer: 1, kind: "visibility" }],
        dataSets: [{ name: "A", values: 1, entries: [only] }],
        active: null
      } }),
      defineVariables: vi.fn(), applyDataSet: vi.fn(), importDataSets: vi.fn(),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const row = container.querySelector('[data-data-set="A"]')!;
    const remove = [...row.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "删除")!;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toContain("没有实现 setDataSets");
  });

  it("删掉最后一个数据集时提交空列表（内核要求 `dataSets` 仍是数组）", () => {
    const only = { variable: "showTitle", kind: "visibility", value: false };
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [{ name: "showTitle", layer: 1, kind: "visibility" }],
        dataSets: [{ name: "仅一个", values: 1, entries: [only] }],
        active: null
      } }),
      setDataSets: vi.fn(() => ({ ok: true, value: VARIABLES })),
      defineVariables: vi.fn(), applyDataSet: vi.fn(), importDataSets: vi.fn(),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const row = container.querySelector('[data-data-set="仅一个"]')!;
    act(() => { [...row.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "删除")!.click(); });
    expect(history.setDataSets).toHaveBeenCalledWith([]);
  });

  it("标出当前生效的数据集；删掉它时说明画布像素仍留着", () => {
    // 上游 `apply data set` 记一个下标；界面必须让用户看出「画布现在照哪一组渲染」。
    const active = { variable: "showTitle", kind: "visibility", value: true };
    const other = { variable: "showTitle", kind: "visibility", value: false };
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [{ name: "showTitle", layer: 1, kind: "visibility" }],
        dataSets: [{ name: "A", values: 1, entries: [active] }, { name: "B", values: 1, entries: [other] }],
        active: 1
      } }),
      setDataSets: vi.fn(() => ({ ok: true, value: VARIABLES })),
      defineVariables: vi.fn(), applyDataSet: vi.fn(), importDataSets: vi.fn(),
      exportDataSetsCsv: vi.fn(), exportDataSetsAsFiles: vi.fn()
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    expect(container.querySelector('[data-data-set="B"]')?.getAttribute("data-active")).toBe("true");
    expect(container.querySelector('[data-data-set="A"]')?.getAttribute("data-active")).toBe("false");
    expect(container.querySelector('[data-data-set="B"]')?.textContent).toContain("当前生效");

    const row = container.querySelector('[data-data-set="B"]')!;
    act(() => { [...row.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "删除")!.click(); });
    // 删除本身照做；但要说明「画布像素仍在、此后没有生效的数据集」，否则用户会以为画布被还原。
    expect(history.setDataSets).toHaveBeenCalledWith([{ name: "A", values: [active] }]);
    expect(container.querySelector("[data-data-sets-notice]")?.textContent).toContain("当前生效");
  });

  it("导出数据集把格式与命名模板交给内核，而不是写死 png", () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:set", revokeObjectURL: () => {} });
    const lastAnchor = captureDownload();
    const history = {
      variablesState: () => ({ ok: true, value: {
        defs: [{ name: "cover", layer: 1, kind: "pixelReplacement" }],
        dataSets: [{ name: "第一组", values: 1, entries: [{ variable: "cover", kind: "pixels", value: "a.png" }] }], active: null
      } }),
      defineVariables: vi.fn(), applyDataSet: vi.fn(), importDataSets: vi.fn(), exportDataSetsCsv: vi.fn(),
      exportDataSetsAsFiles: vi.fn(() => ({ ok: true, value: [{ name: "第一组", fileName: "第一组.jpg", bytes: 3, data: "AQID" }] }))
    };
    const container = mount(<DataSetsPanel controller={withLayers(history)} readonly={false} />);
    const format = container.querySelector<HTMLSelectElement>("[data-export-format]")!;
    const naming = container.querySelector<HTMLInputElement>("[data-export-naming]")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(format, "jpg");
      format.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => setValue(naming, "{document}-{name}"));
    act(() => { button(container, "导出数据集为文件…")!.click(); });

    // 编码与撞名预检在内核；界面只传选择和图片资源键。
    expect(history.exportDataSetsAsFiles).toHaveBeenCalledWith({
      format: "jpg", naming: "{document}-{name}", images: {}
    });
    // 交付的 MIME 跟着所选格式走，否则浏览器会把 JPEG 当 PNG 命名。
    expect(lastAnchor()!.download).toBe("第一组.jpg");
    expect(container.textContent).toContain("已交付 1 个文件");
  });
});

describe("U76 前台批处理面板", () => {
  const progress = (over: Partial<BatchProgressView> = {}): BatchProgressView => ({
    mode: "batch",
    total: 2,
    completed: 1,
    remaining: 1,
    running: true,
    cancelled: false,
    outputBytes: 256,
    results: [{ file: "a.png", ok: true, error: null, output: "a_out.png", bytes: 256 }],
    ...over
  });

  /** 选文件走真实的 File 读取路径（base64 交给内核）。 */
  async function pick(container: HTMLElement, names = ["a.png"]) {
    const input = container.querySelector<HTMLInputElement>("[data-batch-files]")!;
    const files = names.map((name) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }));
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  }

  it("逐文件报告；收尾前队列保留，界面不会自行收尾", async () => {
    const history = {
      beginBatch: vi.fn((_params: Record<string, unknown>) => ({ ok: true, value: 9 })),
      stepBatch: vi.fn(() => ({ ok: true, value: progress({ running: false, completed: 2, remaining: 0 }) })),
      cancelBatch: vi.fn(),
      finishBatch: vi.fn(() => ({ ok: true, value: progress({ running: false }) })),
      takeBatchFile: vi.fn()
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    await pick(container);

    await act(async () => { button(container, "开始")!.click(); });

    expect(history.beginBatch).toHaveBeenCalledWith(expect.objectContaining({ mode: "batch", format: "png" }));
    expect(history.beginBatch.mock.calls[0]![0]).toMatchObject({ input: [{ name: "a.png", data: "AQID" }] });
    expect(history.stepBatch).toHaveBeenCalledWith(9);
    const rows = container.querySelectorAll("[data-batch-result]");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-batch-result")).toBe("a.png");
    expect(rows[0]?.getAttribute("data-ok")).toBe("true");
    // 队列在收尾前保留：否则「领取」就没有字节可拿。
    expect(history.finishBatch).not.toHaveBeenCalled();
    expect(button(container, "领取")).toBeDefined();
  });

  it("取消在当前项结束后生效，剩余项不再启动", async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const history = {
        beginBatch: () => ({ ok: true, value: 5 }),
        // 永远「还有剩余」：如果界面不在取消后退出，这里会被反复调用。
        stepBatch: () => {
          calls.push(calls.length + 1);
          return { ok: true, value: progress({ running: true }) };
        },
        cancelBatch: vi.fn(() => ({ ok: true, value: progress({ running: false, cancelled: true, remaining: 1 }) })),
        finishBatch: vi.fn(),
        takeBatchFile: vi.fn()
      };
      const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
      await pick(container);

      act(() => { button(container, "开始")!.click(); });
      expect(calls).toEqual([1]);

      act(() => { button(container, "取消")!.click(); });
      expect(history.cancelBatch).toHaveBeenCalledWith(5);
      expect(container.querySelector("[data-batch-progress]")?.getAttribute("data-batch-progress")).toBe("cancelled");

      // 循环被唤醒后必须立刻退出：不能再 step。
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(calls).toEqual([1]);
      expect(history.finishBatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("领取字节走 takeBatchFile，收尾释放队列并隐藏领取入口", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:png", revokeObjectURL: () => {} });
    const lastAnchor = captureDownload();
    const history = {
      beginBatch: () => ({ ok: true, value: 4 }),
      stepBatch: () => ({ ok: true, value: progress({ running: false, completed: 1, remaining: 0 }) }),
      cancelBatch: vi.fn(),
      finishBatch: vi.fn(() => ({ ok: true, value: progress({ running: false }) })),
      takeBatchFile: vi.fn(() => ({ ok: true, value: { file: "a.png", output: "a_out.png", data: "AQID" } }))
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    await pick(container);
    await act(async () => { button(container, "开始")!.click(); });

    act(() => button(container, "领取")!.click());
    expect(history.takeBatchFile).toHaveBeenCalledWith(4, 0);
    expect(lastAnchor()?.download).toBe("a_out.png");

    act(() => button(container, "收尾")!.click());
    expect(history.finishBatch).toHaveBeenCalledWith(4);
    expect(button(container, "领取")).toBeUndefined();
    expect(container.querySelector("[data-batch-progress]")?.textContent).toContain("a.png");
  });

  it("还有未领取的交付字节时，收尾先说明会丢掉它们", async () => {
    // 内核的 `finishBatch` 直接移除队列，未领取的字节随之消失，之后 `takeBatchFile` 必然失败。
    // 「收尾」原先是一键操作，用户会以为只是整理一下列表，实际上会丢交付结果。
    const history = {
      beginBatch: () => ({ ok: true, value: 7 }),
      stepBatch: () => ({ ok: true, value: progress({ running: false, completed: 1, remaining: 0 }) }),
      cancelBatch: vi.fn(),
      finishBatch: vi.fn(() => ({ ok: true, value: progress({ running: false }) })),
      takeBatchFile: vi.fn()
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    await pick(container);
    await act(async () => { button(container, "开始")!.click(); });

    // 还没领取 → 收尾只弹确认，不释放队列。
    act(() => button(container, "收尾")!.click());
    expect(history.finishBatch).not.toHaveBeenCalled();
    const confirm = container.querySelector("[data-finish-confirm]")!;
    expect(confirm.textContent).toContain("1 项结果没有领取");
    act(() => button(container, "继续领取")!.click());
    expect(history.finishBatch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-finish-confirm]")).toBeNull();

    // 确认后才真正收尾。
    act(() => button(container, "收尾")!.click());
    act(() => button(container, "确认收尾")!.click());
    expect(history.finishBatch).toHaveBeenCalledWith(7);
    expect(button(container, "领取")).toBeUndefined();
  });

  it("领取失败显示内核原因（失败项或已交付）", async () => {
    const history = {
      beginBatch: () => ({ ok: true, value: 6 }),
      stepBatch: () => ({ ok: true, value: progress({ running: false, completed: 1, remaining: 0 }) }),
      cancelBatch: vi.fn(),
      finishBatch: vi.fn(),
      takeBatchFile: () => fail("第 0 项没有可交付的字节（失败项或已交付）")
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    await pick(container);
    await act(async () => { button(container, "开始")!.click(); });
    act(() => button(container, "领取")!.click());
    expect(container.querySelector("[data-automation-error]")?.textContent).toContain("没有可交付的字节");
  });

  it("处理步骤与命名模板交给内核：批处理要能真的套用一串动作", async () => {
    // 只发模式/格式/边长的话，「批处理」只会打开文件再导出，做不了把同一串动作套到一批文件上。
    const history = {
      beginBatch: vi.fn((_params: Record<string, unknown>) => ({ ok: true, value: 11 })),
      stepBatch: vi.fn(() => ({ ok: true, value: progress({ running: false, completed: 1, remaining: 0 }) })),
      cancelBatch: vi.fn(), finishBatch: vi.fn(() => ({ ok: true, value: progress({ running: false }) })), takeBatchFile: vi.fn()
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    await pick(container);
    const steps = container.querySelector<HTMLInputElement>("[data-batch-steps]")!;
    const naming = container.querySelector<HTMLInputElement>("[data-batch-naming]")!;
    act(() => setValue(steps, '[["image.imageSize", {"width": 800}]]'));
    act(() => setValue(naming, "out-{index}"));
    await act(async () => { button(container, "开始")!.click(); });

    expect(history.beginBatch).toHaveBeenCalledWith(expect.objectContaining({
      mode: "batch",
      format: "png",
      steps: [["image.imageSize", { width: 800 }]],
      naming: "out-{index}"
    }));
  });

  it("处理步骤不是合法 JSON 数组时本地拒绝，不发队列请求", async () => {
    // 写错的步骤让内核拒绝也是一次往返；更重要的是不能把「不是数组」当空数组静默提交——
    // 那样用户以为套了步骤，实际只做了格式转换。
    const history = {
      beginBatch: vi.fn(() => ({ ok: true, value: 1 })), stepBatch: vi.fn(), cancelBatch: vi.fn(),
      finishBatch: vi.fn(), takeBatchFile: vi.fn()
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    await pick(container);
    const steps = container.querySelector<HTMLInputElement>("[data-batch-steps]")!;
    act(() => setValue(steps, '[["image.imageSize"'));
    await act(async () => { button(container, "开始")!.click(); });
    expect(history.beginBatch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-automation-error]")?.textContent).toContain("不是合法 JSON");

    act(() => setValue(steps, '{"id":"image.imageSize"}'));
    await act(async () => { button(container, "开始")!.click(); });
    expect(history.beginBatch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-automation-error]")?.textContent).toContain("必须是数组");
  });

  it("载入堆栈的步骤套用在合成结果上，联系表才清空步骤", async () => {
    // 内核只对 `contactSheet` 清空 steps；`loadStack` 是「先合成成一份文档，再把步骤跑在这份结果上」。
    // 面板若把两者说成一样，用户会以为堆栈模式下步骤被忽略。
    const history = {
      beginBatch: vi.fn(() => ({ ok: true, value: 5 })),
      stepBatch: vi.fn(() => ({ ok: true, value: progress({ running: false, completed: 1, remaining: 0 }) })),
      cancelBatch: vi.fn(), finishBatch: vi.fn(() => ({ ok: true, value: progress({ running: false }) })), takeBatchFile: vi.fn()
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    const mode = container.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(mode, "loadStack");
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const text = () => container.querySelector("[data-batch-group]")?.textContent ?? "";
    expect(text()).toContain("合成结果");
    expect(text()).not.toContain("不会套用");

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(mode, "contactSheet");
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(text()).toContain("不会套用");
  });

  it("联系表把列/行交给内核，并在本地先检查格子够不够", async () => {
    // 内核按 `columns × rows` 排版（默认 5×6）并在开始前拒绝「输入张数超过格子数」。
    // 面板不放出这两个参数的话，选 31 张只会得到一句无从自救的拒绝。
    const history = {
      beginBatch: vi.fn(() => ({ ok: true, value: 12 })),
      stepBatch: vi.fn(() => ({ ok: true, value: progress({ running: false, completed: 1, remaining: 0 }) })),
      cancelBatch: vi.fn(), finishBatch: vi.fn(() => ({ ok: true, value: progress({ running: false }) })), takeBatchFile: vi.fn()
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    const mode = container.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(mode, "contactSheet");
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // 默认网格是 5×6=30 格：31 张发出去必被内核拒绝，这里先拦下并说明。
    await pick(container, Array.from({ length: 31 }, (_, index) => `p${index}.png`));
    await act(async () => { button(container, "开始")!.click(); });
    expect(history.beginBatch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-automation-error]")?.textContent).toContain("30 格");

    const columns = container.querySelector<HTMLInputElement>("[data-contact-columns]")!;
    const rows = container.querySelector<HTMLInputElement>("[data-contact-rows]")!;
    act(() => setValue(columns, "8"));
    act(() => setValue(rows, "6"));
    await act(async () => { button(container, "开始")!.click(); });
    expect(history.beginBatch).toHaveBeenCalledWith(expect.objectContaining({ mode: "contactSheet", columns: 8, rows: 6 }));
  });

  it("队列规划失败时不进入运行态，并显示原因", async () => {
    const history = {
      beginBatch: () => fail("同时最多保留 4 个前台队列，请先完成或取消现有队列"),
      stepBatch: vi.fn(), cancelBatch: vi.fn(), finishBatch: vi.fn(), takeBatchFile: vi.fn()
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    await pick(container);
    await act(async () => { button(container, "开始")!.click(); });

    expect(history.stepBatch).not.toHaveBeenCalled();
    expect(container.querySelector("[data-automation-error]")?.textContent).toContain("同时最多保留 4 个前台队列");
    expect(container.querySelector("[data-batch-progress]")).toBeNull();
  });

  it("没有输入文件时开始按钮禁用，不发队列请求", async () => {
    const history = {
      beginBatch: vi.fn(), stepBatch: vi.fn(), cancelBatch: vi.fn(), finishBatch: vi.fn(), takeBatchFile: vi.fn()
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    expect(button(container, "开始")!.disabled).toBe(true);
    await act(async () => { button(container, "开始")!.click(); });
    expect(history.beginBatch).not.toHaveBeenCalled();
  });

  it("卸载面板时释放未收尾的队列，避免占住槽位", async () => {
    const history = {
      beginBatch: () => ({ ok: true, value: 8 }),
      stepBatch: () => ({ ok: true, value: progress({ running: false, completed: 1, remaining: 0 }) }),
      cancelBatch: vi.fn(() => ({ ok: true, value: progress({ running: false, cancelled: true }) })),
      finishBatch: vi.fn(() => ({ ok: true, value: progress({ running: false }) })),
      takeBatchFile: vi.fn()
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    await pick(container);
    await act(async () => { button(container, "开始")!.click(); });
    expect(history.finishBatch).not.toHaveBeenCalled();

    act(() => root!.unmount());
    root = null;
    expect(history.finishBatch).toHaveBeenCalledWith(8);
    expect(container.querySelector("[data-automation-panel]")).toBeNull();
  });
});

describe("U76 受限脚本面板", () => {
  /** 脚本组与批处理组各自探测端口：只给脚本端口时批处理不渲染。 */
  it("只实现脚本端口时只渲染脚本组，不漏出批处理按钮", () => {
    const history = { runScript: vi.fn(() => ({ ok: true, value: { ok: true, preflight: null, results: [] } })) };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    expect(container.querySelector("[data-script-group]")).toBeDefined();
    expect(container.querySelector("[data-batch-group]")).toBeNull();
    expect(button(container, "开始")).toBeUndefined();
  });

  it("空脚本不发内核请求，只提示怎么写", () => {
    const history = { runScript: vi.fn() };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    act(() => button(container, "运行脚本")!.click());
    expect(history.runScript).not.toHaveBeenCalled();
    expect(container.querySelector("[data-script-error]")?.textContent).toContain("每行");
  });

  it("脚本文本原样交给内核，逐步骤结果与失败步骤都显示", () => {
    const history = {
      runScript: vi.fn(() => ({ ok: true, value: {
        ok: false,
        preflight: { steps: [{ step: 0, id: "layer.selectByName", enabled: true, playable: true, reason: null }], playable: true },
        results: [
          { step: 0, id: "layer.selectByName" },
          { step: 1, id: "filter.liquify", error: "首期未开放的功能：filter.liquify" }
        ]
      } }))
    };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "layer.selectByName {}\nfilter.liquify\n");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button(container, "运行脚本")!.click());

    expect(history.runScript).toHaveBeenCalledWith({ script: "layer.selectByName {}\nfilter.liquify\n" });
    // 中途失败不是「完成」：已成功步骤保留，失败步骤写明原因。
    expect(container.querySelector("[data-script-report]")?.getAttribute("data-script-report")).toBe("failed");
    const rows = container.querySelectorAll("[data-script-step]");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.getAttribute("data-ok")).toBe("false");
    expect(rows[1]?.textContent).toContain("filter.liquify");
    expect(container.querySelector("[data-script-error]")).toBeNull();
  });

  it("整组被拒（未知命令预检失败）时显示原因且不显示「已执行」", () => {
    const history = { runScript: vi.fn(() => fail("步骤 1 未开放：filter.liquify")) };
    const container = mount(<AutomationPanel controller={controller(history)} readonly={false} />);
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "filter.liquify");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button(container, "运行脚本")!.click());
    expect(container.querySelector("[data-script-report]")).toBeNull();
    expect(container.querySelector("[data-script-error]")?.textContent).toContain("filter.liquify");
  });
});
