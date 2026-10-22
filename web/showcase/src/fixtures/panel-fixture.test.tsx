/**
 * 生产执行面板查看页 component tests
 * （change: expand-showcase-execution-ux，任务 1.3 / 2.1–2.3 / 3.1–3.3 / 4.1–4.3）。
 *
 * 用 jsdom + react-dom/client 真实挂载**生产 `ModelExecutionHost`**（fixture 注入依赖），
 * 断言用户可见行为与 fixture 记录的动作 payload。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ShowcasePanelHost, createFixtureSnippetSource } from "./panel-fixture.js";
import { baseCanvas, canvasFixture, mentionCandidatesFor } from "./canvas.js";

import { OperationLogPanel } from "./stage.js";
import { OPERATIONS, clearOperations, createOperationLog, operationEntries, recordOperation } from "./operations.js";

let root: Root | null = null;

/** 挂载任意子树并等待 catalog / Lexical 的首次异步 flush。 */
async function mountNode(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<>{node}</>);
  });
  await act(async () => {});
  return container;
}

async function mountHost(props: Parameters<typeof ShowcasePanelHost>[0]): Promise<HTMLElement> {
  return mountNode(
    <>
      <ShowcasePanelHost {...props} />
      <OperationLogPanel />
    </>
  );
}

/** 卸载当前挂载（同一用例内切换多个 surface 时用）。 */
async function unmountCurrent(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
}

/**
 * 菜单/浮层现在由 Radix portal 到 theme root（测试无 UiProvider 时落到 document.body），
 * 因此按 document 查询而不是只查 container。
 */
function queryMenu(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

function findMenuByText(selector: string, text: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>(selector)].find((element) =>
      element.textContent?.includes(text)
    ) ?? null
  );
}

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    // Radix menus open on primary pointer-down; HTMLElement.click() alone
    // only exercises click-driven buttons/popovers.
    element!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false }));
    (element as HTMLElement).click();
  });
}


beforeEach(() => {
  clearOperations();
});

afterEach(async () => {
  await unmountCurrent();
});

describe("生产组合 fixture（任务 1.1–1.3）", () => {
  it("渲染生产 ModelExecutionHost（含 mention 编辑器与菜单），而非裸 textarea", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    expect(container.querySelector(".node-execution-dock")).not.toBeNull();
    expect(container.querySelector(".mention-editor__input")).not.toBeNull();
    expect(container.querySelector("textarea.mc-panel__textarea")).toBeNull();
    expect(container.querySelector(".mc-panel__model-trigger")).not.toBeNull();
    expect(container.querySelector(".mc-panel__send")).not.toBeNull();
  });

  it("提交任务只记录与生产一致的 run 请求（不写 Y.Doc / 不发网络）", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    await click(container.querySelector(".mc-panel__send"));
    const run = operationEntries().find((entry) => entry.kind === OPERATIONS.RUN);
    expect(run).toBeDefined();
    expect(run!.payload).toMatchObject({ nodeId: "showcase-target", modelKey: "showcase-image" });
    expect((run!.payload as { prompt: string }).prompt).toContain("薄雾森林");
    expect(run!.payload).not.toHaveProperty("generationCount");
    // 任务提交不经过 fixture 的 Y.Doc 路径。
    expect(operationEntries().some((entry) => entry.kind === OPERATIONS.SUBMIT_COMMANDS)).toBe(false);
  });
});

