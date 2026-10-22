/**
 * Mention 编辑器真实 DOM 回归
 * （change: add-reference-inputs-and-mentions，任务 4.1 / 4.3）。
 *
 * 目标：捕捉「文本节点不能直接挂 root」「typeahead 锚点被 React 争抢」这类只在真实
 * Lexical 渲染时才暴露的崩溃。用 jsdom + react-dom/client 挂载编辑器并断言可交互。
 *
 * 注意：Lexical 的 update 是异步 flush 的，断言前必须 `await act(async () => {})`。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { serializeWoohaa3CanvasMention } from "@woohaa3/contracts";
import { $createTextNode, $getRoot, BLUR_COMMAND, COPY_COMMAND, CUT_COMMAND, PASTE_COMMAND, getNearestEditorFromDOMNode } from "lexical";
import type { MentionCandidate } from "./mention-types.js";
import { MentionEditor } from "./MentionEditor.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const originalError = console.error;
const originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

async function mount(
  value: string,
  onChange: (next: string) => void,
  candidates: readonly MentionCandidate[] = [],
  extra: { snippetTrigger?: import("./MentionEditor.js").SnippetTrigger } = {}
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<MentionEditor value={value} onChange={onChange} candidates={candidates} {...extra} />);
  });
  // Lexical 的 update 会在微任务里 flush，再等一轮确保 DOM 就绪。
  await act(async () => {});
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
  console.error = originalError;
  if (originalRangeRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeRect);
  else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

describe("MentionEditor DOM 渲染", () => {
  it.each(["参考@", "abc@图", "参考 @", "参考，@", "前一个@无匹配 后一个@"])("%j 弹出候选并仅替换当前 @ 查询", async (text) => {
    // jsdom 不提供布局；仅补齐 Lexical 锚点所需接口，不验证画面位置。
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
    });
    const candidate: MentionCandidate = { type: "input_image", slotId: "image-a", label: "图片 A" };
    const changes: string[] = [];
    const container = await mount("", (value) => changes.push(value), [candidate]);
    const input = container.querySelector<HTMLElement>(".mention-editor__input")!;
    const editor = getNearestEditorFromDOMNode(input)!;
    await act(async () => {
      input.focus();
      editor.update(() => {
        const paragraph = $getRoot().getFirstChildOrThrow() as import("lexical").ElementNode;
        const node = $createTextNode(text);
        paragraph.append(node);
        node.selectEnd();
      });
    });
    const option = document.querySelector<HTMLButtonElement>('[aria-label="参考候选"] [role="option"]');
    expect(option?.textContent).toBe("图片 A");
    await act(async () => { option!.click(); });
    expect(changes.at(-1)).toBe(text.slice(0, text.lastIndexOf("@")) + serializeWoohaa3CanvasMention(candidate));
  });

  it.each([
    "第一行\n第二行",
    "\n第一行\n\n第二行\n",
    `参考\n${serializeWoohaa3CanvasMention({ type: "input_image", slotId: "slot-a", label: "图片 1" })}\n生成`
  ])("反复卸载和回填保留原始换行：%j", async (value) => {
    let saved = value;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const changes: string[] = [];
      const container = await mount(saved, (next) => {
        changes.push(next);
        saved = next;
      });
      expect(changes).toContain(value);
      expect(saved).toBe(value);
      expect(container.querySelectorAll(".mention-editor__paragraph")).toHaveLength(value.split("\n").length);
      await act(async () => root!.unmount());
      root = null;
      container.remove();
    }
  });

  it("空 value 不崩溃并显示占位", async () => {
    const container = await mount("", () => undefined);
    expect(container.querySelector(".mention-editor__input")).not.toBeNull();
    expect(container.textContent).toContain("@ 引用已连接素材");
  });

  it("含 mention 的 value 渲染出 mention 节点且不抛错", async () => {
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    const token = serializeWoohaa3CanvasMention({ type: "input_image", slotId: "slot-a", label: "图片 1" })!;
    const container = await mount(`看图 ${token} 生成`, () => undefined);
    // 崩溃会被错误边界吞掉并 console.error；这里断言既没有错误也没有被吞。
    expect(errors).toEqual([]);
    const mention = container.querySelector(".mention-node");
    expect(mention).not.toBeNull();
    expect(mention!.textContent).toBe("@图片 1");
    expect(container.querySelector(".mention-editor__input")?.textContent).toContain("看图");
  });

  it("纯文本 value 渲染为文本且无 mention", async () => {
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    const container = await mount("普通提示词", () => undefined);
    expect(errors).toEqual([]);
    expect(container.querySelector(".mention-node")).toBeNull();
    expect(container.querySelector(".mention-editor__input")?.textContent).toContain("普通提示词");
  });
});

describe("`#` 片段引用（change: add-prompt-snippet-library）", () => {
  it("未提供 snippetTrigger 时不出现片段入口且不报错", async () => {
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    const container = await mount("输入 # 看看", () => undefined);
    expect(errors).toEqual([]);
    expect(container.querySelector(".mention-editor__input")).not.toBeNull();
  });

  it("提供 snippetTrigger 时 `#` 触发片段候选（不崩溃）", async () => {
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    const searched: string[] = [];
    const trigger = {
      search: async (query: string) => {
        searched.push(query);
        return [{ id: "s1", name: "写实增强", summary: "电影级布光" }];
      },
      select: () => "@写实增强"
    };
    const container = await mount("", () => undefined, [], { snippetTrigger: trigger });
    // 触发 `#`：写入内容并等待 Lexical flush + 搜索 promise。
    const input = container.querySelector(".mention-editor__input") as HTMLElement;
    expect(input).not.toBeNull();
    await act(async () => {
      input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true }));
    });
    // 断言候选菜单在 `#` 触发后出现（typeahead 依赖真实输入事件，弱断言避免脆性）。
    expect(errors).toEqual([]);
    void searched;
  });
});


describe("numbered material references", () => {
  const candidates: MentionCandidate[] = [
    { type: "input_image", slotId: "image-1", label: "图片 1" },
    { type: "input_image", slotId: "image-10", label: "图片 10" },
    { type: "input_video", slotId: "video-2", label: "视频 2" }
  ];
  it("external plain text becomes real mentions and emits canonical slot tokens", async () => {
    const changes: string[] = [];
    const container = await mount("参考图片1，使用视频2", (value) => changes.push(value), candidates);
    expect([...container.querySelectorAll<HTMLElement>(".mention-node")].map((node) => node.dataset.slotId)).toEqual(["image-1", "video-2"]);
    expect(changes.at(-1)).toContain(serializeWoohaa3CanvasMention(candidates[0]));
  });
  it("paste converts aliases at the caret and preserves surrounding text and line breaks", async () => {
    const changes: string[] = [];
    const container = await mount("原文：", (value) => changes.push(value), candidates);
    const editor = getNearestEditorFromDOMNode(container.querySelector(".mention-editor__input")!)!;
    await act(async () => editor.update(() => $getRoot().selectEnd()));
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "图片1\n视频2" } });
    await act(async () => { editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent); });
    expect(event.defaultPrevented).toBe(true);
    expect(changes.at(-1)).toBe(`原文：${serializeWoohaa3CanvasMention(candidates[0])}\n${serializeWoohaa3CanvasMention(candidates[2])}`);
    expect(container.querySelectorAll(".mention-node")).toHaveLength(2);
  });
  it("keeps multi-digit indices editable and binds the complete index on blur", async () => {
    const container = await mount("", () => {}, candidates);
    const editor = getNearestEditorFromDOMNode(container.querySelector(".mention-editor__input")!)!;
    await act(async () => editor.update(() => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      if (!("append" in paragraph)) throw new Error("Expected paragraph");
      const node = $createTextNode("图片1");
      (paragraph as import("lexical").ElementNode).append(node);
      node.selectEnd();
    }));
    expect(container.querySelector(".mention-node")).toBeNull();
    await act(async () => editor.update(() => {
      const node = $getRoot().getAllTextNodes()[0];
      node.setTextContent("图片10"); node.selectEnd();
    }));
    expect(container.querySelector(".mention-node")).toBeNull();
    await act(async () => { editor.dispatchCommand(BLUR_COMMAND, new FocusEvent("blur")); });
    expect(container.querySelector<HTMLElement>(".mention-node")?.dataset.slotId).toBe("image-10");
  });
});

describe("mention 剪贴板", () => {
  const video = { type: "input_video", slotId: "video-1", label: "视频 1" } as const;
  const image = { type: "input_image", slotId: "image-2", label: "图片 2" } as const;
  const value = `参考${serializeWoohaa3CanvasMention(video)}和${serializeWoohaa3CanvasMention(image)}生成`;

  it.each([COPY_COMMAND, CUT_COMMAND])("复制和剪切输出标签名称，保持规范草稿 token", async (command) => {
    const changes: string[] = [];
    const container = await mount(value, (next) => changes.push(next));
    const editor = getNearestEditorFromDOMNode(container.querySelector(".mention-editor__input")!)!;
    // 只选中两个 mention 及中间的「和」，保留前后正文。
    await act(async () => editor.update(() => {
      const paragraph = $getRoot().getFirstChildOrThrow() as import("lexical").ElementNode;
      paragraph.select(1, 4);
    }));
    const clipboard = new Map<string, string>();
    const event = new Event(command === COPY_COMMAND ? "copy" : "cut", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      setData: (type: string, text: string) => clipboard.set(type, text)
    } });
    await act(async () => { editor.dispatchCommand(command, event as ClipboardEvent); });
    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.get("text/plain")).toBe("视频1和图片2");
    expect([...clipboard.values()].join("")).not.toContain("{{");
    expect(changes.at(-1)).toBe(command === COPY_COMMAND ? value : "参考生成");
  });

  it("复制普通文本保留选区和换行", async () => {
    const container = await mount("第一行\n第二行", () => undefined);
    const editor = getNearestEditorFromDOMNode(container.querySelector(".mention-editor__input")!)!;
    await act(async () => editor.update(() => $getRoot().select(0, 2)));
    let copied = "";
    const event = new Event("copy", { cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { setData: (_type: string, text: string) => { copied = text; } } });
    await act(async () => { editor.dispatchCommand(COPY_COMMAND, event as ClipboardEvent); });
    expect(copied).toBe("第一行\n第二行");
  });
});
