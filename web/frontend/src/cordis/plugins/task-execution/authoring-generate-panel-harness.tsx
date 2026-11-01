/**
 * `authoring-generate-panel.test.tsx` 的共享夹具（从该文件原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：那个测试文件曾越过 800 物理行上限，而夹具与 DOM 生命周期占
 * 了前一百多行。用例分到两个文件后共用这一份，不会各写一套 render/input/select。
 *
 * 生产代码不引用本文件。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import type {
  AgentConversationService,
  AgentConversationSnapshotView,
} from "../../contract/agent-conversation.js";
import { AuthoringGeneratePanel } from "./authoring-generate-panel.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// `root` / `el` 由下面的生命周期钩子重新赋值；ESM 的实时绑定让引用方读到的始终是当前值。
export let root: Root;
export let el: HTMLDivElement;

beforeEach(() => {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});

afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  localStorage.clear();
});

export const ok = <T,>(value: T) => ({ ok: true as const, value });

export function fixture(overrides: Partial<AgentConversationService> = {}) {
  const snapshot: AgentConversationSnapshotView = {
    active: null,
    conversations: [],
    detail: null,
    loading: false,
    error: null,
    mcp: null,
    contextRevision: 0,
  };
  const service = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    catalog: vi.fn(async () => ok({ models: [] })),
    readConversation: vi.fn(async () => ({
      ok: false as const,
      code: "not-found",
      error: "no history",
    })),
    submitTurn: vi.fn(async (input) =>
      ok({ conversationId: "conversation", requestId: input.requestId }),
    ),
    ...overrides,
  } as unknown as AgentConversationService;
  const props: AuthoringGenerationProps = {
    canvasId: "canvas",
    nodeId: "model",
    mode: "model3d",
    writable: true,
    sourceSelection: {
      sources: [
        { sourceId: "sdk", label: "API" },
        { sourceId: "local", label: "本机" },
      ],
      selectedSourceId: "sdk",
      selectedConnectionId: "c1",
      connections: [
        {
          connectionId: "c1",
          label: "我的连接",
          ready: true,
          models: [{ id: "model-a", label: "模型 A" }],
        },
      ],
      onSelectSource: vi.fn(),
      onSelectConnection: vi.fn(),
    },
    agentConversation: { service, onOpenDetail: vi.fn() },
  };
  return { props, service, snapshot };
}

export async function render(props: AuthoringGenerationProps) {
  await act(async () => root.render(<AuthoringGeneratePanel {...props} />));
}

export async function input(selector: string, value: string) {
  const field = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  )!;
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function select(label: string, text: string) {
  await act(async () => {
    const trigger = el.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    )!;
    if (trigger.getAttribute("aria-expanded") !== "true") {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    }
  });
  // 模型与 Variant 在同一个参数面板里横向排开（不再逐项单行下拉）。
  const option = [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".assistant-model-panel__option",
    ),
  ].find((option) => option.getAttribute("aria-label") === text);
  expect(option, document.body.textContent ?? "").toBeDefined();
  await act(async () => {
    option!.click();
  });
  // Radix restores trigger focus on the next task after closing a popup.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export const generate = () =>
  [...el.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "生成",
  )!;