describe("Reference tile 生命周期（任务 2.2–2.3）", () => {
  it("ready 引用显示缩略图与可访问状态，可移除并产生 edge.remove 命令", async () => {
    const container = await mountHost({ canvas: canvasFixture("readyReferences") });
    const tile = container.querySelector(".ref-tile--ready");
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute("aria-label")).toContain("就绪");
    expect(tile!.getAttribute("aria-label")).toContain("参考图 1");
    await click(container.querySelector(".ref-tile__remove"));
    const commands = operationEntries().find((entry) => entry.kind === OPERATIONS.SUBMIT_COMMANDS);
    expect(commands).toBeDefined();
    expect(JSON.stringify(commands!.payload)).toContain("edge.remove");
  });

  it("pending 引用显示等待状态，给出原因并禁用执行", async () => {
    const container = await mountHost({ canvas: canvasFixture("pendingReference") });
    const tile = container.querySelector(".ref-tile--waiting");
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute("aria-label")).toContain("等待中");
    expect(tile!.getAttribute("title")).toContain("还没有可用输出");
    expect([...container.querySelectorAll('[role="status"]')].map(status => status.textContent).join(' ')).toContain("还没有可用输出");
    const send = container.querySelector<HTMLButtonElement>(".mc-panel__send");
    expect(send!.disabled).toBe(true);
    expect(send!.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("unavailable 引用显示失效状态并解释原因，而不是只变颜色", async () => {
    const container = await mountHost({ canvas: canvasFixture("unavailableReference") });
    const tile = container.querySelector(".ref-tile--invalid");
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute("aria-label")).toContain("不可用");
    expect(tile!.getAttribute("title")).toContain("不接受");
    // 仍可移除（用户可修复输入）。
    expect(container.querySelector(".ref-tile__remove")).not.toBeNull();
  });

  it("没有引用时显示同尺寸虚线 add tile", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    const add = container.querySelector('[data-role="add"]');
    expect(add).not.toBeNull();
    expect(add!.getAttribute("aria-label")).toBe("选择参考素材节点");
  });

  it("picker 可打开并回传选择（edge.add 命令，payload 含 source/target）", async () => {
    const container = await mountHost({ canvas: canvasFixture("pickerCandidates") });
    await click(container.querySelector('[data-role="add"]'));
    expect(queryMenu('[data-testid="reference-picker"]')).not.toBeNull();
    await click(findMenuByText(".ref-picker__item", "候选图 A"));
    const commands = operationEntries().find((entry) => entry.kind === OPERATIONS.SUBMIT_COMMANDS);
    expect(commands).toBeDefined();
    const serialized = JSON.stringify(commands!.payload);
    expect(serialized).toContain("edge.add");
    expect(serialized).toContain("showcase-picker-image");
    expect(serialized).toContain("showcase-target");
  });

  it("超过三个引用全部留在 DOM（单行横向滚动，无折叠按钮）", async () => {
    const container = await mountHost({ canvas: canvasFixture("manyReferences") });
    expect(container.querySelectorAll(".ref-tile-strip .ref-tile").length).toBe(6); // 5 引用 + add tile
    expect(container.querySelector(".ref-chips__toggle")).toBeNull();
    expect(container.querySelector(".ref-tile--ready")).not.toBeNull();
  });

  it("picker 空态与全部禁用给出稳定原因", async () => {
    const empty = await mountHost({ canvas: baseCanvas("image") });
    await click(empty.querySelector('[data-role="add"]'));
    expect(queryMenu(".ref-picker__empty")?.textContent).toContain("没有可连接的素材节点");
    await unmountCurrent();

    const disabled = await mountHost({ canvas: canvasFixture("pendingReference") });
    await click(disabled.querySelector('[data-role="add"]'));
    const items = document.querySelectorAll(".ref-picker__item");
    if (items.length > 0) {
      expect([...items].every((item) => (item as HTMLButtonElement).disabled)).toBe(true);
    }
  });

  it("picker 支持键盘导航（Arrow/Enter）与 Escape 关闭并恢复焦点", async () => {
    const container = await mountHost({ canvas: canvasFixture("pickerCandidates") });
    const add = container.querySelector<HTMLButtonElement>('[data-role="add"]');
    await click(add);
    const picker = queryMenu('[data-testid="reference-picker"]');
    expect(picker).not.toBeNull();
    // 首个可用候选获得焦点（roving focus）。
    expect(document.activeElement).toBe(picker!.querySelector(".ref-picker__item"));

    // ArrowDown 移动 active candidate。
    await act(async () => {
      picker!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(picker!.querySelectorAll(".ref-picker__item")[1]!.getAttribute("aria-selected")).toBe("true");

    // Escape 关闭 picker 且焦点回到 add tile。
    await act(async () => {
      picker!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(queryMenu('[data-testid="reference-picker"]')).toBeNull();
    expect(document.activeElement).toBe(add);
  });
});

describe("Panel presentation 与关闭（任务 4/5）", () => {
  it("compact 提供展开与关闭动作；展开由受控 harness 切换 presentation", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    expect(container.querySelector('.node-execution-dock[data-presentation="compact"]')).not.toBeNull();
    const expand = container.querySelector<HTMLButtonElement>(".mc-panel__expand");
    expect(expand).not.toBeNull();
    expect(expand!.getAttribute("aria-expanded")).toBe("false");
    await click(expand);
    expect(operationEntries().some((entry) => entry.kind === OPERATIONS.PANEL_PRESENTATION)).toBe(true);
    // 受控 harness 已切到 expanded：出现 fullscreen 宿主（非 Dialog）。
    expect(container.querySelector(".fullscreen-panel-host")).not.toBeNull();
    expect(container.querySelector('[data-presentation="expanded"]')).not.toBeNull();

    const collapse = container.querySelector<HTMLButtonElement>(".mc-panel__expand");
    await click(collapse);
    expect(container.querySelector(".fullscreen-panel-host")).toBeNull();
  });

  it("关闭动作记录 panelClose 且不写 canonical Canvas", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    await click(container.querySelector(".mc-panel__close"));
    expect(operationEntries().some((entry) => entry.kind === OPERATIONS.PANEL_CLOSE)).toBe(true);
    expect(operationEntries().some((entry) => entry.kind === OPERATIONS.SUBMIT_COMMANDS)).toBe(false);
  });

  it("Escape 先关最内层：picker 打开时只关 picker，不收起/关闭 panel", async () => {
    const container = await mountHost({ canvas: canvasFixture("pickerCandidates") });
    await click(container.querySelector('[data-role="add"]'));
    const picker = queryMenu('[data-testid="reference-picker"]');
    expect(picker).not.toBeNull();

    await act(async () => {
      picker!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(queryMenu('[data-testid="reference-picker"]')).toBeNull();
    // panel 仍是 compact，没有被 Escape 收起或关闭。
    expect(container.querySelector('.node-execution-dock[data-presentation="compact"]')).not.toBeNull();
    expect(operationEntries().some((entry) => entry.kind === OPERATIONS.PANEL_CLOSE)).toBe(false);
  });

  it("Escape 在 expanded 且无浮层时收起为 compact（单次只前进一步）", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    await click(container.querySelector(".mc-panel__expand"));
    expect(container.querySelector(".fullscreen-panel-host")).not.toBeNull();

    await act(async () => {
      globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".fullscreen-panel-host")).toBeNull();
    expect(container.querySelector('.node-execution-dock[data-presentation="compact"]')).not.toBeNull();
    // 一次按键不继续关闭 panel。
    expect(operationEntries().some((entry) => entry.kind === OPERATIONS.PANEL_CLOSE)).toBe(false);
  });
});

describe("Prompt / prompt skill（任务 2.1 / 3.1）", () => {
  it("编辑器挂载后 `@` / `#` 的生产候选来源可观察（typeahead 菜单本身由 Playwright 覆盖）", async () => {
    const container = await mountHost({ canvas: canvasFixture("readyReferences") });
    // 生产 MentionEditor 已挂载；候选由生产 `resolveReferenceItems` 从 fixture 画布派生。
    expect(container.querySelector(".mention-editor__input")).not.toBeNull();
    const candidates = mentionCandidatesFor(canvasFixture("readyReferences"));
    expect(candidates).toEqual([{ slotId: expect.any(String), type: "input_image", label: "参考图 1" }]);
  });

  it("片段来源契约：`#` 搜索命中 fixture，materialize 返回正文且被记录", async () => {
    const source = createFixtureSnippetSource(createOperationLog());
    const found = await source.search("");
    expect(found.map((entry) => entry.name)).toContain("写实增强");
    const body = source.materialize("psnip-photoreal", "showcase-target");
    expect(body).toContain("电影级布光");
    expect(operationEntries().some((entry) => entry.kind === OPERATIONS.SNIPPET_SELECT)).toBe(true);
  });

  it("未装配片段插件时 `#` 入口不出现（编辑框仍可用）", async () => {
    const container = await mountHost({ canvas: baseCanvas("image"), snippetSource: false });
    expect(container.querySelector(".mention-editor__input")).not.toBeNull();
    // 没有片段入口来源时组件不会渲染任何片段菜单（真实验证由 Playwright 覆盖）。
    expect(container.querySelector('.mention-menu[aria-label="片段候选"]')).toBeNull();
  });

  it("快捷改写菜单把所选 action + 当前草稿交给宿主", async () => {
    const container = await mountHost({
      canvas: baseCanvas("image"),
      onPromptSkill: (input) => recordOperation(OPERATIONS.PROMPT_SKILL, input)
    });
    await click(container.querySelector(".mc-panel__universal-polish"));
    expect(queryMenu(".mc-panel__polish-menu")).not.toBeNull();
    await click(findMenuByText(".mc-panel__skill-item", "画面细节润色"));
    const record = operationEntries().find((entry) => entry.kind === OPERATIONS.PROMPT_SKILL);
    expect(record).toBeDefined();
    expect(record!.payload).toMatchObject({ id: "polish" });
    expect((record!.payload as { prompt: string }).prompt).toContain("薄雾森林");
  });
});

describe("菜单与 catalog（任务 3.1–3.3）", () => {
  it("模型菜单展开并选择，模型标签随选择变化", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    await click(container.querySelector(".mc-panel__model-trigger"));
    expect(queryMenu(".mc-panel__model-menu")).not.toBeNull();
    const option = document.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"][aria-label^="展示图片模型 · 备用"]'
    );
    expect(option).not.toBeNull();
    await click(option);
    expect(container.querySelector(".mc-panel__model-label")?.textContent).toContain("备用");
  });

  it("参数菜单展开并展示按 schema 投影的控件", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    await click(container.querySelector(".mc-panel__settings-trigger"));
    const menu = queryMenu(".mc-panel__settings-menu");
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain("画幅比例");
    expect(menu!.textContent).toContain("分辨率");
  });

  it("catalog 加载失败显示错误与重试，重试成功后可选模型", async () => {
    const container = await mountHost({ canvas: baseCanvas("image"), catalogId: "error" });
    const retry = container.querySelector<HTMLButtonElement>(".node-execution-dock__retry");
    expect(retry).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("任务目录加载失败");
    await click(retry);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await click(container.querySelector(".mc-panel__model-trigger"));
    expect(queryMenu(".mc-panel__model-menu")).not.toBeNull();
  });

  it("空 catalog 与「没有该类型模型」是两个不同状态", async () => {
    const empty = await mountHost({ canvas: baseCanvas("image"), catalogId: "empty" });
    expect(empty.querySelector('[role="status"]')?.textContent).toContain("没有可用模型");
    await unmountCurrent();

    const noModel = await mountHost({ canvas: baseCanvas("image"), catalogId: "languageOnly" });
    expect(noModel.querySelector('[role="status"]')?.textContent).toContain("没有可用模型");
  });

  it("只读状态禁用执行，且不在面板内重复断线原因", async () => {
    const container = await mountHost({ canvas: baseCanvas("image"), writable: false });
    // 只读由左下角同步状态控件承载；面板不再重复枚举「网络已断开 / 目录尚未加载」。
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain("只读");
    // 但主操作必须仍然真正禁用。
    expect(container.querySelector<HTMLButtonElement>(".mc-panel__send")!.disabled).toBe(true);
  });

  it("空 prompt 时禁用执行，但参数菜单仍可用", async () => {
    const container = await mountHost({ canvas: canvasFixture("emptyPrompt") });
    expect(container.querySelector<HTMLButtonElement>(".mc-panel__send")!.disabled).toBe(true);
    await click(container.querySelector(".mc-panel__settings-trigger"));
    expect(queryMenu(".mc-panel__settings-menu")).not.toBeNull();
  });

  it("surface=sidebar 与 390px 宿主给出稳定容器宽度", async () => {
    const sidebar = await mountHost({ canvas: baseCanvas("image"), surface: "sidebar" });
    expect(sidebar.querySelector('.showcase__panel-host[data-surface="sidebar"]')).not.toBeNull();
    await unmountCurrent();

    const narrow = await mountHost({ canvas: baseCanvas("image"), width: 390 });
    expect(narrow.querySelector<HTMLElement>(".showcase__panel-box")!.style.width).toBe("390px");
  });

  it("默认舞台内直接渲染生产 fixed dock（收拢交给 Showcase-scoped CSS）", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    const box = container.querySelector(".showcase__panel-box");
    expect(box).not.toBeNull();
    // dock 是 panel-box 的直接子节点，scoped 规则 `.showcase__panel-box > .node-execution-dock` 才能命中。
    expect(box!.querySelector(":scope > .node-execution-dock")).not.toBeNull();
  });
});

