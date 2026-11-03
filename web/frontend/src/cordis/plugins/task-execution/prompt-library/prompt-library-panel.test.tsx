/**
 * 提示词库面板的渲染测试：加载、错误、筛选、收藏与「使用」。
 *
 * 取数用注入的 `fetchImpl`，不联网。
 *
 * **不用 `@testing-library/react`**：它不在本包的依赖里，会解析到根目录那份 React，
 * 与本包的 React 不是同一实例（`Cannot read properties of null (reading 'useState')`）。
 * 同目录其它 jsdom 用例都用 `createRoot` + `act`，这里照办。
 *
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptLibraryPanel } from "./prompt-library-panel.js";

const snapshot = {
  version: "1.0",
  categories: ["室内设计", "建筑设计"],
  fetchedAt: 1,
  prompts: [
    {
      id: "p1",
      title: "3D 操作轴测图",
      text: "生成一张轴测视角的室内操作图",
      category: "室内设计",
      tags: ["室内"],
      createdAt: "",
      updatedAt: ""
    },
    {
      id: "p2",
      title: "室内海报",
      text: "设计一张海报",
      category: "建筑设计",
      tags: [],
      createdAt: "",
      updatedAt: ""
    }
  ]
};

const okFetch = async () => ({ ok: true, status: 200, json: async () => snapshot }) as Response;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 渲染并等首次加载落定（fetch 是微任务，act 会把随之而来的状态更新一起冲掉）。 */
async function mount(props: Parameters<typeof PromptLibraryPanel>[0]) {
  await act(async () => {
    root.render(<PromptLibraryPanel {...props} />);
  });
}

const byText = (text: string) => [...container.querySelectorAll("button, article, p, h4, span")].filter((el) => el.textContent === text);
const queryText = (text: string) => byText(text)[0] ?? null;

describe("PromptLibraryPanel", () => {
  it("渲染预设与分类，点「使用」把正文交出去", async () => {
    const onUse = vi.fn();
    await mount({ onUse, fetchImpl: okFetch as never });

    expect(queryText("3D 操作轴测图")).not.toBeNull();
    expect(queryText("室内海报")).not.toBeNull();
    expect(container.querySelector('[aria-label="分类筛选"]')?.textContent).toContain("室内设计");

    const useButtons = [...container.querySelectorAll("button")].filter((b) => b.textContent === "使用");
    await act(async () => {
      useButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onUse).toHaveBeenCalledWith("生成一张轴测视角的室内操作图");
    expect(queryText("已写入")).not.toBeNull();
  });

  it("收藏后出现在「我的收藏」，取消后消失", async () => {
    await mount({ onUse: () => undefined, fetchImpl: okFetch as never });

    const favButton = container.querySelector('[aria-label="收藏 3D 操作轴测图"]') as HTMLButtonElement;
    await act(async () => {
      favButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const favTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.includes("我的收藏"))!;
    await act(async () => {
      favTab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(queryText("3D 操作轴测图")).not.toBeNull();
    expect(queryText("室内海报")).toBeNull();

    const unfav = container.querySelector('[aria-label="取消收藏 3D 操作轴测图"]') as HTMLButtonElement;
    await act(async () => {
      unfav.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(queryText("3D 操作轴测图")).toBeNull();
    expect(localStorage.getItem("woohaa.prompt-library.favorites.v1")).toBe("[]");
  });

  it("按分类筛选", async () => {
    await mount({ onUse: () => undefined, fetchImpl: okFetch as never });

    const categoryButton = [...container.querySelectorAll('[aria-label="分类筛选"] button')].find(
      (b) => b.textContent === "建筑设计"
    ) as HTMLButtonElement;
    await act(async () => {
      categoryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(queryText("3D 操作轴测图")).toBeNull();
    expect(queryText("室内海报")).not.toBeNull();
  });

  it("搜索命中正文", async () => {
    await mount({ onUse: () => undefined, fetchImpl: okFetch as never });

    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      // React 的受控 input 监听的是原生 input 事件；直接改 value 再派发。
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "轴测视角");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(queryText("3D 操作轴测图")).not.toBeNull();
    expect(queryText("室内海报")).toBeNull();
  });

  it("加载失败时显示后端给的原因，并可重试", async () => {
    let attempt = 0;
    const failing = async () => {
      attempt += 1;
      return attempt === 1
        ? ({ ok: false, status: 502, json: async () => ({ error: "提示词库加载失败：上游返回 HTTP 403" }) } as Response)
        : okFetch();
    };
    await mount({ onUse: () => undefined, fetchImpl: failing as never });

    expect(container.textContent).toContain("提示词库加载失败：上游返回 HTTP 403");
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "重试")!;
    await act(async () => {
      retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(queryText("3D 操作轴测图")).not.toBeNull();
  });

  it("搜索无结果时给出空态说明", async () => {
    await mount({ onUse: () => undefined, fetchImpl: okFetch as never });
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "不存在的词");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("没有匹配的提示词");
  });
});
