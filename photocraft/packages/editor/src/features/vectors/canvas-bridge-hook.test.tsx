/** @vitest-environment jsdom */
/**
 * 画布桥的**接线**回归（U08–U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
 *
 * `canvas-bridge.test.ts` 固定的是归约器语义（纯函数 + 真实内核）。这里补的是它上面那一层：
 * 桥是否真的把面板的目标/只读门禁/命令提交/几何重读串起来 —— 接线缺失时这些都会静默失效
 * （只读仍然写、面板选了 P 却改 work、提交后命中用旧坐标）。
 *
 * 内核仍是真实 `dist/wasm`；控制器只做端口转发，不含任何几何。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EditorWorkspaceController } from "../../editor-workspace.js";
import type { EditorViewModel } from "../../editor-view-model.js";
import { useVectorGesture, type VectorCanvasBridge } from "./canvas-bridge.js";
import { setPathChoice } from "./path-selection.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wasmDir = join(import.meta.dirname, "../../../dist/wasm");
type RawEditor = {
  execute(id: string, params: string): string;
  vectorCommand(id: string, params: string): string;
  free?(): void;
};

let editor: RawEditor;
let root: Root | null = null;

beforeAll(async () => {
  const module = await import(join(wasmDir, "photocraft_editor.js"));
  module.initSync({ module: readFileSync(join(wasmDir, "photocraft_editor_bg.wasm")) });
  editor = new module.WasmEditor();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  setPathChoice("work");
});

/** 每次用例一份新文档，避免锚点计数相互污染。 */
function resetDocument() {
  editor.execute("file.new", JSON.stringify({ width: 400, height: 300, background: "white" }));
}

const ok = <T,>(value: T) => ({ ok: true as const, value });

/** 只转发端口的控制器替身：几何与命令合法性全部来自真实内核。 */
function controller(onCommand?: (id: string, params: Record<string, unknown>) => void) {
  const drafts: boolean[] = [];
  return {
    // 草稿登记：桥在拖绘/铅笔未完成时登记，保存与切标签据此拒绝。
    setVectorDraft: (active: boolean) => { drafts.push(active); },
    drafts: () => drafts,
    token: () => ({ generation: 0, session: 0 }),
    editor: () => ({
      execute: (id: string, params: unknown) => {
        try {
          return ok(JSON.parse(editor.execute(id, JSON.stringify(params ?? null))));
        } catch (error) {
          return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
        }
      },
    }),
    vectorCommand: (id: string, params: Record<string, unknown>) => {
      onCommand?.(id, params);
      try {
        return ok(JSON.parse(editor.vectorCommand(id, JSON.stringify(params))));
      } catch (error) {
        const raw = error as { message?: string };
        const text = typeof raw?.message === "string" ? raw.message : String(error);
        return { ok: false as const, message: text };
      }
    },
  } as unknown as EditorWorkspaceController;
}

/** 把 hook 装进一棵最小树里，暴露最新的桥与消息。 */
function mount(
  view: { layers?: unknown[]; revision?: number } = {},
  overrides: { readonly?: boolean; penTarget?: "work" | "shape" | "mask"; layer?: number | null; tool?: string } = {},
) {
  const tool = overrides.tool ?? "shape-rect";
  const messages: (string | null)[] = [];
  const commands: { id: string; params: Record<string, unknown> }[] = [];
  const port = controller((id, params) => commands.push({ id, params }));
  let bridge: VectorCanvasBridge | null = null;
  const documentView = {
    layers: view.layers ?? [],
    revision: view.revision ?? 0,
  } as unknown as EditorViewModel["document"];

  function Probe() {
    bridge = useVectorGesture(port, documentView, tool, {
      fill: "#3366cc",
      penTarget: overrides.penTarget ?? "work",
      layer: overrides.layer === undefined ? null : overrides.layer,
      canvas: [400, 300],
      zoom: 1,
      readonly: overrides.readonly ?? false,
      onMessage: message => messages.push(message),
    });
    return null;
  }

  const container = document.createElement("div");
  document.body.append(container);
  // 同一用例里挂第二次时先卸载上一棵树：两个 root 同时渲染会让第二次的 effect 被推迟，
  // 断言拿到的就是首次的桥（测试自身问题，不是产品行为）。
  if (root) act(() => root!.unmount());
  root = createRoot(container);
  act(() => root!.render(<Probe />));
  // 用 getter 而不是快照：`bridge` 在渲染中赋值，快照会漏掉后续渲染换上的新桥。
  return {
    get bridge(): VectorCanvasBridge { return bridge!; },
    messages,
    commands,
    rerender: () => act(() => root!.render(<Probe />)),
  };
}