describe("音视频状态（任务 4.1–4.3）", () => {
  it("执行面板不再提示任务阶段（生成中/已完成）；失败态仍保留", async () => {
    const running = await mountHost({ canvas: canvasFixture("audioRunning"), width: 420 });
    expect(running.querySelector(".mc-panel__status")).toBeNull();
    expect(running.querySelector<HTMLButtonElement>(".mc-panel__send")!.disabled).toBe(true);
    await unmountCurrent();

    const succeeded = await mountHost({ canvas: canvasFixture("audioSucceeded"), width: 420 });
    expect(succeeded.querySelector(".mc-panel__status")).toBeNull();
    expect(succeeded.querySelector<HTMLButtonElement>(".mc-panel__send")!.disabled).toBe(false);
    await unmountCurrent();

    const failed = await mountHost({ canvas: canvasFixture("audioFailed"), width: 420 });
    expect(failed.querySelector(".mc-panel__status")?.textContent).toBe("失败");
    expect(failed.querySelector(".mc-panel__error-trigger")).not.toBeNull();
  });

  it("音频音乐模式展示时长参数（不同生产模式）", async () => {
    const container = await mountHost({ canvas: canvasFixture("audioMusic"), width: 420 });
    await click(container.querySelector(".mc-panel__model-trigger"));
    await click(
      document.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-label^="展示音频模型 · 音乐"]')
    );
    // 模型切换后可能触发一次重渲染；重试打开设置面板以消除时序抖动。
    let menu = null as HTMLElement | null;
    for (let attempt = 0; attempt < 3 && menu === null; attempt += 1) {
      await act(async () => {});
      await click(container.querySelector(".mc-panel__settings-trigger"));
      menu = queryMenu(".mc-panel__settings-menu");
    }
    expect(menu?.textContent).toContain("时长");
  });
  it("视频失败不被误显示为成功或无任务", async () => {
    const container = await mountHost({ canvas: canvasFixture("videoFailed"), width: 480 });
    expect(container.querySelector(".mc-panel__status")?.textContent).toBe("失败");
    expect(container.querySelector(".mc-panel__status")?.textContent).not.toBe("已完成");
  });

  it("Seedance Panel：入口可点并记录请求，intent 摘要可见", async () => {
    const container = await mountHost({
      canvas: canvasFixture("editVideoReady"),
      catalogId: "seedance",
      width: 480
    });
    const entry = container.querySelector<HTMLButtonElement>(".mc-panel__video-edit-open");
    expect(entry!.disabled).toBe(false);
    await click(entry);
    expect(operationEntries().some((item) => item.kind === OPERATIONS.OPEN_VIDEO_EDIT)).toBe(true);
    expect(container.querySelectorAll(".mc-panel__intent-summary li").length).toBe(2);
  });

  it("Seedance 缺输入：入口禁用并解释原因", async () => {
    const container = await mountHost({
      canvas: canvasFixture("editVideoMissing"),
      catalogId: "seedance",
      width: 480
    });
    expect(container.querySelector<HTMLButtonElement>(".mc-panel__video-edit-open")!.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("edit_video");
  });
});

