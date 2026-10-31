/**
 * 片场检查面板 Showcase 测试
 * （change: 2026-10-10-improve-film-set-editing-and-inspector，任务 7.1 / showcase-acceptance）。
 *
 * 组合生产 `ModelEditorOverlay` / `FilmSetObjectToolbar` / `FilmSetAdaptationConfirm` 与内存
 * fixture，断言状态矩阵（多对象/长名称/空集合/只读/失配）与本地交互零命令；不复制
 * 生产 markup。
 *
 * @vitest-environment jsdom
 */
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFilmSetNodeData } from "@woohaa3/contracts";
import { filmSetInspectorCanvas, FilmSetAdaptationStage, FilmSetInspectorStage } from "./film-set-inspector-fixtures.js";
import { woohaa3CanvasStore } from "../../../frontend/src/cordis/services/canvas-state/index.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  document.body.innerHTML = "";
  woohaa3CanvasStore.getState().applyRemoteCanvas(null as never);
});

async function mount(ui: ReactElement) {
  root = createRoot(container);
  await act(async () => {
    root!.render(ui);
  });
}

const options = () => [...document.querySelectorAll('[role="option"]')] as HTMLButtonElement[];
const tabs = () => [...document.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
const commandCount = () => Number(document.querySelector('[data-testid="film-set-submitted"]')?.getAttribute("data-count") ?? "0");

describe("片场检查面板 Showcase（任务 7.1）", () => {
  it("多对象 + 选中：生产 shell、三任务页、对象列表与受限属性", async () => {
    await mount(<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" />);
    expect(document.querySelector(".model-editor-dock")).not.toBeNull();
    expect(tabs()).toHaveLength(0);
    expect(document.querySelector(".film-set-animation-controls")).not.toBeNull();
    expect(options().map((o) => o.getAttribute("aria-label"))).toEqual([
      "模型 · 角色 A",
      "模型 · 角色 B",
      "地面 · 地面"
    ]);
    expect(options().find((o) => o.getAttribute("aria-label") === "模型 · 角色 A")?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".film-set-object-fields")).not.toBeNull();
    // 片场对象是 group 的成员（change: 2026-10-28-migrate-film-set-to-groups）：按钮只把对象
    // 从片场移除，不再暗示删除节点本身。
    expect(document.querySelector(".film-set-object-delete")?.textContent).toContain("从片场移除");
    expect(commandCount()).toBe(0);
  });

  it("无选中：显示列表与点选提示，不显示属性", async () => {
    await mount(<FilmSetInspectorStage fixtureId="mixed" selectedItemId={null} />);
    expect(options()).toHaveLength(3);
    expect(document.querySelector(".film-set-object-fields")).toBeNull();
    expect(document.querySelector(".film-set-object-dock .film-set-object-hint")?.textContent).toContain("点选");
  });

  it("空集合：稳定空态，无假对象", async () => {
    await mount(<FilmSetInspectorStage fixtureId="empty" selectedItemId={null} />);
    expect(options()).toHaveLength(0);
    expect(document.querySelector(".film-set-object-dock .film-set-object-list__empty")?.textContent).toContain("片场为空");
  });

  it("长名称：完整名称可读（title 回退）", async () => {
    await mount(<FilmSetInspectorStage fixtureId="longName" selectedItemId="a" />);
    const first = options()[0]!;
    expect(first.getAttribute("title")).toBe("非常长的中文对象名称用于验证截断与完整可读");
    expect(document.querySelector(".film-set-selection-heading h3")?.getAttribute("title")).toBe("非常长的中文对象名称用于验证截断与完整可读");
  });

  it("只读：删除入口禁用，属性仍可读", async () => {
    await mount(<FilmSetInspectorStage fixtureId="mixed" selectedItemId="a" writable={false} readOnly />);
    const del = document.querySelector(".film-set-object-delete") as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(document.querySelector(".film-set-object-fields")).not.toBeNull();
  });

  it("失配：确认按钮提交一条 filmSet.clipPatch", async () => {
    const { canvas } = filmSetInspectorCanvas("adaptation");
    expect(decodeFilmSetNodeData(canvas.nodeData.film)).toMatchObject({ ok: true });
    await mount(<FilmSetAdaptationStage />);
    const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("确认适配关联"));
    expect(confirm).toBeTruthy();
    await act(async () => { (confirm as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(commandCount()).toBe(1);
  });

  it("展开构图不提交内容，对象和拍摄镜头同时可达", async () => {
    await mount(<FilmSetInspectorStage fixtureId="adaptation" selectedItemId="a" />);
    expect(tabs()).toHaveLength(0);
    const composition = document.querySelector<HTMLDetailsElement>(".film-set-composition")!;
    await act(async () => { composition.querySelector("summary")!.click(); });
    expect(composition.open).toBe(true);
    expect(commandCount()).toBe(0);
  });
});