describe("画布桥接线", () => {
  it("拖绘松手只提交一条 shape.create，拖动期间零命令", () => {
    resetDocument();
    const { bridge, commands } = mount();
    act(() => bridge.pointer({ type: "down", point: [10, 10] }));
    act(() => bridge.pointer({ type: "move", point: [80, 60] }));
    expect(commands).toEqual([]);
    act(() => bridge.pointer({ type: "up", point: [80, 60] }));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ id: "shape.create", params: { kind: "rect", rect: [10, 10, 70, 50] } });
    // 提交后叠加层清空：不能留下一个「已画完还在画」的预览。
    expect(bridge.overlay({ x: 0, y: 0 }, 1)).toBeNull();
    expect(bridge.active()).toBe(false);
  });

  it("只读时不写文档，但叠加层与提示仍然工作", () => {
    resetDocument();
    const { bridge, commands, messages } = mount({}, { readonly: true });
    act(() => bridge.pointer({ type: "down", point: [10, 10] }));
    act(() => bridge.pointer({ type: "move", point: [50, 40] }));
    // 拖动预览渲染（只读也能看见自己在画什么）。
    expect(bridge.overlay({ x: 0, y: 0 }, 1)).not.toBeNull();
    act(() => bridge.pointer({ type: "up", point: [50, 40] }));
    expect(commands).toEqual([]);
    expect(messages.at(-1)).toMatch(/只读/);
  });

  it("路径编辑默认改图层自身路径", () => {
    resetDocument();
    // 造一个形状层，活动图层 id 取内核给的。
    const created = JSON.parse(editor.vectorCommand("shape.create", JSON.stringify({ kind: "rect", rect: [10, 10, 60, 40], fill: "#3366cc" }))) as { layer: number };
    const layers = [{ id: created.layer, kind: "shape" }];
    setPathChoice("work");

    // 面板保持「工作路径」，但活动图层自身有路径：直接选择改的就是该图层，不是空白工作路径。
    const onLayer = mount({ layers }, { layer: created.layer, tool: "direct-select" });
    expect(onLayer.bridge.path?.subpaths[0]?.knots).toHaveLength(4);
    expect(onLayer.bridge.path?.subpaths[0]?.knots[0]?.anchor).toEqual([10, 10]);
  });

  it("未结算的拖绘登记为草稿，松手后解除", () => {
    resetDocument();
    const messages: (string | null)[] = [];
    const drafts: boolean[] = [];
    const port = {
      setVectorDraft: (active: boolean) => { drafts.push(active); },
      token: () => ({ generation: 0, session: 0 }),
      editor: () => ({
        execute: (id: string, params: unknown) => {
          try { return ok(JSON.parse(editor.execute(id, JSON.stringify(params ?? null)))); }
          catch (error) { return { ok: false as const, message: String((error as { message?: string }).message ?? error) }; }
        },
      }),
      vectorCommand: (id: string, params: Record<string, unknown>) => {
        try { return ok(JSON.parse(editor.vectorCommand(id, JSON.stringify(params)))); }
        catch (error) { return { ok: false as const, message: String((error as { message?: string }).message ?? error) }; }
      },
    } as unknown as EditorWorkspaceController;
    let bridge: VectorCanvasBridge | null = null;
    function Probe() {
      bridge = useVectorGesture(port, { layers: [], revision: 0 } as unknown as EditorViewModel["document"], "shape-rect", {
        readonly: false, fill: "#3366cc", penTarget: "work", layer: null, canvas: [400, 300], zoom: 1,
        onMessage: message => messages.push(message),
      });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    if (root) act(() => root!.unmount());
    root = createRoot(container);
    act(() => root!.render(<Probe />));
    // 起始是「没有草稿」：单纯选中工具不算未结算。
    expect(drafts).toEqual([false]);
    act(() => bridge!.pointer({ type: "down", point: [10, 10] }));
    act(() => bridge!.pointer({ type: "move", point: [80, 60] }));
    // 拖动中必须让保存/切标签看见草稿。
    expect(drafts.at(-1)).toBe(true);
    act(() => bridge!.pointer({ type: "up", point: [80, 60] }));
    // 松手提交后草稿结算，门禁解除。
    expect(drafts.at(-1)).toBe(false);
    // 卸载时也要清除登记，避免残留的 vector-active 卡住后续文档。
    act(() => root!.unmount());
    root = null;
    expect(drafts.at(-1)).toBe(false);
  });

  it("面板选了命名路径就改命名路径，不被图层覆盖", () => {
    resetDocument();
    const created = JSON.parse(editor.vectorCommand("shape.create", JSON.stringify({ kind: "rect", rect: [10, 10, 60, 40], fill: "#3366cc" }))) as { layer: number };
    const layers = [{ id: created.layer, kind: "shape" }];
    editor.vectorCommand("path.set", JSON.stringify({ name: "P", path: { subpaths: [{ closed: false, knots: [[200, 200], [260, 200]] }] } }));
    setPathChoice("P");

    const onNamed = mount({ layers }, { layer: created.layer, tool: "direct-select" });
    expect(onNamed.bridge.path?.subpaths[0]?.knots).toHaveLength(2);
    expect(onNamed.bridge.path?.subpaths[0]?.knots[0]?.anchor).toEqual([200, 200]);
  });
});