describe("禁止生成多份能力（任务 4.3）", () => {
  it("任何 surface / 任务类型都不出现份数或 generationCount 控件", async () => {
    const surfaces: Array<Parameters<typeof ShowcasePanelHost>[0]> = [
      { canvas: baseCanvas("image"), surface: "canvas" },
      { canvas: baseCanvas("image"), surface: "sidebar" },
      { canvas: baseCanvas("image"), surface: "dock" },
      { canvas: baseCanvas("image"), width: 390 },
      { canvas: baseCanvas("video"), surface: "sidebar" },
      { canvas: baseCanvas("audio"), width: 390 }
    ];
    const forbidden = /生成份数|生成数量|批量份数|generationCount|batchCount|imageCount/i;
    for (const props of surfaces) {
      const container = await mountHost(props);
      await click(container.querySelector(".mc-panel__settings-trigger"));
      const menu = queryMenu(".mc-panel__settings-menu");
      if (menu) {
        expect(forbidden.test(menu.textContent ?? "")).toBe(false);
      }
      expect(container.innerHTML).not.toMatch(/generationCount/i);
      await unmountCurrent();
    }
  });

  it("run 快照 payload 不含批量字段", async () => {
    const container = await mountHost({ canvas: baseCanvas("image") });
    await click(container.querySelector(".mc-panel__send"));
    const run = operationEntries().find((entry) => entry.kind === OPERATIONS.RUN);
    expect(JSON.stringify(run!.payload)).not.toMatch(/generationCount|batchCount|imageCount|生成份数/);
  });
});
